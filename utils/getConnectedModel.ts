import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import type { LanguageModelV1 } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

/**
 * Read a setting from various possible property paths on the LangChain model object.
 */
function readModelSetting(model: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (model[key] !== undefined) return model[key];
    // Check nested invocationParams or kwargs
    const invParams = model['invocationParams'] as Record<string, unknown> | undefined;
    if (invParams?.[key] !== undefined) return invParams[key];
    const kwargs = model['kwargs'] as Record<string, unknown> | undefined;
    if (kwargs?.[key] !== undefined) return kwargs[key];
  }
  return undefined;
}

/**
 * Extract API key from a LangChain model object.
 */
function extractApiKey(model: Record<string, unknown>): string {
  const candidates = [
    model['apiKey'],
    model['openAIApiKey'],
    model['anthropicApiKey'],
    model['googleApiKey'],
    (model['clientConfig'] as Record<string, unknown>)?.['apiKey'],
    (model['client'] as Record<string, unknown>)?.['apiKey'],
  ];
  for (const key of candidates) {
    if (typeof key === 'string' && key.length > 0) return key;
  }
  throw new Error('Could not extract API key from connected model node');
}

/**
 * Extract model name from a LangChain model object.
 */
function extractModelName(model: Record<string, unknown>): string {
  const candidates = [
    model['modelName'],
    model['model'],
    model['modelId'],
  ];
  for (const name of candidates) {
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return 'gpt-4o';
}

/**
 * Convert an n8n LangChain model sub-node to a Vercel AI SDK LanguageModelV1.
 */
function convertN8nModelToAiSdk(langchainModel: unknown): LanguageModelV1 {
  const model = langchainModel as Record<string, unknown>;
  const constructorName = (model.constructor?.name ?? '').toLowerCase();
  const apiKey = extractApiKey(model);
  const modelName = extractModelName(model);
  const baseURL = (model['configuration'] as Record<string, unknown>)?.['baseURL'] as
    | string
    | undefined;

  // Detect provider
  if (
    constructorName.includes('anthropic') ||
    apiKey.startsWith('sk-ant-')
  ) {
    const provider = createAnthropic({ apiKey });
    return provider(modelName);
  }

  if (
    constructorName.includes('google') ||
    constructorName.includes('gemini')
  ) {
    const provider = createGoogleGenerativeAI({ apiKey });
    return provider(modelName);
  }

  // Default: OpenAI-compatible (including OpenRouter)
  const provider = createOpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });
  return provider(modelName);
}

/**
 * Get the connected AI model sub-node and convert it to Vercel AI SDK format.
 */
export async function getConnectedModel(
  ctx: IExecuteFunctions,
  itemIndex = 0,
): Promise<LanguageModelV1> {
  const model = await ctx.getInputConnectionData(
    NodeConnectionTypes.AiLanguageModel,
    itemIndex,
  );
  if (!model) {
    throw new Error('No AI model connected. Please connect a language model sub-node.');
  }
  return convertN8nModelToAiSdk(model);
}

/**
 * Extract model settings (temperature, etc.) from the LangChain model object.
 */
export function extractModelSettings(langchainModel: unknown): {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
} {
  const model = langchainModel as Record<string, unknown>;
  return {
    temperature: readModelSetting(model, 'temperature') as number | undefined,
    topP: readModelSetting(model, 'topP', 'top_p') as number | undefined,
    maxTokens: readModelSetting(model, 'maxTokens', 'maxOutputTokens', 'max_tokens') as
      | number
      | undefined,
  };
}
