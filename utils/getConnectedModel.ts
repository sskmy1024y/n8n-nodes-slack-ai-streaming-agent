import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

/**
 * Get the connected n8n LangChain chat model.
 *
 * Keep the model instance intact. n8n's built-in AI Agent runs against the
 * connected LangChain model directly, including provider-specific wrappers,
 * credentials, and bindTools support. Recreating an AI SDK model here breaks
 * parity with the AI Agent node.
 */
export async function getConnectedModel(
  ctx: IExecuteFunctions,
  _itemIndex = 0,
): Promise<unknown> {
  const model = await ctx.getInputConnectionData(
    NodeConnectionTypes.AiLanguageModel,
    0,
  );
  if (!model) {
    throw new Error('No AI model connected. Please connect a language model sub-node.');
  }
  return model;
}
