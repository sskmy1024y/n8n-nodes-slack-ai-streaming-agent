import { SlackStreamManager } from '../nodes/SlackAiStreamingAgent/slack-stream';
import type { WebClient } from '@slack/web-api';

function createMockClient() {
  const apiCall = jest.fn<Promise<Record<string, unknown>>, [string, ...unknown[]]>();
  const postMessage = jest.fn<Promise<Record<string, unknown>>, [unknown]>();

  // Default: startStream succeeds
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
    throttleMs: 0, // disable throttling for tests
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

  describe('basic lifecycle: startStream → appendStream → stopStream', () => {
    it('calls startStream on first appendText, then appendStream, then stopStream', async () => {
      const { mock, apiCall } = createMockClient();
      const manager = createManager(mock);

      // First chunk → startStream
      await manager.appendText('Hello');
      expect(apiCall).toHaveBeenCalledWith('chat.startStream', expect.objectContaining({
        channel: 'C123',
        thread_ts: '1700000000.000000',
        recipient_team_id: 'T123',
        recipient_user_id: 'U123',
        chunks: [{ type: 'markdown_text', markdown_text: 'Hello' }],
      }));

      // Second chunk → appendStream
      await manager.appendText(' World');
      expect(apiCall).toHaveBeenCalledWith('chat.appendStream', expect.objectContaining({
        channel: 'C123',
        message_ts: '1234567890.123456',
        chunks: [{ type: 'markdown_text', markdown_text: ' World' }],
      }));

      // Stop
      await manager.stop();
      expect(apiCall).toHaveBeenCalledWith('chat.stopStream', expect.objectContaining({
        channel: 'C123',
        message_ts: '1234567890.123456',
        chunks: [],
      }));
    });

    it('accumulates fullText and exposes via responseText', async () => {
      const { mock } = createMockClient();
      const manager = createManager(mock);

      await manager.appendText('Hello');
      await manager.appendText(' World');
      expect(manager.responseText).toBe('Hello World');
    });

    it('exposes messageTs after startStream', async () => {
      const { mock } = createMockClient();
      const manager = createManager(mock);

      expect(manager.messageTs).toBeNull();
      await manager.appendText('Hello');
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

      // Start stream first
      await manager.appendText('Starting...');

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
      // Only no calls (no startStream was called, streamTs is null)
      expect(apiCall).not.toHaveBeenCalledWith('chat.appendStream', expect.anything());
    });
  });

  describe('fallback to postMessage', () => {
    it('falls back when startStream fails', async () => {
      const { mock, apiCall, postMessage } = createMockClient();
      apiCall.mockRejectedValueOnce(new Error('startStream error'));
      const manager = createManager(mock);

      await manager.appendText('Hello');
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

      await manager.appendText('Hello');
      await manager.stop();

      expect(postMessage).toHaveBeenCalled();
    });

    it('falls back when appendStream fails', async () => {
      const { mock, apiCall, postMessage } = createMockClient();
      // startStream succeeds
      apiCall.mockResolvedValueOnce({ ok: true, ts: '123.456' });
      // appendStream fails
      apiCall.mockRejectedValueOnce(new Error('append error'));
      const manager = createManager(mock);

      await manager.appendText('Hello');  // startStream
      await manager.appendText(' World'); // appendStream → fails

      await manager.stop();
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
        text: 'Hello World',
      }));
    });
  });

  describe('feedback blocks', () => {
    it('includes feedback blocks in stopStream when enabled', async () => {
      const { mock, apiCall } = createMockClient();
      const manager = createManager(mock, { enableFeedback: true });

      await manager.appendText('Response');
      await manager.stop();

      expect(apiCall).toHaveBeenCalledWith('chat.stopStream', expect.objectContaining({
        blocks: [expect.objectContaining({
          type: 'context_actions',
          elements: [expect.objectContaining({
            type: 'feedback_buttons',
          })],
        })],
      }));
    });

    it('does not include feedback blocks when disabled', async () => {
      const { mock, apiCall } = createMockClient();
      const manager = createManager(mock, { enableFeedback: false });

      await manager.appendText('Response');
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

      await manager.appendText('Hello');
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

  describe('throttling', () => {
    it('buffers rapid appends and includes remaining in stopStream', async () => {
      const { mock, apiCall } = createMockClient();
      // Use a large throttle interval
      const manager = createManager(mock, { throttleMs: 10000 });

      await manager.appendText('Hello');  // startStream

      // The first appendText after startStream sends immediately because
      // lastSendTime starts at 0, so the interval check passes.
      await manager.appendText(' ');      // sent immediately (first append after start)
      await manager.appendText('World');  // buffered (within throttle window)
      await manager.appendText('!');      // buffered

      // After first two sends (startStream + one append), rest should be buffered
      const appendCallsBefore = apiCall.mock.calls.filter((c) => c[0] === 'chat.appendStream');
      expect(appendCallsBefore).toHaveLength(1); // only the ' ' was sent

      // Stop flushes remaining buffer via appendStream before calling stopStream
      await manager.stop();
      const allAppendCalls = apiCall.mock.calls.filter((c) => c[0] === 'chat.appendStream');
      expect(allAppendCalls).toHaveLength(2); // ' ' + 'World!'
      expect((allAppendCalls[1][1] as Record<string, unknown>)['chunks']).toEqual([
        { type: 'markdown_text', markdown_text: 'World!' },
      ]);
    });
  });
});
