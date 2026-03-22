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

  for (const val of Object.values(record)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const found = deepSearch(val, keyNames, depth + 1, maxDepth);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Extract API key from a LangChain model object.
 */
function extractApiKey(model: Record<string, unknown>): string {
  const key = deepSearch(model, [
    'apiKey', 'openAIApiKey', 'anthropicApiKey', 'googleApiKey',
    'api_key', 'accessToken',
  ]);
  if (key) return key;
  throw new Error(
    `Could not extract API key from model (${model.constructor?.name ?? 'unknown'})`,
  );
}

/**
 * Extract model name from a LangChain model object.
 */
function extractModelName(model: Record<string, unknown>): string {
  const name = deepSearch(model, ['modelName', 'model', 'modelId']);
  return name ?? 'gpt-4o';
}

/**
 * Extract base URL from a LangChain model object.
 */
function extractBaseURL(model: Record<string, unknown>): string | undefined {
  const url = deepSearch(model, [
    'baseURL', 'basePath', 'base_url', 'baseUrl', 'apiBase', 'api_base',
  ]);
  return url ?? undefined;
}

/**
 * Determine provider purely from the n8n node's constructor name.
 * This reflects which node the user connected (OpenAI Chat Model, Anthropic, etc.)
 */
function detectProvider(constructorName: string): 'openai' | 'anthropic' | 'google' {
  const name = constructorName.toLowerCase();
  if (name.includes('anthropic')) return 'anthropic';
  if (name.includes('google') || name.includes('gemini')) return 'google';
  return 'openai'; // ChatOpenAI and any other OpenAI-compatible nodes
}

/**
 * Convert an n8n LangChain model sub-node to a Vercel AI SDK LanguageModelV1.
 * Uses the node type (constructor) to select the provider, and faithfully
 * passes through apiKey, baseURL, and model name from the credential.
 */
function convertN8nModelToAiSdk(langchainModel: unknown): LanguageModelV1 {
  const model = langchainModel as Record<string, unknown>;
  const constructorName = model.constructor?.name ?? '';

  const apiKey = extractApiKey(model);
  const modelName = extractModelName(model);
  const baseURL = extractBaseURL(model);
  const provider = detectProvider(constructorName);

  console.log(
    `[SlackAiStreamingAgent] constructor=${constructorName} → provider=${provider}, ` +
    `model=${modelName}, baseURL=${baseURL ?? '(default)'}`,
  );

  switch (provider) {
    case 'anthropic': {
      const p = createAnthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
      return p(modelName);
    }
    case 'google': {
      const p = createGoogleGenerativeAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
      return p(modelName);
    }
    case 'openai':
    default: {
      const p = createOpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
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
