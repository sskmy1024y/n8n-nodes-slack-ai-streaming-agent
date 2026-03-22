import { SlackStreamManager } from '../nodes/SlackAiStreamingAgent/slack-stream';
import type { WebClient } from '@slack/web-api';

function createMockStreamer() {
  const appendCalls: unknown[] = [];
  let stopCalled = false;

  return {
    instance: {
      append: jest.fn(async (args: unknown) => {
        appendCalls.push(args);
        return { ok: true };
      }),
      stop: jest.fn(async (args?: unknown) => {
        stopCalled = true;
        return { ok: true };
      }),
    },
    appendCalls,
    get stopCalled() { return stopCalled; },
  };
}

function createMockClient() {
  const apiCall = jest.fn<Promise<Record<string, unknown>>, [string, ...unknown[]]>();
  const postMessage = jest.fn<Promise<Record<string, unknown>>, [unknown]>();
  const mockStreamer = createMockStreamer();

  apiCall.mockResolvedValue({ ok: true });
  postMessage.mockResolvedValue({ ok: true, ts: '1234567890.999999' });

  const mock = {
    apiCall,
    chat: { postMessage },
    chatStream: jest.fn(() => mockStreamer.instance),
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  } as unknown as WebClient;

  return { mock, apiCall, postMessage, mockStreamer };
}

function createManager(
  client: WebClient,
  overrides: Partial<ConstructorParameters<typeof SlackStreamManager>[0]> = {},
) {
  return new SlackStreamManager({
    client,
    channel: 'C123',
    threadTs: '1700000000.000000',
    recipientUserId: 'U123',
    recipientTeamId: 'T123',
    bufferSize: 64,
    ...overrides,
  });
}

describe('SlackStreamManager', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('constructor', () => {
    it('creates a ChatStreamer via client.chatStream', () => {
      const { mock } = createMockClient();
      createManager(mock);

      expect((mock.chatStream as jest.Mock)).toHaveBeenCalledWith({
        channel: 'C123',
        thread_ts: '1700000000.000000',
        recipient_team_id: 'T123',
        recipient_user_id: 'U123',
        buffer_size: 64,
      });
    });
  });

  describe('appendText', () => {
    it('is synchronous (returns void)', () => {
      const { mock } = createMockClient();
      const manager = createManager(mock);
      const result = manager.appendText('Hello');
      expect(result).toBeUndefined();
    });

    it('accumulates fullText', () => {
      const { mock } = createMockClient();
      const manager = createManager(mock);
      manager.appendText('Hello');
      manager.appendText(' World');
      expect(manager.responseText).toBe('Hello World');
    });

    it('queues append calls to the ChatStreamer', async () => {
      const { mock, mockStreamer } = createMockClient();
      const manager = createManager(mock);

      manager.appendText('Hello');
      manager.appendText(' World');
      await manager.stop();

      expect(mockStreamer.instance.append).toHaveBeenCalledWith({ markdown_text: 'Hello' });
      expect(mockStreamer.instance.append).toHaveBeenCalledWith({ markdown_text: ' World' });
    });

    it('always accumulates text even after fallback', () => {
      const { mock, mockStreamer } = createMockClient();
      mockStreamer.instance.append.mockRejectedValueOnce(new Error('fail'));
      const manager = createManager(mock);

      manager.appendText('Hello');
      manager.appendText(' World');

      expect(manager.responseText).toBe('Hello World');
    });
  });

  describe('setStatus', () => {
    it('calls assistant.threads.setStatus', async () => {
      const { mock, apiCall } = createMockClient();
      const manager = createManager(mock);

      await manager.setStatus('thinking...');
      expect(apiCall).toHaveBeenCalledWith('assistant.threads.setStatus', {
        channel_id: 'C123',
        thread_ts: '1700000000.000000',
        status: 'thinking...',
      });
    });

    it('does not throw on API error', async () => {
      const { mock, apiCall } = createMockClient();
      apiCall.mockRejectedValueOnce(new Error('API error'));
      const manager = createManager(mock);
      await expect(manager.setStatus('test')).resolves.toBeUndefined();
    });
  });

  describe('setTitle', () => {
    it('calls assistant.threads.setTitle', async () => {
      const { mock, apiCall } = createMockClient();
      const manager = createManager(mock);

      await manager.setTitle('My Thread');
      expect(apiCall).toHaveBeenCalledWith('assistant.threads.setTitle', {
        channel_id: 'C123',
        thread_ts: '1700000000.000000',
        title: 'My Thread',
      });
    });
  });

  describe('sendTaskUpdate', () => {
    it('sends task_update chunk via ChatStreamer', async () => {
      const { mock, mockStreamer } = createMockClient();
      const manager = createManager(mock);

      await manager.sendTaskUpdate('task_1', 'search_db', 'complete', 'Done');

      expect(mockStreamer.instance.append).toHaveBeenCalledWith({
        chunks: [{
          type: 'task_update',
          id: 'task_1',
          title: 'search_db',
          status: 'complete',
          details: 'Done',
        }],
      });
    });
  });

  describe('stop', () => {
    it('waits for queued appends then calls streamer.stop', async () => {
      const { mock, mockStreamer } = createMockClient();
      const manager = createManager(mock);

      manager.appendText('Hello');
      await manager.stop();

      expect(mockStreamer.instance.append).toHaveBeenCalled();
      expect(mockStreamer.instance.stop).toHaveBeenCalled();
    });

    it('includes feedback blocks when enabled', async () => {
      const { mock, mockStreamer } = createMockClient();
      const manager = createManager(mock, { enableFeedback: true });

      manager.appendText('Response');
      await manager.stop();

      expect(mockStreamer.instance.stop).toHaveBeenCalledWith({
        blocks: [expect.objectContaining({ type: 'context_actions' })],
      });
    });

    it('does not include feedback blocks when disabled', async () => {
      const { mock, mockStreamer } = createMockClient();
      const manager = createManager(mock, { enableFeedback: false });

      manager.appendText('Response');
      await manager.stop();

      expect(mockStreamer.instance.stop).toHaveBeenCalledWith({});
    });

    it('is idempotent', async () => {
      const { mock, mockStreamer } = createMockClient();
      const manager = createManager(mock);

      manager.appendText('Hello');
      await manager.stop();
      await manager.stop();

      expect(mockStreamer.instance.stop).toHaveBeenCalledTimes(1);
    });

    it('falls back to postMessage on streamer error', async () => {
      const { mock, mockStreamer, postMessage } = createMockClient();
      mockStreamer.instance.stop.mockRejectedValueOnce(new Error('fail'));
      const manager = createManager(mock);

      manager.appendText('Hello');
      await manager.stop();

      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
        text: 'Hello',
      }));
    });
  });

  describe('stop without text', () => {
    it('does not call postMessage when no text was generated', async () => {
      const { mock, postMessage } = createMockClient();
      const manager = createManager(mock);

      await manager.stop();
      expect(postMessage).not.toHaveBeenCalled();
    });
  });
});
