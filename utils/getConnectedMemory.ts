import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

/**
 * n8n LangChain Memory interface (subset).
 */
export interface N8nMemory {
  chatHistory: {
    getMessages(): Promise<unknown[]>;
    addMessage(message: unknown): Promise<void>;
    addUserMessage(content: string): Promise<void>;
    addAIChatMessage?(content: string): Promise<void>;
  };
}

/**
 * Get the connected memory sub-node, if any.
 */
export async function getConnectedMemory(
  ctx: IExecuteFunctions,
  itemIndex = 0,
): Promise<N8nMemory | null> {
  try {
    const memory = await ctx.getInputConnectionData(NodeConnectionTypes.AiMemory, itemIndex);
    if (!memory) return null;
    return memory as N8nMemory;
  } catch {
    return null;
  }
}
