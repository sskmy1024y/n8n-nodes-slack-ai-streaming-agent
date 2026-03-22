import type { WebClient } from '@slack/web-api';
import type { StreamChunk, TaskDisplayMode, FeedbackBlock } from './types';

/**
 * Throttler that buffers text chunks and flushes them at a minimum interval.
 */
class SlackStreamThrottler {
  private buffer = '';
  private lastSendTime = 0;
  private minInterval: number;
  private pendingFlush: Promise<void> | null = null;

  constructor(minIntervalMs = 100) {
    this.minInterval = minIntervalMs;
  }

  async append(text: string, sendFn: (text: string) => Promise<void>): Promise<void> {
    this.buffer += text;
    const now = Date.now();
    if (now - this.lastSendTime >= this.minInterval && this.buffer.length > 0) {
      const chunk = this.buffer;
      this.buffer = '';
      this.lastSendTime = now;
      await sendFn(chunk);
    }
  }

  async flush(sendFn: (text: string) => Promise<void>): Promise<void> {
    if (this.pendingFlush) {
      await this.pendingFlush;
    }
    if (this.buffer.length > 0) {
      const chunk = this.buffer;
      this.buffer = '';
      this.lastSendTime = Date.now();
      await sendFn(chunk);
    }
  }
}

export interface SlackStreamManagerOptions {
  client: WebClient;
  channel: string;
  threadTs: string;
  recipientUserId: string;
  recipientTeamId: string;
  taskDisplayMode?: TaskDisplayMode;
  throttleMs?: number;
  enableFeedback?: boolean;
}

/**
 * Manages the lifecycle of a Slack streaming message.
 * Handles startStream → appendStream × N → stopStream with throttling and fallback.
 */
export class SlackStreamManager {
  private client: WebClient;
  private channel: string;
  private threadTs: string;
  private recipientUserId: string;
  private recipientTeamId: string;
  private taskDisplayMode: TaskDisplayMode;
  private throttler: SlackStreamThrottler;
  private enableFeedback: boolean;

  private streamTs: string | null = null;
  private fullText = '';
  private isStarted = false;
  private isStopped = false;
  private useFallback = false;

  constructor(options: SlackStreamManagerOptions) {
    this.client = options.client;
    this.channel = options.channel;
    this.threadTs = options.threadTs;
    this.recipientUserId = options.recipientUserId;
    this.recipientTeamId = options.recipientTeamId;
    this.taskDisplayMode = options.taskDisplayMode ?? 'timeline';
    this.throttler = new SlackStreamThrottler(options.throttleMs ?? 100);
    this.enableFeedback = options.enableFeedback ?? false;
  }

  get messageTs(): string | null {
    return this.streamTs;
  }

  get responseText(): string {
    return this.fullText;
  }

  /**
   * Set the assistant thread status (e.g. "thinking...").
   */
  async setStatus(status: string): Promise<void> {
    try {
      await this.client.apiCall('assistant.threads.setStatus', {
        channel_id: this.channel,
        thread_ts: this.threadTs,
        status,
      });
    } catch (error) {
      // Status is non-critical, don't fail the stream
      console.warn('Failed to set assistant status:', error);
    }
  }

  /**
   * Set the thread title.
   */
  async setTitle(title: string): Promise<void> {
    try {
      await this.client.apiCall('assistant.threads.setTitle', {
        channel_id: this.channel,
        thread_ts: this.threadTs,
        title,
      });
    } catch (error) {
      console.warn('Failed to set thread title:', error);
    }
  }

  /**
   * Append a text delta to the stream. Automatically starts the stream on first call.
   */
  async appendText(delta: string): Promise<void> {
    if (this.isStopped || this.useFallback) return;

    this.fullText += delta;

    if (!this.isStarted) {
      await this.startStream(delta);
      return;
    }

    await this.throttler.append(delta, async (text) => {
      try {
        await this.client.apiCall('chat.appendStream', {
          channel: this.channel,
          message_ts: this.streamTs,
          thread_ts: this.threadTs,
          chunks: [{ type: 'markdown_text', markdown_text: text }],
        });
      } catch (error) {
        console.warn('appendStream failed, will use fallback:', error);
        this.useFallback = true;
      }
    });
  }

