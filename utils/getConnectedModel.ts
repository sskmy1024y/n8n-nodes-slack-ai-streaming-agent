import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import type { LanguageModelV1 } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

/**
 * Recursively search for a string value by key names in a nested object.
 */
function deepSearch(
  obj: unknown,
  keyNames: string[],
  depth = 0,
  maxDepth = 4,
): string | null {
  if (depth > maxDepth || !obj || typeof obj !== 'object') return null;
  const record = obj as Record<string, unknown>;

  for (const name of keyNames) {
    const val = record[name];
    if (typeof val === 'string' && val.length > 0) return val;
  }

  // Search all nested objects (not just known keys)
  for (const [key, val] of Object.entries(record)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const found = deepSearch(val, keyNames, depth + 1, maxDepth);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Dump object structure for debugging (keys + types, no values for security).
 */
function dumpStructure(obj: unknown, depth = 0, maxDepth = 2): string {
  if (depth > maxDepth || !obj || typeof obj !== 'object') return typeof obj;
  const record = obj as Record<string, unknown>;
  const entries = Object.entries(record).map(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return `${k}: {${dumpStructure(v, depth + 1, maxDepth)}}`;
    }
    if (typeof v === 'string') {
      return `${k}: "${v.slice(0, 20)}${v.length > 20 ? '...' : ''}"`;
    }
    return `${k}: ${typeof v}`;
  });
  return entries.join(', ');
}

/**
 * Extract API key from a LangChain model object.
 */
function extractApiKey(model: Record<string, unknown>): string {
  const key = deepSearch(model, [
    'apiKey', 'openAIApiKey', 'anthropicApiKey', 'googleApiKey',
    'api_key', 'key', 'accessToken',
  ]);
  if (key) return key;

  console.error('[SlackAiStreamingAgent] Model structure:', dumpStructure(model));
  throw new Error(
    `Could not extract API key from connected model node. ` +
    `Constructor: ${model.constructor?.name ?? 'unknown'}`,
  );
}

/**
 * Extract model name from a LangChain model object.
 */
function extractModelName(model: Record<string, unknown>): string {
  const name = deepSearch(model, ['modelName', 'model', 'modelId']);
  if (name) return name;
  console.warn('[SlackAiStreamingAgent] Could not detect model name, defaulting to gpt-4o');
  return 'gpt-4o';
}

/**
 * Extract base URL from a LangChain model object.
 */
function extractBaseURL(model: Record<string, unknown>): string | undefined {
  const url = deepSearch(model, [
    'baseURL', 'basePath', 'base_url', 'baseUrl',
    'apiBase', 'api_base',
  ]);
  // Ignore default OpenAI URLs
  if (url && !url.includes('api.openai.com')) return url;
  // Still return if explicitly set even to OpenAI
  if (url) return url;
  return undefined;
}

/**
 * Detect the provider from constructor name, model name, API key, and base URL.
 */
function detectProvider(
  constructorName: string,
  modelName: string,
  apiKey: string,
  baseURL?: string,
): 'anthropic' | 'google' | 'openai-compatible' {
  const modelLower = modelName.toLowerCase();

  // Anthropic detection
  if (
    constructorName.includes('anthropic') ||
    apiKey.startsWith('sk-ant-') ||
    modelLower.includes('claude')
  ) {
    // If there's a custom baseURL, it might be a proxy using OpenAI-compatible format
    if (baseURL && !baseURL.includes('anthropic')) {
      return 'openai-compatible';
    }
    return 'anthropic';
  }

  // Google detection
  if (
    constructorName.includes('google') ||
    constructorName.includes('gemini') ||
    modelLower.includes('gemini')
  ) {
    return 'google';
  }

  return 'openai-compatible';
}

/**
 * Convert an n8n LangChain model sub-node to a Vercel AI SDK LanguageModelV1.
 */
function convertN8nModelToAiSdk(langchainModel: unknown): LanguageModelV1 {
  const model = langchainModel as Record<string, unknown>;
  const constructorName = (model.constructor?.name ?? '').toLowerCase();

  // Extract all settings from the model object
  const apiKey = extractApiKey(model);
  const modelName = extractModelName(model);
  const baseURL = extractBaseURL(model);

  console.log(
    `[SlackAiStreamingAgent] Model conversion: constructor=${constructorName}, ` +
    `model=${modelName}, apiKey=${apiKey.slice(0, 8)}..., baseURL=${baseURL ?? 'none'}`,
  );

  const provider = detectProvider(constructorName, modelName, apiKey, baseURL);
  console.log(`[SlackAiStreamingAgent] Detected provider: ${provider}`);

  switch (provider) {
    case 'anthropic': {
      const p = createAnthropic({
        apiKey,
        ...(baseURL ? { baseURL } : {}),
      });
      return p(modelName);
    }
    case 'google': {
      const p = createGoogleGenerativeAI({
        apiKey,
        ...(baseURL ? { baseURL } : {}),
      });
      return p(modelName);
    }
    case 'openai-compatible':
    default: {
      const p = createOpenAI({
        apiKey,
        ...(baseURL ? { baseURL } : {}),
      });
      return p(modelName);
    }
  }
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

  const record = model as Record<string, unknown>;
  console.log(
    '[SlackAiStreamingAgent] Raw model type:',
    record.constructor?.name,
  );
  console.log(
    '[SlackAiStreamingAgent] Model structure:',
    dumpStructure(record),
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
  const temp = deepSearch(model, ['temperature']);
  const topP = deepSearch(model, ['topP', 'top_p']);
  const maxTokens = deepSearch(model, ['maxTokens', 'maxOutputTokens', 'max_tokens']);
  return {
    temperature: temp ? Number(temp) : undefined,
    topP: topP ? Number(topP) : undefined,
    maxTokens: maxTokens ? Number(maxTokens) : undefined,
  };
}
