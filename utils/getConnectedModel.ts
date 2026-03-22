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
 * Recursively search for an API key in the model object.
 */
function deepSearchApiKey(obj: unknown, depth = 0): string | null {
  if (depth > 3 || !obj || typeof obj !== 'object') return null;
  const record = obj as Record<string, unknown>;

  // Check common key names
  const keyNames = [
    'apiKey', 'openAIApiKey', 'anthropicApiKey', 'googleApiKey',
    'api_key', 'key', 'accessToken',
  ];
  for (const name of keyNames) {
    const val = record[name];
    if (typeof val === 'string' && val.length > 8) return val;
  }

  // Search nested objects
  const nestedKeys = [
    'clientConfig', 'client', 'configuration', 'config',
    'credentials', 'params', 'kwargs', 'lc_kwargs',
  ];
  for (const name of nestedKeys) {
    const nested = record[name];
    if (nested && typeof nested === 'object') {
      const found = deepSearchApiKey(nested, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Extract API key from a LangChain model object.
 */
function extractApiKey(model: Record<string, unknown>): string {
  const key = deepSearchApiKey(model);
  if (key) return key;

  // Log available keys for debugging
  const allKeys = Object.keys(model);
  console.error(
    '[SlackAiStreamingAgent] Could not find API key. Model object keys:',
    allKeys.join(', '),
  );
  console.error(
    '[SlackAiStreamingAgent] Constructor:',
    model.constructor?.name ?? 'unknown',
  );

  throw new Error(
    `Could not extract API key from connected model node. ` +
    `Model constructor: ${model.constructor?.name ?? 'unknown'}, ` +
    `Available keys: ${allKeys.slice(0, 15).join(', ')}`,
  );
}

/**
 * Extract model name from a LangChain model object.
 */
function extractModelName(model: Record<string, unknown>): string {
  const candidates = [
    model['modelName'],
    model['model'],
    model['modelId'],
    (model['kwargs'] as Record<string, unknown>)?.['modelName'],
    (model['kwargs'] as Record<string, unknown>)?.['model'],
    (model['lc_kwargs'] as Record<string, unknown>)?.['modelName'],
    (model['lc_kwargs'] as Record<string, unknown>)?.['model'],
  ];
  for (const name of candidates) {
    if (typeof name === 'string' && name.length > 0) return name;
  }
  console.warn('[SlackAiStreamingAgent] Could not detect model name, defaulting to gpt-4o');
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

  console.log(
    `[SlackAiStreamingAgent] Model conversion: constructor=${constructorName}, ` +
    `model=${modelName}, apiKey=${apiKey.slice(0, 8)}..., baseURL=${baseURL ?? 'default'}`,
  );

  // Detect provider
  if (
    constructorName.includes('anthropic') ||
    apiKey.startsWith('sk-ant-')
  ) {
    console.log('[SlackAiStreamingAgent] Using Anthropic provider');
    const provider = createAnthropic({ apiKey });
    return provider(modelName);
  }

  if (
    constructorName.includes('google') ||
    constructorName.includes('gemini')
  ) {
    console.log('[SlackAiStreamingAgent] Using Google provider');
    const provider = createGoogleGenerativeAI({ apiKey });
    return provider(modelName);
  }

  // Default: OpenAI-compatible (including OpenRouter)
  console.log('[SlackAiStreamingAgent] Using OpenAI provider');
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

  console.log(
    '[SlackAiStreamingAgent] Raw model type:',
    (model as Record<string, unknown>).constructor?.name,
  );

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