  /**
   * Send a task_update chunk (for tool execution status).
   */
  async sendTaskUpdate(
    taskId: string,
    title: string,
    status: 'pending' | 'in_progress' | 'complete' | 'error',
    details?: string,
  ): Promise<void> {
    if (!this.streamTs || this.isStopped || this.useFallback) return;

    // Flush pending text first to maintain ordering
    await this.throttler.flush(async (text) => {
      try {
        await this.client.apiCall('chat.appendStream', {
          channel: this.channel,
          message_ts: this.streamTs,
          thread_ts: this.threadTs,
          chunks: [{ type: 'markdown_text', markdown_text: text }],
        });
      } catch {
        this.useFallback = true;
      }
    });

    if (this.useFallback) return;

    try {
      const chunk: StreamChunk = {
        type: 'task_update',
        task: {
          task_id: taskId,
          title,
          status,
          ...(details ? { details } : {}),
        },
      };
      await this.client.apiCall('chat.appendStream', {
        channel: this.channel,
        message_ts: this.streamTs,
        thread_ts: this.threadTs,
        chunks: [chunk],
      });
    } catch (error) {
      console.warn('task_update appendStream failed:', error);
    }
  }

  /**
   * Stop the stream and finalize the message.
   */
  async stop(): Promise<void> {
    if (this.isStopped) return;
    this.isStopped = true;

    // If we never started (no text generated), use fallback
    if (!this.isStarted || this.useFallback) {
      await this.postFallbackMessage();
      return;
    }

    // Flush remaining buffer
    await this.throttler.flush(async (text) => {
      try {
        await this.client.apiCall('chat.appendStream', {
          channel: this.channel,
          message_ts: this.streamTs,
          thread_ts: this.threadTs,
          chunks: [{ type: 'markdown_text', markdown_text: text }],
        });
      } catch {
        this.useFallback = true;
      }
    });

    if (this.useFallback) {
      await this.postFallbackMessage();
      return;
    }

    try {
      const blocks = this.enableFeedback ? this.buildFeedbackBlocks() : undefined;
      await this.client.apiCall('chat.stopStream', {
        channel: this.channel,
        message_ts: this.streamTs,
        thread_ts: this.threadTs,
        chunks: [],
        ...(blocks ? { blocks } : {}),
      });
    } catch (error) {
      console.warn('stopStream failed, using fallback:', error);
      await this.postFallbackMessage();
    }

    // Clear the status
    await this.setStatus('');
  }

  private async startStream(firstChunk: string): Promise<void> {
    try {
      const response = await this.client.apiCall('chat.startStream', {
        channel: this.channel,
        thread_ts: this.threadTs,
        recipient_team_id: this.recipientTeamId,
        recipient_user_id: this.recipientUserId,
        task_display_mode: this.taskDisplayMode,
        chunks: [{ type: 'markdown_text', markdown_text: firstChunk }],
      });

      const result = response as { ok: boolean; ts?: string; error?: string };
      if (result.ok && result.ts) {
        this.streamTs = result.ts;
        this.isStarted = true;
      } else {
        console.warn('startStream returned error:', result.error);
        this.useFallback = true;
      }
    } catch (error) {
      console.warn('startStream failed, using fallback:', error);
      this.useFallback = true;
    }
  }

  /**
   * Fallback: post the full response as a regular message.
   */
  private async postFallbackMessage(): Promise<void> {
    if (!this.fullText) return;

    try {
      const response = await this.client.chat.postMessage({
        channel: this.channel,
        thread_ts: this.threadTs,
        text: this.fullText,
        ...(this.enableFeedback ? { blocks: this.buildFeedbackBlocks() } : {}),
      });
      this.streamTs = response.ts ?? null;
    } catch (error) {
      console.error('Fallback postMessage also failed:', error);
    }
  }

  private buildFeedbackBlocks(): FeedbackBlock[] {
    return [
      {
        type: 'context_actions',
        elements: [
          {
            type: 'feedback_buttons',
            action_id: 'feedback',
            positive_button: {
              text: { type: 'plain_text', text: 'Good Response' },
              value: 'good-feedback',
            },
            negative_button: {
              text: { type: 'plain_text', text: 'Bad Response' },
              value: 'bad-feedback',
            },
          },
        ],
      },
    ];
  }
}
