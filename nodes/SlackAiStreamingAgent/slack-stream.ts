import type { WebClient } from '@slack/web-api';
import type { StreamChunk, TaskDisplayMode, FeedbackBlock } from './types';

class SlackStreamThrottler {
  private buffer = '';
  private lastSendTime = 0;
  private minInterval: number;

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
    if (this.buffer.length > 0) {
      const chunk = this.buffer;
      this.buffer = '';
      this.lastSendTime = Date.now();
      await sendFn(chunk);
    }
  }

  drain(): string {
    const remaining = this.buffer;
    this.buffer = '';
    return remaining;
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

  async setStatus(status: string): Promise<void> {
    try {
      await this.client.apiCall('assistant.threads.setStatus', {
        channel_id: this.channel,
        thread_ts: this.threadTs,
        status,
      });
    } catch {
      // Non-critical
    }
  }

  async setTitle(title: string): Promise<void> {
    try {
      await this.client.apiCall('assistant.threads.setTitle', {
        channel_id: this.channel,
        thread_ts: this.threadTs,
        title,
      });
    } catch {
      // Non-critical
    }
  }

  async appendText(delta: string): Promise<void> {
    // Always accumulate text regardless of streaming state
    this.fullText += delta;

    if (this.isStopped || this.useFallback) return;

    if (!this.streamTs) {
      await this.startStream(delta);
      return;
    }

    await this.throttler.append(delta, (text) =>
      this.sendAppendStream([{ type: 'markdown_text', markdown_text: text }]),
    );
  }

  async sendTaskUpdate(
    taskId: string,
    title: string,
    status: 'pending' | 'in_progress' | 'complete' | 'error',
    details?: string,
  ): Promise<void> {
    if (!this.streamTs || this.isStopped || this.useFallback) return;

    // Flush pending text first to maintain ordering
    await this.throttler.flush((text) =>
      this.sendAppendStream([{ type: 'markdown_text', markdown_text: text }]),
    );

    if (this.useFallback) return;

    const chunk: StreamChunk = {
      type: 'task_update',
      task: {
        task_id: taskId,
        title,
        status,
        ...(details ? { details } : {}),
      },
    };
    await this.sendAppendStream([chunk]);
  }

  async stop(): Promise<void> {
    if (this.isStopped) return;
    this.isStopped = true;

    if (!this.streamTs || this.useFallback) {
      await this.postFallbackMessage();
      return;
    }

    // Flush remaining buffer via appendStream, then wait briefly before stopping.
    // stopStream's chunks param is unreliable for final text delivery.
    const remaining = this.throttler.drain();
    if (remaining.length > 0) {
      await this.sendAppendStream([{ type: 'markdown_text', markdown_text: remaining }]);
    }

    // Small delay to ensure Slack processes the last appendStream before stopping
    await new Promise((resolve) => setTimeout(resolve, 200));

    try {
      const blocks = this.enableFeedback ? this.buildFeedbackBlocks() : undefined;
      await this.client.apiCall('chat.stopStream', {
        channel: this.channel,
        message_ts: this.streamTs,
        thread_ts: this.threadTs,
        chunks: [],
        ...(blocks ? { blocks } : {}),
      });
    } catch {
      await this.postFallbackMessage();
    }

    await this.setStatus('');
  }

  private async sendAppendStream(chunks: unknown[]): Promise<void> {
    try {
      await this.client.apiCall('chat.appendStream', {
        channel: this.channel,
        message_ts: this.streamTs,
        thread_ts: this.threadTs,
        chunks,
      });
    } catch {
      this.useFallback = true;
    }
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
      } else {
        this.useFallback = true;
      }
    } catch {
      this.useFallback = true;
    }
  }

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
    } catch {
      // Last resort failed
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
