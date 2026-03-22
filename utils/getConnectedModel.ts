import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import type { LanguageModelV1 } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

type ProviderFactory = (opts: { apiKey: string; baseURL?: string }) => (model: string) => LanguageModelV1;

const PROVIDER_FACTORIES: Record<string, ProviderFactory> = {
  anthropic: createAnthropic as ProviderFactory,
  google: createGoogleGenerativeAI as ProviderFactory,
  openai: createOpenAI as ProviderFactory,
};

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

function extractModelName(model: Record<string, unknown>): string {
  return deepSearch(model, ['modelName', 'model', 'modelId']) ?? 'gpt-4o';
}

function extractBaseURL(model: Record<string, unknown>): string | undefined {
  return deepSearch(model, [
    'baseURL', 'basePath', 'base_url', 'baseUrl', 'apiBase', 'api_base',
  ]) ?? undefined;
}

function detectProvider(constructorName: string): string {
  const name = constructorName.toLowerCase();
  if (name.includes('anthropic')) return 'anthropic';
  if (name.includes('google') || name.includes('gemini')) return 'google';
  return 'openai';
}

function convertN8nModelToAiSdk(langchainModel: unknown): LanguageModelV1 {
  const model = langchainModel as Record<string, unknown>;
  const apiKey = extractApiKey(model);
  const modelName = extractModelName(model);
  const baseURL = extractBaseURL(model);
  const provider = detectProvider(model.constructor?.name ?? '');
  const factory = PROVIDER_FACTORIES[provider] ?? PROVIDER_FACTORIES['openai'];
  return factory({ apiKey, ...(baseURL ? { baseURL } : {}) })(modelName);
}

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
