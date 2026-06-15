import type { AgentStreamManager, ChatMessage, IntermediateStep } from './types';
import type { N8nTool } from '../../utils/getConnectedTools';

export interface AgentExecutorOptions {
  model: unknown;
  tools: N8nTool[];
  systemPrompt?: string;
  messages: ChatMessage[];
  maxSteps: number;
  streamManager: AgentStreamManager;
}

export interface AgentExecutorResult {
  responseText: string;
  intermediateSteps: IntermediateStep[];
  tokenCount?: number;
  newMessages: ChatMessage[];
}

interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface ToolCallAccumulator {
  id?: string;
  name?: string;
  argsText: string;
}

type ChatModel = {
  bindTools?: (tools: N8nTool[]) => ChatModel;
  stream?: (messages: unknown[]) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
  invoke?: (messages: unknown[]) => Promise<unknown>;
};

function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function getChunkText(chunk: unknown): string {
  const record = getRecord(chunk);
  const content = record['content'];

  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const partRecord = getRecord(part);
        if (typeof partRecord['text'] === 'string') return partRecord['text'];
        if (typeof partRecord['content'] === 'string') return partRecord['content'];
        return '';
      })
      .join('');
  }

  return '';
}

function normalizeArgs(args: unknown): Record<string, unknown> {
  if (!args) return {};
  if (typeof args === 'string') {
    if (!args.trim()) return {};
    const parsed = JSON.parse(args) as unknown;
    return getRecord(parsed);
  }
  return getRecord(args);
}

function extractFullToolCalls(message: unknown): ToolCall[] {
  const record = getRecord(message);
  const directToolCalls = record['tool_calls'] ?? record['toolCalls'];

  if (Array.isArray(directToolCalls)) {
    return directToolCalls
      .map((toolCall) => {
        const tc = getRecord(toolCall);
        const name = tc['name'];
        if (typeof name !== 'string') return null;
        return {
          id: typeof tc['id'] === 'string' ? tc['id'] : `${name}_${Math.random().toString(36).slice(2)}`,
          name,
          args: normalizeArgs(tc['args']),
        };
      })
      .filter((tc): tc is ToolCall => tc !== null);
  }

  const additionalKwargs = getRecord(record['additional_kwargs']);
  const rawToolCalls = additionalKwargs['tool_calls'];
  if (!Array.isArray(rawToolCalls)) return [];

  return rawToolCalls
    .map((toolCall) => {
      const tc = getRecord(toolCall);
      const fn = getRecord(tc['function']);
      const name = fn['name'];
      if (typeof name !== 'string') return null;
      return {
        id: typeof tc['id'] === 'string' ? tc['id'] : `${name}_${Math.random().toString(36).slice(2)}`,
        name,
        args: normalizeArgs(fn['arguments']),
      };
    })
    .filter((tc): tc is ToolCall => tc !== null);
}

function collectToolCallChunks(chunk: unknown, accumulators: Map<number, ToolCallAccumulator>): void {
  const record = getRecord(chunk);
  const chunks = record['tool_call_chunks'] ?? record['toolCallChunks'];
  if (!Array.isArray(chunks)) return;

  for (let fallbackIndex = 0; fallbackIndex < chunks.length; fallbackIndex++) {
    const toolChunk = getRecord(chunks[fallbackIndex]);
    const index = typeof toolChunk['index'] === 'number' ? toolChunk['index'] : fallbackIndex;
    const current = accumulators.get(index) ?? { argsText: '' };

    if (typeof toolChunk['id'] === 'string' && toolChunk['id']) current.id = toolChunk['id'];
    if (typeof toolChunk['name'] === 'string' && toolChunk['name']) current.name = toolChunk['name'];
    if (typeof toolChunk['args'] === 'string') current.argsText += toolChunk['args'];

    accumulators.set(index, current);
  }
}

function toolCallsFromChunks(accumulators: Map<number, ToolCallAccumulator>): ToolCall[] {
  return Array.from(accumulators.values())
    .map((toolCall) => {
      if (!toolCall.name) return null;
      return {
        id: toolCall.id ?? `${toolCall.name}_${Math.random().toString(36).slice(2)}`,
        name: toolCall.name,
        args: normalizeArgs(toolCall.argsText),
      };
    })
    .filter((tc): tc is ToolCall => tc !== null);
}

function resolveInvoker(tool: N8nTool): (args: Record<string, unknown>) => unknown {
  const invoker = tool.invoke ?? tool.call ?? tool.func;
  if (!invoker) throw new Error(`Connected tool "${tool.name}" has no invoke/call/func method`);
  return invoker.bind(tool) as (args: Record<string, unknown>) => unknown;
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  return JSON.stringify(result);
}

