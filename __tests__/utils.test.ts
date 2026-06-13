import { ChatArrayMemory } from '../utils/chatArrayMemory';
import type { N8nMemory } from '../utils/getConnectedMemory';

// --- ChatArrayMemory tests ---

function createMockMemory(): N8nMemory & { messages: unknown[] } {
  const messages: unknown[] = [];
  return {
    messages,
    chatHistory: {
      getMessages: jest.fn(async () => messages),
      addMessage: jest.fn(async (msg: unknown) => {
        messages.push(msg);
      }),
      addUserMessage: jest.fn(async (content: string) => {
        messages.push({
          _getType: () => 'human',
          content,
        });
      }),
      addAIChatMessage: jest.fn(async (content: string) => {
        messages.push({
          _getType: () => 'ai',
          content,
        });
      }),
    },
  };
}

describe('ChatArrayMemory', () => {
  describe('load', () => {
    it('converts human messages to user role', async () => {
      const mock = createMockMemory();
      mock.messages.push({ _getType: () => 'human', content: 'Hello' });

      const adapter = new ChatArrayMemory(mock);
      const result = await adapter.load();

      expect(result).toEqual([{ role: 'user', content: 'Hello' }]);
    });

    it('converts ai messages to assistant role', async () => {
      const mock = createMockMemory();
      mock.messages.push({ _getType: () => 'ai', content: 'Hi there!' });

      const adapter = new ChatArrayMemory(mock);
      const result = await adapter.load();

      expect(result).toEqual([{ role: 'assistant', content: 'Hi there!' }]);
    });

    it('converts system messages to system role', async () => {
      const mock = createMockMemory();
      mock.messages.push({ _getType: () => 'system', content: 'You are helpful' });

      const adapter = new ChatArrayMemory(mock);
      const result = await adapter.load();

      expect(result).toEqual([{ role: 'system', content: 'You are helpful' }]);
    });

    it('parses JSON-encoded CoreMessage arrays from ai messages', async () => {
      const mock = createMockMemory();
      const stored = JSON.stringify([
        { role: 'assistant', content: 'I will search for that.' },
        { role: 'assistant', content: 'Here are the results.' },
      ]);
      mock.messages.push({ _getType: () => 'ai', content: stored });

      const adapter = new ChatArrayMemory(mock);
      const result = await adapter.load();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ role: 'assistant', content: 'I will search for that.' });
      expect(result[1]).toEqual({ role: 'assistant', content: 'Here are the results.' });
    });

    it('handles mixed message types in conversation', async () => {
      const mock = createMockMemory();
      mock.messages.push(
        { _getType: () => 'human', content: 'What is 2+2?' },
        { _getType: () => 'ai', content: '4' },
        { _getType: () => 'human', content: 'Thanks!' },
        { _getType: () => 'ai', content: 'You\'re welcome!' },
      );

      const adapter = new ChatArrayMemory(mock);
      const result = await adapter.load();

      expect(result).toEqual([
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: '4' },
        { role: 'user', content: 'Thanks!' },
        { role: 'assistant', content: 'You\'re welcome!' },
      ]);
    });

    it('respects maxMessages windowing', async () => {
      const mock = createMockMemory();
      for (let i = 0; i < 10; i++) {
        mock.messages.push({ _getType: () => 'human', content: `msg ${i}` });
        mock.messages.push({ _getType: () => 'ai', content: `reply ${i}` });
      }

      const adapter = new ChatArrayMemory(mock, 4);
      const result = await adapter.load();

      expect(result).toHaveLength(4);
      expect(result[0]).toEqual({ role: 'user', content: 'msg 8' });
    });

    it('trims leading tool messages after windowing', async () => {
      const mock = createMockMemory();
      // Simulate a scenario where windowing starts at a tool message
      const stored = JSON.stringify([
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tc1', toolName: 'test', result: 'ok' }] },
        { role: 'assistant', content: 'Done!' },
      ]);
      mock.messages.push({ _getType: () => 'ai', content: stored });
      mock.messages.push({ _getType: () => 'human', content: 'Next question' });

      // maxMessages = 2 means we keep last 2, but first is tool → gets trimmed
      const adapter = new ChatArrayMemory(mock, 2);
      const result = await adapter.load();

      expect(result[0].role).not.toBe('tool');
    });

    it('returns empty array when no messages', async () => {
      const mock = createMockMemory();
      const adapter = new ChatArrayMemory(mock);
      const result = await adapter.load();
      expect(result).toEqual([]);
    });
  });

  describe('save', () => {
    it('saves user message via addUserMessage', async () => {
      const mock = createMockMemory();
      const adapter = new ChatArrayMemory(mock);

      await adapter.save([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ]);

      expect(mock.chatHistory.addUserMessage).toHaveBeenCalledWith('Hello');
    });

    it('saves assistant messages via addAIChatMessage as JSON', async () => {
      const mock = createMockMemory();
      const adapter = new ChatArrayMemory(mock);

      await adapter.save([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ]);

      expect(mock.chatHistory.addAIChatMessage).toHaveBeenCalledWith(
        JSON.stringify([{ role: 'assistant', content: 'Hi!' }]),
      );
    });

    it('saves the last user message when multiple exist', async () => {
      const mock = createMockMemory();
      const adapter = new ChatArrayMemory(mock);

      await adapter.save([
        { role: 'user', content: 'First' },
        { role: 'user', content: 'Second' },
        { role: 'assistant', content: 'Reply' },
      ]);

      expect(mock.chatHistory.addUserMessage).toHaveBeenCalledWith('Second');
    });

    it('handles messages with tool calls and results', async () => {
      const mock = createMockMemory();
      const adapter = new ChatArrayMemory(mock);

      const messages = [
        { role: 'user' as const, content: 'Search for X' },
        {
          role: 'assistant' as const,
          content: [{
            type: 'tool-call' as const,
            toolCallId: 'tc1',
            toolName: 'search',
            args: { query: 'X' },
          }],
        },
        {
          role: 'tool' as const,
          content: [{
            type: 'tool-result' as const,
            toolCallId: 'tc1',
            toolName: 'search',
            result: 'Found X',
          }],
        },
        { role: 'assistant' as const, content: 'I found X for you.' },
      ];

      await adapter.save(messages);

      // Non-user, non-system messages saved as batch
      const savedJson = (mock.chatHistory.addAIChatMessage as jest.Mock).mock.calls[0][0];
      const parsed = JSON.parse(savedJson);
      expect(parsed).toHaveLength(3); // assistant(tool-call) + tool + assistant(text)
    });
  });
});

