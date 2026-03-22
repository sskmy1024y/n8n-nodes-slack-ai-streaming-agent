import { SlackStreamManager } from '../nodes/SlackAiStreamingAgent/slack-stream';
import type { WebClient } from '@slack/web-api';

function createMockClient() {
  const apiCall = jest.fn<Promise<Record<string, unknown>>, [string, ...unknown[]]>();
  const postMessage = jest.fn<Promise<Record<string, unknown>>, [unknown]>();

  apiCall.mockImplementation(async (method: string) => {
    if (method === 'chat.startStream') {
      return { ok: true, ts: '1234567890.123456' };
    }
    return { ok: true };
  });

  postMessage.mockResolvedValue({ ok: true, ts: '1234567890.999999' });

  return {
    mock: {
      apiCall,
      chat: { postMessage },
    } as unknown as WebClient,
    apiCall,
    postMessage,
  };
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
    throttleMs: 0,
    ...overrides,
  });
}

// Helper to wait for async background operations
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe('SlackStreamManager', () => {
  beforeEach(() => {
    jest.useFakeTimers({ advanceTimers: true });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('basic lifecycle', () => {
    it('calls startStream on first appendText, then sends via appendStream on stop', async () => {
      const { mock, apiCall } = createMockClient();
      const manager = createManager(mock);

      manager.appendText('Hello');
      // startStream is called via void promise
      await jest.advanceTimersByTimeAsync(10);

      expect(apiCall).toHaveBeenCalledWith('chat.startStream', expect.objectContaining({
        channel: 'C123',
        chunks: [{ type: 'markdown_text', markdown_text: 'Hello' }],
      }));

      manager.appendText(' World');
      // Trigger the stream loop timer
      await jest.advanceTimersByTimeAsync(10);

      await manager.stop();

      expect(apiCall).toHaveBeenCalledWith('chat.stopStream', expect.objectContaining({
        channel: 'C123',
        message_ts: '1234567890.123456',
      }));
    });

    it('accumulates fullText and exposes via responseText', async () => {
      const { mock } = createMockClient();
      const manager = createManager(mock);

      manager.appendText('Hello');
      await jest.advanceTimersByTimeAsync(10);
      manager.appendText(' World');
      expect(manager.responseText).toBe('Hello World');
    });

    it('exposes messageTs after startStream', async () => {
      const { mock } = createMockClient();
      const manager = createManager(mock);

      expect(manager.messageTs).toBeNull();
      manager.appendText('Hello');
      await jest.advanceTimersByTimeAsync(10);
      expect(manager.messageTs).toBe('1234567890.123456');
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
    it('sends task_update chunk via appendStream', async () => {
      const { mock, apiCall } = createMockClient();
      const manager = createManager(mock);

      manager.appendText('Starting...');
      await jest.advanceTimersByTimeAsync(10);

      await manager.sendTaskUpdate('task_1', 'search_db', 'complete', 'Done');
      expect(apiCall).toHaveBeenCalledWith('chat.appendStream', expect.objectContaining({
        chunks: [{
          type: 'task_update',
          task: {
            task_id: 'task_1',
            title: 'search_db',
            status: 'complete',
            details: 'Done',
          },
        }],
      }));
    });

    it('does nothing when stream is not started', async () => {
      const { mock, apiCall } = createMockClient();
      const manager = createManager(mock);

      await manager.sendTaskUpdate('task_1', 'test', 'complete');
      expect(apiCall).not.toHaveBeenCalledWith('chat.appendStream', expect.anything());
    });
  });

  describe('fallback to postMessage', () => {
    it('falls back when startStream fails', async () => {
      const { mock, apiCall, postMessage } = createMockClient();
      apiCall.mockRejectedValueOnce(new Error('startStream error'));
      const manager = createManager(mock);

      manager.appendText('Hello');
      await jest.advanceTimersByTimeAsync(10);
      await manager.stop();

      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'C123',
        thread_ts: '1700000000.000000',
        text: 'Hello',
      }));
    });

    it('falls back when startStream returns ok:false', async () => {
      const { mock, apiCall, postMessage } = createMockClient();
      apiCall.mockResolvedValueOnce({ ok: false, error: 'not_allowed' });
      const manager = createManager(mock);

      manager.appendText('Hello');
      await jest.advanceTimersByTimeAsync(10);
      await manager.stop();

      expect(postMessage).toHaveBeenCalled();
    });

    it('always accumulates fullText even when in fallback mode', async () => {
      const { mock, apiCall } = createMockClient();
      apiCall.mockRejectedValueOnce(new Error('fail'));
      const manager = createManager(mock);

      manager.appendText('Hello');
      await jest.advanceTimersByTimeAsync(10);
      manager.appendText(' World');
      manager.appendText('!');

      expect(manager.responseText).toBe('Hello World!');
    });
  });

  describe('feedback blocks', () => {
    it('includes feedback blocks in stopStream when enabled', async () => {
      const { mock, apiCall } = createMockClient();
      const manager = createManager(mock, { enableFeedback: true });

      manager.appendText('Response');
      await jest.advanceTimersByTimeAsync(10);
      await manager.stop();

      expect(apiCall).toHaveBeenCalledWith('chat.stopStream', expect.objectContaining({
        blocks: [expect.objectContaining({
          type: 'context_actions',
        })],
      }));
    });

    it('does not include feedback blocks when disabled', async () => {
      const { mock, apiCall } = createMockClient();
      const manager = createManager(mock, { enableFeedback: false });

      manager.appendText('Response');
      await jest.advanceTimersByTimeAsync(10);
      await manager.stop();

      const stopCall = apiCall.mock.calls.find((c) => c[0] === 'chat.stopStream');
      expect(stopCall).toBeDefined();
      expect((stopCall![1] as Record<string, unknown>)['blocks']).toBeUndefined();
    });
  });

  describe('stop idempotency', () => {
    it('only stops once even if called multiple times', async () => {
      const { mock, apiCall } = createMockClient();
      const manager = createManager(mock);

      manager.appendText('Hello');
      await jest.advanceTimersByTimeAsync(10);
      await manager.stop();
      await manager.stop();

      const stopCalls = apiCall.mock.calls.filter((c) => c[0] === 'chat.stopStream');
      expect(stopCalls).toHaveLength(1);
    });
  });

  describe('stop without start', () => {
    it('does not call postMessage when no text was generated', async () => {
      const { mock, postMessage } = createMockClient();
      const manager = createManager(mock);

      await manager.stop();
      expect(postMessage).not.toHaveBeenCalled();
    });
  });

  describe('non-blocking streaming', () => {
    it('appendText returns immediately without waiting for Slack API', () => {
      const { mock } = createMockClient();
      const manager = createManager(mock);

      // appendText should be synchronous (void return)
      const result = manager.appendText('Hello');
      expect(result).toBeUndefined();
    });
  });
});