function toLangChainMessages(messages: ChatMessage[], systemPrompt?: string): unknown[] {
  const converted: unknown[] = [];
  if (systemPrompt) converted.push({ role: 'system', content: systemPrompt });

  for (const message of messages) {
    if (message.role === 'tool') {
      for (const part of message.content) {
        converted.push({
          role: 'tool',
          content: stringifyToolResult(part['result']),
          tool_call_id: part['toolCallId'],
          name: part['toolName'],
        });
      }
      continue;
    }
    converted.push(message);
  }

  return converted;
}

async function runModelTurn(
  model: ChatModel,
  messages: unknown[],
  streamManager: AgentStreamManager,
): Promise<{ message: unknown; text: string; toolCalls: ToolCall[] }> {
  if (typeof model.stream === 'function') {
    const stream = await model.stream(messages);
    let text = '';
    let accumulatedMessage: unknown;
    const chunkToolCalls = new Map<number, ToolCallAccumulator>();

    for await (const chunk of stream) {
      const delta = getChunkText(chunk);
      if (delta) {
        text += delta;
        streamManager.appendText(delta);
      }

      collectToolCallChunks(chunk, chunkToolCalls);

      const accumulated = getRecord(accumulatedMessage);
      if (accumulatedMessage && typeof accumulated['concat'] === 'function') {
        accumulatedMessage = (accumulated['concat'] as (next: unknown) => unknown).call(accumulatedMessage, chunk);
      } else if (!accumulatedMessage) {
        accumulatedMessage = chunk;
      }
    }

    const fullToolCalls = extractFullToolCalls(accumulatedMessage);
    return {
      message: accumulatedMessage ?? { role: 'assistant', content: text },
      text,
      toolCalls: fullToolCalls.length ? fullToolCalls : toolCallsFromChunks(chunkToolCalls),
    };
  }

  if (typeof model.invoke !== 'function') {
    throw new Error('Connected AI model does not expose stream() or invoke()');
  }

  const message = await model.invoke(messages);
  const text = getChunkText(message);
  if (text) streamManager.appendText(text);

  return {
    message,
    text,
    toolCalls: extractFullToolCalls(message),
  };
}

export async function executeAgent(
  options: AgentExecutorOptions,
): Promise<AgentExecutorResult> {
  const { model, tools, systemPrompt, messages, maxSteps, streamManager } = options;
  const chatModel = model as ChatModel;

  const runnableModel: ChatModel | undefined =
    tools.length > 0
      ? chatModel.bindTools?.(tools)
      : chatModel;

  if (tools.length > 0 && !runnableModel) {
    throw new Error('Connected AI model does not support tools. Please use a chat model with tool-calling support.');
  }
  if (!runnableModel) {
    throw new Error('Connected AI model is not runnable.');
  }

  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const intermediateSteps: IntermediateStep[] = [];
  const newMessages: ChatMessage[] = [];
  const conversation = toLangChainMessages(messages, systemPrompt);

  for (let step = 0; step < maxSteps; step++) {
    const turn = await runModelTurn(runnableModel, conversation, streamManager);

    if (turn.toolCalls.length === 0) {
      if (turn.text) newMessages.push({ role: 'assistant', content: turn.text });
      return {
        responseText: streamManager.responseText,
        intermediateSteps,
        newMessages,
      };
    }

    conversation.push(turn.message);
    newMessages.push({
      role: 'assistant',
      content: turn.toolCalls.map((tc) => ({
        type: 'tool-call',
        toolCallId: tc.id,
        toolName: tc.name,
        args: tc.args,
      })),
    });

    const toolResultParts: Record<string, unknown>[] = [];
    for (const toolCall of turn.toolCalls) {
      const tool = toolMap.get(toolCall.name);
      if (!tool) {
        throw new Error(
          `Model tried to call unavailable tool "${toolCall.name}". Available tools: ${Array.from(toolMap.keys()).join(', ')}`,
        );
      }

      const result = await resolveInvoker(tool)(toolCall.args);
      const stringResult = stringifyToolResult(result);

      intermediateSteps.push({
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        args: toolCall.args,
        result: stringResult,
      });

      toolResultParts.push({
        type: 'tool-result',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result: stringResult,
      });

      conversation.push({
        role: 'tool',
        content: stringResult,
        tool_call_id: toolCall.id,
        name: toolCall.name,
      });

      await streamManager.sendTaskUpdate(toolCall.id, toolCall.name, 'complete');
    }

    newMessages.push({ role: 'tool', content: toolResultParts });
  }

  throw new Error(`Agent stopped after reaching max iterations (${maxSteps})`);
}
