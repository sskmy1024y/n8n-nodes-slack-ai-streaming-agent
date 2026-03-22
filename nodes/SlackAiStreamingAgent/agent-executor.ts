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
  } = options;

  const intermediateSteps: IntermediateStep[] = [];

  const result = streamText({
    model,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    messages,
    tools: Object.keys(tools).length > 0 ? tools : undefined,
    maxSteps,
    onStepFinish: async (step: Record<string, unknown>) => {
      // Report completed tool calls as task_update chunks
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

  // Relay text stream to Slack
  let fullResponse = '';
  for await (const delta of result.textStream) {
    fullResponse += delta;
    await streamManager.appendText(delta);
  }

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
      // Assistant message with tool calls
      newMessages.push({
        role: 'assistant',
        content: toolCalls.map((tc) => ({
          type: 'tool-call' as const,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.args,
        })),
      });

      // Tool result messages
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

  // Final assistant text
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