// --- getConnectedModel tests ---

describe('getConnectedModel', () => {
  it('throws when no model is connected', async () => {
    // We import dynamically to avoid issues with mocking
    const { getConnectedModel } = await import('../utils/getConnectedModel');
    const mockCtx = {
      getInputConnectionData: jest.fn().mockResolvedValue(null),
    } as unknown as import('n8n-workflow').IExecuteFunctions;

    await expect(getConnectedModel(mockCtx)).rejects.toThrow('No AI model connected');
  });
});

// --- getConnectedTools tests ---

describe('getConnectedTools', () => {
  it('returns empty object when no tools connected', async () => {
    const { getConnectedTools } = await import('../utils/getConnectedTools');
    const mockCtx = {
      getInputConnectionData: jest.fn().mockRejectedValue(new Error('no connection')),
    } as unknown as import('n8n-workflow').IExecuteFunctions;

    const tools = await getConnectedTools(mockCtx);
    expect(tools).toEqual({});
  });

  it('returns empty object when null tools', async () => {
    const { getConnectedTools } = await import('../utils/getConnectedTools');
    const mockCtx = {
      getInputConnectionData: jest.fn().mockResolvedValue(null),
    } as unknown as import('n8n-workflow').IExecuteFunctions;

    const tools = await getConnectedTools(mockCtx);
    expect(tools).toEqual({});
  });

  it('converts a single n8n tool to AI SDK tool', async () => {
    const { getConnectedTools } = await import('../utils/getConnectedTools');
    const mockTool = {
      name: 'my_tool',
      description: 'A test tool',
      schema: undefined,
      invoke: jest.fn().mockResolvedValue('tool result'),
    };
    const mockCtx = {
      getInputConnectionData: jest.fn().mockResolvedValue(mockTool),
    } as unknown as import('n8n-workflow').IExecuteFunctions;

    const tools = await getConnectedTools(mockCtx);
    expect(tools).toHaveProperty('my_tool');
    expect(tools['my_tool']).toHaveProperty('execute');
  });

  it('reads tool connections from index 0 even for later main input items', async () => {
    const { getConnectedTools } = await import('../utils/getConnectedTools');
    const { NodeConnectionTypes } = await import('n8n-workflow');
    const mockTool = {
      name: 'shared_tool',
      description: 'Available to every item',
      invoke: jest.fn().mockResolvedValue('ok'),
    };
    const mockCtx = {
      getInputConnectionData: jest.fn().mockImplementation((_type, itemIndex) => {
        if (itemIndex !== 0) throw new Error('No tool data for this item');
        return Promise.resolve(mockTool);
      }),
    } as unknown as import('n8n-workflow').IExecuteFunctions;

    const tools = await getConnectedTools(mockCtx, 3);

    expect(mockCtx.getInputConnectionData).toHaveBeenCalledWith(NodeConnectionTypes.AiTool, 0);
    expect(tools).toHaveProperty('shared_tool');
  });

  it('flattens nested tool arrays', async () => {
    const { getConnectedTools } = await import('../utils/getConnectedTools');
    const tool1 = { name: 'tool_a', description: 'A', invoke: jest.fn().mockResolvedValue('a') };
    const tool2 = { name: 'tool_b', description: 'B', invoke: jest.fn().mockResolvedValue('b') };
    const mockCtx = {
      getInputConnectionData: jest.fn().mockResolvedValue([
        [tool1, tool2], // nested array (MCP toolkit)
      ]),
    } as unknown as import('n8n-workflow').IExecuteFunctions;

    const tools = await getConnectedTools(mockCtx);
    expect(Object.keys(tools)).toEqual(['tool_a', 'tool_b']);
  });

  it('executes a tool that only exposes func/call (no invoke)', async () => {
    const { getConnectedTools } = await import('../utils/getConnectedTools');
    const callFn = jest.fn().mockResolvedValue('called');
    // DynamicTool-style wrapper: has name + call, but no `invoke`.
    const toolWithCall = { name: 'legacy_tool', description: 'Legacy', call: callFn };
    const mockCtx = {
      getInputConnectionData: jest.fn().mockResolvedValue([toolWithCall]),
    } as unknown as import('n8n-workflow').IExecuteFunctions;

    const tools = await getConnectedTools(mockCtx);
    expect(Object.keys(tools)).toEqual(['legacy_tool']);

    const execute = (tools['legacy_tool'] as unknown as {
      execute: (args: Record<string, unknown>) => Promise<unknown>;
    }).execute;
    const result = await execute({ x: 1 });
    expect(callFn).toHaveBeenCalledWith({ x: 1 });
    expect(result).toBe('called');
  });

  it('expands a StructuredToolkit (MCP Client Tool) via getTools()', async () => {
    const { getConnectedTools } = await import('../utils/getConnectedTools');
    const mcpTool1 = { name: 'mcp_search', description: 'Search', invoke: jest.fn().mockResolvedValue('r1') };
    const mcpTool2 = { name: 'mcp_fetch', description: 'Fetch', invoke: jest.fn().mockResolvedValue('r2') };
    // Mimics n8n's StructuredToolkit: has getTools() + .tools, but no `name`.
    const toolkit = {
      tools: [mcpTool1, mcpTool2],
      getTools: () => [mcpTool1, mcpTool2],
    };
    const mockCtx = {
      // getInputConnectionData(AiTool) returns an array of supplyData responses.
      getInputConnectionData: jest.fn().mockResolvedValue([toolkit]),
    } as unknown as import('n8n-workflow').IExecuteFunctions;

    const tools = await getConnectedTools(mockCtx);
    expect(Object.keys(tools)).toEqual(['mcp_search', 'mcp_fetch']);
  });

  it('mixes plain tools and a toolkit in one connection', async () => {
    const { getConnectedTools } = await import('../utils/getConnectedTools');
    const plain = { name: 'calculator', description: 'Calc', invoke: jest.fn().mockResolvedValue('4') };
    const mcpTool = { name: 'mcp_list', description: 'List', invoke: jest.fn().mockResolvedValue('ok') };
    const toolkit = { tools: [mcpTool], getTools: () => [mcpTool] };
    const mockCtx = {
      getInputConnectionData: jest.fn().mockResolvedValue([plain, toolkit]),
    } as unknown as import('n8n-workflow').IExecuteFunctions;

    const tools = await getConnectedTools(mockCtx);
    expect(Object.keys(tools).sort()).toEqual(['calculator', 'mcp_list']);
  });

  it('preserves a zod schema from a differing zod instance (duck-typed)', async () => {
    const { getConnectedTools } = await import('../utils/getConnectedTools');
    // Simulate a zod schema produced by n8n's bundled (different) zod instance.
    const foreignZodSchema = {
      _def: { typeName: 'ZodObject' },
      parse: (v: unknown) => v,
      safeParse: (v: unknown) => ({ success: true, data: v }),
    };
    const mcpTool = {
      name: 'mcp_with_args',
      description: 'Takes args',
      schema: foreignZodSchema,
      invoke: jest.fn().mockResolvedValue('ok'),
    };
    const toolkit = { tools: [mcpTool], getTools: () => [mcpTool] };
    const mockCtx = {
      getInputConnectionData: jest.fn().mockResolvedValue([toolkit]),
    } as unknown as import('n8n-workflow').IExecuteFunctions;

    const tools = await getConnectedTools(mockCtx);
    // The schema object is forwarded as-is, not replaced with z.record fallback.
    expect((tools['mcp_with_args'] as { parameters: unknown }).parameters).toBe(foreignZodSchema);
  });
});

// --- getConnectedMemory tests ---

describe('getConnectedMemory', () => {
  it('returns null when no memory connected', async () => {
    const { getConnectedMemory } = await import('../utils/getConnectedMemory');
    const mockCtx = {
      getInputConnectionData: jest.fn().mockRejectedValue(new Error('no connection')),
    } as unknown as import('n8n-workflow').IExecuteFunctions;

    const memory = await getConnectedMemory(mockCtx);
    expect(memory).toBeNull();
  });

  it('returns memory when connected', async () => {
    const { getConnectedMemory } = await import('../utils/getConnectedMemory');
    const mockMemory = { chatHistory: { getMessages: jest.fn(), addMessage: jest.fn() } };
    const mockCtx = {
      getInputConnectionData: jest.fn().mockResolvedValue(mockMemory),
    } as unknown as import('n8n-workflow').IExecuteFunctions;

    const memory = await getConnectedMemory(mockCtx);
    expect(memory).toBe(mockMemory);
  });
});
