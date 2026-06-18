import { executeAgent } from '../nodes/SlackAiStreamingAgent/agent-executor';
import type { SlackStreamManager } from '../nodes/SlackAiStreamingAgent/slack-stream';
import type { N8nTool } from '../utils/getConnectedTools';

function createMockStreamManager(): SlackStreamManager & {
  appendedTexts: string[];
  taskUpdates: Array<{ taskId: string; title: string; status: string }>;
} {
  const appendedTexts: string[] = [];
  const taskUpdates: Array<{ taskId: string; title: string; status: string }> = [];
  let fullText = '';

  return {
    appendedTexts,
    taskUpdates,
    get responseText() { return fullText; },
    appendText: jest.fn((text: string) => {
      appendedTexts.push(text);
      fullText += text;
    }),
    sendTaskUpdate: jest.fn(async (taskId: string, title: string, status: string) => {
      taskUpdates.push({ taskId, title, status });
    }),
  } as unknown as SlackStreamManager & {
    appendedTexts: string[];
    taskUpdates: Array<{ taskId: string; title: string; status: string }>;
  };
}

async function* chunks(...values: unknown[]) {
  for (const value of values) yield value;
}

describe('executeAgent', () => {
  it('relays LangChain text stream chunks to SlackStreamManager', async () => {
    const model = {
      stream: jest.fn(async () => chunks(
        { content: 'Hello' },
        { content: ' ' },
        { content: 'World' },
      )),
    };
    const streamManager = createMockStreamManager();

    const result = await executeAgent({
      model,
      tools: [],
      systemPrompt: 'Be helpful',
      messages: [{ role: 'user', content: 'Hi' }],
      maxSteps: 5,
      streamManager,
    });

    expect(model.stream).toHaveBeenCalledWith([
      { role: 'system', content: 'Be helpful' },
      { role: 'user', content: 'Hi' },
    ]);
    expect(streamManager.appendedTexts).toEqual(['Hello', ' ', 'World']);
    expect(result.responseText).toBe('Hello World');
    expect(result.newMessages).toEqual([{ role: 'assistant', content: 'Hello World' }]);
  });

  it('binds connected tools and executes model tool calls', async () => {
    const invoke = jest.fn().mockResolvedValue('42');
    const tool: N8nTool = {
      name: 'calculator',
      description: 'Calculate',
      invoke,
    };
    const boundModel = {
      stream: jest
        .fn()
        .mockImplementationOnce(async () => chunks({
          content: '',
          tool_calls: [
            { id: 'tc_1', name: 'calculator', args: { expr: '6*7' } },
          ],
        }))
        .mockImplementationOnce(async () => chunks({ content: 'Result: 42' })),
    };
    const model = {
      bindTools: jest.fn(() => boundModel),
    };
    const streamManager = createMockStreamManager();

    const result = await executeAgent({
      model,
      tools: [tool],
      messages: [{ role: 'user', content: 'What is 6*7?' }],
      maxSteps: 5,
      streamManager,
    });

    expect(model.bindTools).toHaveBeenCalledWith([tool]);
    expect(invoke).toHaveBeenCalledWith({ expr: '6*7' });
    expect(streamManager.taskUpdates).toEqual([
      { taskId: 'tc_1', title: 'calculator', status: 'complete' },
    ]);
    expect(result.intermediateSteps).toEqual([
      {
        toolName: 'calculator',
        toolCallId: 'tc_1',
        args: { expr: '6*7' },
        result: '42',
      },
    ]);
    expect(result.responseText).toBe('Result: 42');
    expect(result.newMessages).toHaveLength(3);
    expect(result.newMessages[0].role).toBe('assistant');
    expect(result.newMessages[1].role).toBe('tool');
    expect(result.newMessages[2]).toEqual({ role: 'assistant', content: 'Result: 42' });
  });

  it('collects streamed tool call chunks', async () => {
    const invoke = jest.fn().mockResolvedValue({ ok: true });
    const tool: N8nTool = { name: 'lookup_status', invoke };
    const boundModel = {
      stream: jest
        .fn()
        .mockImplementationOnce(async () => chunks(
          { content: '', tool_call_chunks: [{ index: 0, id: 'call_1', name: 'lookup_status', args: '{"id"' }] },
          { content: '', tool_call_chunks: [{ index: 0, args: ':"T123"}' }] },
        ))
        .mockImplementationOnce(async () => chunks({ content: 'Ticket T123 is open.' })),
    };
    const model = { bindTools: jest.fn(() => boundModel) };
    const streamManager = createMockStreamManager();

    await executeAgent({
      model,
      tools: [tool],
      messages: [{ role: 'user', content: 'Check ticket T123' }],
      maxSteps: 2,
      streamManager,
    });

    expect(invoke).toHaveBeenCalledWith({ id: 'T123' });
  });

  it('throws when tools are connected to a model without bindTools', async () => {
    const streamManager = createMockStreamManager();

    await expect(executeAgent({
      model: { stream: jest.fn() },
      tools: [{ name: 'calculator', invoke: jest.fn() }],
      messages: [{ role: 'user', content: 'test' }],
      maxSteps: 1,
      streamManager,
    })).rejects.toThrow('does not support tools');
  });

  it('uses invoke when stream is unavailable', async () => {
    const model = {
      invoke: jest.fn(async () => ({ content: 'Done' })),
    };
    const streamManager = createMockStreamManager();

    const result = await executeAgent({
      model,
      tools: [],
      messages: [{ role: 'user', content: 'test' }],
      maxSteps: 1,
      streamManager,
    });

    expect(model.invoke).toHaveBeenCalled();
    expect(result.responseText).toBe('Done');
  });
});
