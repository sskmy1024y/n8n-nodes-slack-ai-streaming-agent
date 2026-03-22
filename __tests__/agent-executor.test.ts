import { executeAgent } from '../nodes/SlackAiStreamingAgent/agent-executor';
import type { SlackStreamManager } from '../nodes/SlackAiStreamingAgent/slack-stream';
import type { LanguageModelV1 } from 'ai';

// Mock the 'ai' module
jest.mock('ai', () => {
  const actual = jest.requireActual('ai');
  return {
    ...actual,
    streamText: jest.fn(),
  };
});

import { streamText } from 'ai';

const mockStreamText = streamText as jest.MockedFunction<typeof streamText>;

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

function createMockModel(): LanguageModelV1 {
  return {} as LanguageModelV1;
}

/**
 * Helper to create a mock streamText return value.
 * The key is that `streamText` returns an object with properties like textStream, usage, steps.
 * `await result` in agent-executor uses the thenable nature, but we need to be careful
 * not to create infinite recursion.
 */
function createMockStreamResult(options: {
  chunks: string[];
  usage?: { totalTokens: number };
  steps?: Array<Record<string, unknown>>;
  onStepFinishCalls?: Array<Record<string, unknown>>;
}) {
  const { chunks, usage = { totalTokens: 10 }, steps = [] } = options;

  async function* textGen() {
    for (const chunk of chunks) {
      yield chunk;
    }
  }

  // Create a resolved-state object that `await result` will produce
  const resolvedResult = {
    usage,
    steps,
  };

  // The streamText return: has textStream and is also a thenable
  const streamResult = {
    textStream: textGen(),
    // Direct property access (used after await)
    usage,
    steps,
    // Make it thenable so `await result` resolves to itself with resolved values
    then(
      resolve: (val: typeof resolvedResult) => void,
      _reject?: (err: unknown) => void,
    ) {
      resolve(resolvedResult);
      // Return undefined to avoid chaining issues
    },
  };

  return streamResult;
}

