import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import type { ToolSet } from 'ai';
import { tool, jsonSchema } from 'ai';
import { z } from 'zod';

interface N8nTool {
  name: string;
  description: string;
  schema?: unknown;
  invoke: (params: unknown) => Promise<unknown>;
}

/**
 * Convert a JSON Schema or Zod schema from an n8n tool to a format the AI SDK accepts.
 */
function convertToolSchema(schema: unknown): z.ZodTypeAny | ReturnType<typeof jsonSchema> {
  if (!schema) {
    return z.record(z.unknown());
  }

  // If it's a Zod schema, use directly
  if (schema instanceof z.ZodType) {
    // Unwrap ZodEffects wrappers
    let unwrapped = schema;
    while (unwrapped instanceof z.ZodEffects) {
      unwrapped = (unwrapped as z.ZodEffects<z.ZodTypeAny>)._def.schema;
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
  itemIndex = 0,
): Promise<ToolSet> {
  let rawTools: unknown;
  try {
    rawTools = await ctx.getInputConnectionData(NodeConnectionTypes.AiTool, itemIndex);
  } catch {
    return {};
  }

  if (!rawTools) return {};

  // Flatten to array
  const toolList: N8nTool[] = [];
  const items = Array.isArray(rawTools) ? rawTools : [rawTools];

  for (const item of items) {
    if (Array.isArray(item)) {
      // MCP toolkit or nested arrays
      toolList.push(...(item as N8nTool[]));
    } else if (item && typeof item === 'object' && 'name' in item) {
      toolList.push(item as N8nTool);
    }
  }

  const aiTools: ToolSet = {};

  for (const n8nTool of toolList) {
    const parameters = convertToolSchema(n8nTool.schema);
    aiTools[n8nTool.name] = tool({
      description: n8nTool.description,
      parameters,
      execute: async (args: Record<string, unknown>) => {
        const result = await n8nTool.invoke(args);
        if (typeof result === 'string') return result;
        return JSON.stringify(result);
      },
    });
  }

  return aiTools;
}
