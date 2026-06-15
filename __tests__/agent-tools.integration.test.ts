import { NodeConnectionTypes } from 'n8n-workflow';
import type { IExecuteFunctions } from 'n8n-workflow';
import type { SlackStreamManager } from '../nodes/SlackAiStreamingAgent/slack-stream';
import { executeAgent } from '../nodes/SlackAiStreamingAgent/agent-executor';
import { getConnectedTools } from '../utils/getConnectedTools';

async function* chunks(...values: unknown[]) {
  for (const value of values) yield value;
}

function createMockStreamManager(): SlackStreamManager & {
  taskUpdates: Array<{ taskId: string; title: string; status: string }>;
} {
  let fullText = '';
  const taskUpdates: Array<{ taskId: string; title: string; status: string }> = [];

  return {
    taskUpdates,
    get responseText() {
      return fullText;
    },
    appendText: jest.fn((text: string) => {
      fullText += text;
    }),
    sendTaskUpdate: jest.fn(async (taskId: string, title: string, status: string) => {
      taskUpdates.push({ taskId, title, status });
    }),
  } as unknown as SlackStreamManager & {
    taskUpdates: Array<{ taskId: string; title: string; status: string }>;
  };
}

describe('n8n LangChain tools with the Slack executor', () => {
  it('keeps connected n8n tools intact and executes them through bindTools', async () => {
    const invoke = jest.fn().mockResolvedValue({ status: 'open' });
    const n8nTool = {
      name: 'lookup_status',
      description: 'Look up a ticket status',
      schema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      invoke,
    };
    const ctx = {
      getInputConnectionData: jest.fn().mockResolvedValue([n8nTool]),
    } as unknown as IExecuteFunctions;

    const tools = await getConnectedTools(ctx);
    const boundModel = {
      stream: jest
        .fn()
        .mockImplementationOnce(async () => chunks({
          content: '',
          tool_calls: [{ id: 'call_1', name: 'lookup_status', args: { id: 'T123' } }],
        }))
        .mockImplementationOnce(async () => chunks({ content: 'Ticket T123 is open.' })),
    };
    const model = {
      bindTools: jest.fn(() => boundModel),
    };
    const streamManager = createMockStreamManager();

    const result = await executeAgent({
      model,
      tools,
      messages: [{ role: 'user', content: 'Check ticket T123' }],
      maxSteps: 2,
      streamManager,
    });

    expect(ctx.getInputConnectionData).toHaveBeenCalledWith(NodeConnectionTypes.AiTool, 0);
    expect(model.bindTools).toHaveBeenCalledWith([n8nTool]);
    expect(invoke).toHaveBeenCalledWith({ id: 'T123' });
    expect(result.responseText).toBe('Ticket T123 is open.');
    expect(result.intermediateSteps).toEqual([
      {
        toolName: 'lookup_status',
        toolCallId: 'call_1',
        args: { id: 'T123' },
        result: '{"status":"open"}',
      },
    ]);
    expect(streamManager.taskUpdates).toEqual([
      { taskId: 'call_1', title: 'lookup_status', status: 'complete' },
    ]);
  });
});
