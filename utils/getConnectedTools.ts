import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

type ToolInvoker = (params: unknown) => unknown;

export interface N8nTool {
  name: string;
  description?: string;
  schema?: unknown;
  invoke?: ToolInvoker;
  func?: ToolInvoker;
  call?: ToolInvoker;
}

function isToolkit(value: unknown): value is { getTools: () => unknown[] } {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { getTools?: unknown }).getTools === 'function'
  );
}

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

  const maybeTools = (value as { tools?: unknown }).tools;
  if (Array.isArray(maybeTools) && !isN8nTool(value)) {
    flattenTools(maybeTools, out);
    return;
  }

  if (isN8nTool(value)) {
    out.push(value);
  }
}

/**
 * Get connected n8n/LangChain tool sub-nodes.
 *
 * Keep tool instances intact for parity with n8n's built-in AI Agent. Toolkits
 * such as the MCP Client Tool are expanded to their contained tools, but the
 * tools themselves are not converted to another SDK representation.
 */
export async function getConnectedTools(
  ctx: IExecuteFunctions,
  _itemIndex = 0,
): Promise<N8nTool[]> {
  const rawTools = await ctx.getInputConnectionData(NodeConnectionTypes.AiTool, 0);

  if (!rawTools) return [];

  const toolList: N8nTool[] = [];
  flattenTools(rawTools, toolList);

  if (toolList.length === 0) {
    if (Array.isArray(rawTools) && rawTools.length === 0) return [];
    throw new Error('Connected AI tool data did not contain any compatible tools');
  }

  return toolList;
}
