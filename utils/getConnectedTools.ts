import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import type { ToolSet } from 'ai';
import { tool, jsonSchema } from 'ai';
import { z } from 'zod';

type ToolInvoker = (params: unknown) => unknown;

interface N8nTool {
  name: string;
  description: string;
  schema?: unknown;
  // n8n/LangChain tools expose at least one of these callables. `invoke` is the
  // canonical one (Runnable), but DynamicTool-style wrappers may only have
  // `func`/`call`. isN8nTool admits any of them, so resolve at execution time.
  invoke?: ToolInvoker;
  func?: ToolInvoker;
  call?: ToolInvoker;
}

/** Pick whichever execution method an n8n tool actually exposes. */
function resolveInvoker(tool: N8nTool): ToolInvoker {
  const invoker = tool.invoke ?? tool.call ?? tool.func;
  if (!invoker) {
    throw new Error(`Connected tool "${tool.name}" has no invoke/call/func method`);
  }
  return invoker.bind(tool);
}

/**
 * Duck-typed check for a LangChain Toolkit (e.g. the StructuredToolkit that the
 * MCP Client Tool node supplies). n8n bundles its own copy of @langchain/core,
 * so we cannot rely on `instanceof` — match on the shape instead.
 */
function isToolkit(value: unknown): value is { getTools: () => unknown[] } {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { getTools?: unknown }).getTools === 'function'
  );
}

/** Duck-typed check for an n8n/LangChain tool (DynamicStructuredTool, N8nTool, ...). */
function isN8nTool(value: unknown): value is N8nTool {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { name?: unknown }).name === 'string' &&
    (typeof (value as { invoke?: unknown }).invoke === 'function' ||
      typeof (value as { func?: unknown }).func === 'function' ||
      typeof (value as { call?: unknown }).call === 'function')
  );
}

/**
 * Recursively flatten whatever `getInputConnectionData(AiTool)` returns into a
 * flat list of tool objects. The connection data can contain plain tools,
 * nested arrays, and Toolkit instances (the MCP Client Tool bundles its tools in
 * a StructuredToolkit). Toolkits and arrays are expanded; tools are collected.
 */
function flattenTools(value: unknown, out: N8nTool[]): void {
  if (!value) return;

  if (Array.isArray(value)) {
    for (const item of value) flattenTools(item, out);
    return;
  }

  if (isToolkit(value)) {
    flattenTools(value.getTools(), out);
    return;
  }

  // Some toolkits expose `.tools` directly without a callable getTools().
  const maybeTools = (value as { tools?: unknown }).tools;
  if (Array.isArray(maybeTools) && !isN8nTool(value)) {
    flattenTools(maybeTools, out);
    return;
  }

  if (isN8nTool(value)) {
    out.push(value);
  }
}

/** Duck-typed check for a Zod schema, tolerant of differing zod instances. */
function isZodSchema(schema: unknown): schema is z.ZodTypeAny {
  return (
    !!schema &&
    typeof schema === 'object' &&
    '_def' in schema &&
    typeof (schema as { parse?: unknown }).parse === 'function'
  );
}

/**
 * Convert a JSON Schema or Zod schema from an n8n tool to a format the AI SDK accepts.
 */
function convertToolSchema(schema: unknown): z.ZodTypeAny | ReturnType<typeof jsonSchema> {
  if (!schema) {
    return z.record(z.unknown());
  }

  // If it's a Zod schema (possibly from n8n's bundled zod), use it directly.
  if (isZodSchema(schema)) {
    // Unwrap ZodEffects wrappers without relying on instanceof.
    let unwrapped = schema;
    while ((unwrapped as { _def?: { typeName?: string } })._def?.typeName === 'ZodEffects') {
      unwrapped = (unwrapped as unknown as { _def: { schema: z.ZodTypeAny } })._def.schema;
    }
    return unwrapped;
  }

  // If it's a JSON schema object
  if (typeof schema === 'object' && schema !== null) {
    const schemaObj = schema as Record<string, unknown>;
    if (schemaObj['type'] || schemaObj['properties'] || schemaObj['$schema']) {
      return jsonSchema(schemaObj);
    }
  }

  return z.record(z.unknown());
}

/**
 * Get connected tool sub-nodes and convert them to Vercel AI SDK tools.
 */
export async function getConnectedTools(
  ctx: IExecuteFunctions,
  _itemIndex = 0,
): Promise<ToolSet> {
  let rawTools: unknown;
  try {
    // AI tool sub-nodes supply configuration-level data, not per-main-item data.
    // This mirrors n8n's own AI Agent helper, which always reads tool connections
    // at index 0 so connected tools are available for every processed item.
    rawTools = await ctx.getInputConnectionData(NodeConnectionTypes.AiTool, 0);
  } catch {
    return {};
  }

  if (!rawTools) return {};

  // Flatten tools, Toolkits (e.g. MCP), and nested arrays into a single list.
  const toolList: N8nTool[] = [];
  flattenTools(rawTools, toolList);

  const aiTools: ToolSet = {};

  for (const n8nTool of toolList) {
    const parameters = convertToolSchema(n8nTool.schema);
    const invoke = resolveInvoker(n8nTool);
    aiTools[n8nTool.name] = tool({
      description: n8nTool.description,
      parameters,
      execute: async (args: Record<string, unknown>) => {
        const result = await invoke(args);
        if (typeof result === 'string') return result;
        return JSON.stringify(result);
      },
    });
  }

  return aiTools;
}