describe('executeAgent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('relays text stream to SlackStreamManager', async () => {
    mockStreamText.mockImplementation((opts: Record<string, unknown>) => {
      return createMockStreamResult({
        chunks: ['Hello', ' ', 'World'],
        usage: { totalTokens: 15 },
      }) as unknown as ReturnType<typeof streamText>;
    });

    const streamManager = createMockStreamManager();
    const result = await executeAgent({
      model: createMockModel(),
      tools: {},
      systemPrompt: 'Be helpful',
      messages: [{ role: 'user', content: 'Hi' }],
      maxSteps: 5,
      streamManager,
    });

    expect(mockStreamText).toHaveBeenCalledWith(expect.objectContaining({
      system: 'Be helpful',
      messages: [{ role: 'user', content: 'Hi' }],
      maxSteps: 5,
    }));

    expect(streamManager.appendedTexts).toEqual(['Hello', ' ', 'World']);
    expect(result.responseText).toBe('Hello World');
    expect(result.tokenCount).toBe(15);
  });

  it('reports tool calls via onStepFinish as intermediate steps', async () => {
    mockStreamText.mockImplementation((opts: Record<string, unknown>) => {
      const onStepFinish = opts['onStepFinish'] as (step: Record<string, unknown>) => Promise<void>;

      // Create the stream result
      const chunks = ['Result: 42'];

      async function* textGen() {
        // Trigger onStepFinish before yielding text
        await onStepFinish({
          toolCalls: [
            { toolCallId: 'tc_1', toolName: 'calculator', args: { expr: '6*7' } },
          ],
          toolResults: [
            { toolCallId: 'tc_1', toolName: 'calculator', result: '42' },
          ],
        });
        for (const chunk of chunks) {
          yield chunk;
        }
      }

      const resolvedResult = {
        usage: { totalTokens: 20 },
        steps: [
          {
            toolCalls: [
              { toolCallId: 'tc_1', toolName: 'calculator', args: { expr: '6*7' } },
            ],
            toolResults: [
              { toolCallId: 'tc_1', toolName: 'calculator', result: '42' },
            ],
          },
        ],
      };

      return {
        textStream: textGen(),
        usage: resolvedResult.usage,
        steps: resolvedResult.steps,
        then(resolve: (val: typeof resolvedResult) => void) {
          resolve(resolvedResult);
        },
      } as unknown as ReturnType<typeof streamText>;
    });

    const streamManager = createMockStreamManager();
    const result = await executeAgent({
      model: createMockModel(),
      tools: {},
      messages: [{ role: 'user', content: 'What is 6*7?' }],
      maxSteps: 5,
      streamManager,
    });

    expect(result.intermediateSteps).toHaveLength(1);
    expect(result.intermediateSteps[0]).toEqual({
      toolName: 'calculator',
      toolCallId: 'tc_1',
      args: { expr: '6*7' },
      result: '42',
    });

    // Should have sent task update to stream manager
    expect(streamManager.taskUpdates).toEqual([
      { taskId: 'tc_1', title: 'calculator', status: 'complete' },
    ]);
  });

  it('builds newMessages with tool call/result structure', async () => {
    mockStreamText.mockImplementation((opts: Record<string, unknown>) => {
      const onStepFinish = opts['onStepFinish'] as (step: Record<string, unknown>) => Promise<void>;

      async function* textGen() {
        // Trigger onStepFinish before text
        await onStepFinish({
          toolCalls: [
            { toolCallId: 'tc_1', toolName: 'calc', args: { x: 6, y: 7 } },
          ],
          toolResults: [
            { toolCallId: 'tc_1', toolName: 'calc', result: '42' },
          ],
        });
        yield 'The answer is 42.';
      }

      const resolvedResult = {
        usage: { totalTokens: 30 },
        steps: [],
      };

      return {
        textStream: textGen(),
        usage: resolvedResult.usage,
        steps: resolvedResult.steps,
        then(resolve: (val: typeof resolvedResult) => void) {
          resolve(resolvedResult);
        },
      } as unknown as ReturnType<typeof streamText>;
    });

    const streamManager = createMockStreamManager();
    const result = await executeAgent({
      model: createMockModel(),
      tools: {},
      messages: [{ role: 'user', content: 'Calc' }],
      maxSteps: 5,
      streamManager,
    });

    // Should have: assistant(tool-call) → tool(result) → assistant(text)
    expect(result.newMessages).toHaveLength(3);
    expect(result.newMessages[0].role).toBe('assistant');
    expect(result.newMessages[1].role).toBe('tool');
    expect(result.newMessages[2]).toEqual({
      role: 'assistant',
      content: 'The answer is 42.',
    });
  });

  it('handles empty response (no text)', async () => {
    mockStreamText.mockImplementation(() => {
      return createMockStreamResult({
        chunks: [],
        usage: { totalTokens: 0 },
      }) as unknown as ReturnType<typeof streamText>;
    });

    const streamManager = createMockStreamManager();
    const result = await executeAgent({
      model: createMockModel(),
      tools: {},
      messages: [{ role: 'user', content: 'test' }],
      maxSteps: 1,
      streamManager,
    });

    expect(result.responseText).toBe('');
    expect(result.newMessages).toHaveLength(0);
  });

  it('does not pass tools when tools map is empty', async () => {
    mockStreamText.mockImplementation(() => {
      return createMockStreamResult({
        chunks: ['ok'],
      }) as unknown as ReturnType<typeof streamText>;
    });

    const streamManager = createMockStreamManager();
    await executeAgent({
      model: createMockModel(),
      tools: {},
      messages: [{ role: 'user', content: 'test' }],
      maxSteps: 1,
      streamManager,
    });

    expect(mockStreamText).toHaveBeenCalledWith(expect.objectContaining({
      tools: undefined,
    }));
  });

  it('omits system prompt when not provided', async () => {
    mockStreamText.mockImplementation(() => {
      return createMockStreamResult({
        chunks: ['ok'],
      }) as unknown as ReturnType<typeof streamText>;
    });

    const streamManager = createMockStreamManager();
    await executeAgent({
      model: createMockModel(),
      tools: {},
      messages: [{ role: 'user', content: 'test' }],
      maxSteps: 1,
      streamManager,
    });

    const callArgs = mockStreamText.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty('system');
  });
});
