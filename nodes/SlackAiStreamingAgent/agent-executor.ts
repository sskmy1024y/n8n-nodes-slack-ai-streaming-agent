import { streamText } from 'ai';
import type { LanguageModelV1, CoreMessage, ToolSet } from 'ai';
import type { SlackStreamManager } from './slack-stream';
import type { IntermediateStep } from './types';

export interface AgentExecutorOptions {
  model: LanguageModelV1;
  tools: ToolSet;
  systemPrompt?: string;
  messages: CoreMessage[];
  maxSteps: number;
  streamManager: SlackStreamManager;
}

export interface AgentExecutorResult {
  responseText: string;
  intermediateSteps: IntermediateStep[];
  tokenCount?: number;
  newMessages: CoreMessage[];
}

interface StepToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

interface StepToolResult {
  toolCallId: string;
  toolName: string;
  result: unknown;
}

export async function executeAgent(
  options: AgentExecutorOptions,
): Promise<AgentExecutorResult> {
  const { model, tools, systemPrompt, messages, maxSteps, streamManager } = options;

  const intermediateSteps: IntermediateStep[] = [];
  const newMessages: CoreMessage[] = [];

  const result = streamText({
    model,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    messages,
    tools: Object.keys(tools).length > 0 ? tools : undefined,
    maxSteps,
    onStepFinish: async (step: Record<string, unknown>) => {
      const toolCalls = step['toolCalls'] as StepToolCall[] | undefined;
      const toolResults = step['toolResults'] as StepToolResult[] | undefined;

      if (!toolCalls?.length) return;

      // Build intermediateSteps + newMessages in one pass
      newMessages.push({
        role: 'assistant',
        content: toolCalls.map((tc) => ({
          type: 'tool-call' as const,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.args,
        })),
      });

      for (const tc of toolCalls) {
        const toolResult = toolResults?.find((tr) => tr.toolCallId === tc.toolCallId);

        intermediateSteps.push({
          toolName: tc.toolName,
          toolCallId: tc.toolCallId,
          args: tc.args as Record<string, unknown>,
          result: toolResult?.result,
        });

        if (toolResult) {
          newMessages.push({
            role: 'tool',
            content: [{
              type: 'tool-result' as const,
              toolCallId: toolResult.toolCallId,
              toolName: toolResult.toolName,
              result: toolResult.result,
            }],
          });
        }

        await streamManager.sendTaskUpdate(tc.toolCallId, tc.toolName, 'complete');
      }
    },
  });

  console.log('[SlackAiStreamingAgent] streamText() called, consuming textStream...');
  let chunkCount = 0;
  try {
    for await (const delta of result.textStream) {
      chunkCount++;
      if (chunkCount === 1) {
        console.log(`[SlackAiStreamingAgent] First chunk: "${delta.slice(0, 50)}"`);
      }
      streamManager.appendText(delta);
    }
  } catch (err) {
    console.error('[SlackAiStreamingAgent] Stream error:', err);
    throw err;
  }
  console.log(`[SlackAiStreamingAgent] Stream done: ${chunkCount} chunks, ${streamManager.responseText.length} chars`);

  const finalResult = await result;
  const usage = await finalResult.usage;
  const responseText = streamManager.responseText;

  if (responseText) {
    newMessages.push({ role: 'assistant', content: responseText });
  }

  return {
    responseText,
    intermediateSteps,
    tokenCount: usage?.totalTokens,
    newMessages,
  };
}
