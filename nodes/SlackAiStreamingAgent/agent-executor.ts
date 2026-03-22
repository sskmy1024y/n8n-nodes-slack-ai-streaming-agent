import { streamText } from 'ai';
import type { LanguageModelV1, CoreMessage, ToolSet } from 'ai';
import type { SlackStreamManager } from './slack-stream';
import type { IntermediateStep } from './types';

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes

export interface AgentExecutorOptions {
  model: LanguageModelV1;
  tools: ToolSet;
  systemPrompt?: string;
  messages: CoreMessage[];
  maxSteps: number;
  streamManager: SlackStreamManager;
  timeoutMs?: number;
}

export interface AgentExecutorResult {
  responseText: string;
  intermediateSteps: IntermediateStep[];
  tokenCount?: number;
  newMessages: CoreMessage[];
}

/**
 * Wraps a promise with a timeout.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[SlackAiStreamingAgent] Timeout after ${ms}ms: ${label}`)),
      ms,
    );
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Executes the AI agent with streaming, relaying tokens to Slack in real-time.
 */
export async function executeAgent(
  options: AgentExecutorOptions,
): Promise<AgentExecutorResult> {
  const {
    model,
    tools,
    systemPrompt,
    messages,
    maxSteps,
    streamManager,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const intermediateSteps: IntermediateStep[] = [];

  console.log('[SlackAiStreamingAgent] Starting streamText...');
  console.log('[SlackAiStreamingAgent] Messages:', JSON.stringify(messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content.slice(0, 100) : '(complex)',
  }))));

  let result;
  try {
    result = streamText({
      model,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages,
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      maxSteps,
      onStepFinish: async (step: Record<string, unknown>) => {
        console.log('[SlackAiStreamingAgent] Step finished');
        const toolCalls = step['toolCalls'] as
          | Array<{ toolCallId: string; toolName: string; args: unknown }>
          | undefined;
        const toolResults = step['toolResults'] as
          | Array<{ toolCallId: string; toolName: string; result: unknown }>
          | undefined;

        if (toolCalls && toolCalls.length > 0) {
          for (const tc of toolCalls) {
            const toolResult = toolResults?.find(
              (tr) => tr.toolCallId === tc.toolCallId,
            );

            intermediateSteps.push({
              toolName: tc.toolName,
              toolCallId: tc.toolCallId,
              args: tc.args as Record<string, unknown>,
              result: toolResult?.result,
            });

            await streamManager.sendTaskUpdate(
              tc.toolCallId,
              tc.toolName,
              'complete',
            );
          }
        }
      },
    });
  } catch (error) {
    console.error('[SlackAiStreamingAgent] streamText() call failed:', error);
    throw new Error(`Failed to start AI streaming: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Relay text stream to Slack with timeout
  console.log('[SlackAiStreamingAgent] Consuming text stream...');
  let fullResponse = '';
  let receivedFirstChunk = false;

  const streamConsumption = (async () => {
    try {
      for await (const delta of result.textStream) {
        if (!receivedFirstChunk) {
          console.log('[SlackAiStreamingAgent] First chunk received');
          receivedFirstChunk = true;
        }
        fullResponse += delta;
        await streamManager.appendText(delta);
      }
      console.log(`[SlackAiStreamingAgent] Stream complete. Total length: ${fullResponse.length}`);
    } catch (error) {
      console.error('[SlackAiStreamingAgent] Error consuming stream:', error);
      throw new Error(`AI stream error: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();

  await withTimeout(streamConsumption, timeoutMs, 'consuming text stream');

  // Wait for completion to get usage data
  const finalResult = await result;
  const usage = await finalResult.usage;

  // Build the new messages to save to memory
  const newMessages: CoreMessage[] = [];

  // Collect all steps' messages
  const steps = await finalResult.steps;
  for (const step of steps) {
    const stepObj = step as Record<string, unknown>;
    const toolCalls = stepObj['toolCalls'] as
      | Array<{ toolCallId: string; toolName: string; args: unknown }>
      | undefined;
    const toolResults = stepObj['toolResults'] as
      | Array<{ toolCallId: string; toolName: string; result: unknown }>
      | undefined;

    if (toolCalls && toolCalls.length > 0) {
      newMessages.push({
        role: 'assistant',
        content: toolCalls.map((tc) => ({
          type: 'tool-call' as const,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.args,
        })),
      });

      if (toolResults) {
        for (const tr of toolResults) {
          newMessages.push({
            role: 'tool',
            content: [
              {
                type: 'tool-result' as const,
                toolCallId: tr.toolCallId,
                toolName: tr.toolName,
                result: tr.result,
              },
            ],
          });
        }
      }
    }
  }

  if (fullResponse) {
    newMessages.push({
      role: 'assistant',
      content: fullResponse,
    });
  }

  return {
    responseText: fullResponse,
    intermediateSteps,
    tokenCount: usage?.totalTokens,
    newMessages,
  };
}
