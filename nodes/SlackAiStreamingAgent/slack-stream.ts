import { WebClient } from '@slack/web-api';
import type { ChatStreamer } from '@slack/web-api';
import type { AnyChunk, TaskUpdateChunk } from '@slack/types';
import type { TaskDisplayMode, FeedbackBlock } from './types';

export interface SlackStreamManagerOptions {
  client: WebClient;
  channel: string;
  threadTs: string;
  recipientUserId: string;
  recipientTeamId: string;
  taskDisplayMode?: TaskDisplayMode;
  /** ChatStreamer buffer size in characters. Smaller = more frequent updates. */
  bufferSize?: number;
  enableFeedback?: boolean;
}

export class SlackStreamManager {
  private client: WebClient;
  private channel: string;
  private threadTs: string;
  private enableFeedback: boolean;

  private streamer: ChatStreamer;
  private appendQueue: Promise<unknown> = Promise.resolve();
  private fullText = '';
  private isStopped = false;
  private useFallback = false;

  constructor(options: SlackStreamManagerOptions) {
    this.client = options.client;
    this.channel = options.channel;
    this.threadTs = options.threadTs;
    this.enableFeedback = options.enableFeedback ?? false;

    // Create the official ChatStreamer — handles startStream/appendStream lifecycle
    this.streamer = this.client.chatStream({
      channel: options.channel,
      thread_ts: options.threadTs,
      recipient_team_id: options.recipientTeamId,
      recipient_user_id: options.recipientUserId,
      buffer_size: options.bufferSize ?? 64,
    });
  }

  get messageTs(): string | null {
    // ChatStreamer doesn't expose ts, but it's not needed for output
    return null;
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

  /**
   * Append a text delta. Returns immediately — Slack sends happen in the background
   * via a serialized queue backed by the official ChatStreamer.
   */
  appendText(delta: string): void {
    this.fullText += delta;

    if (this.isStopped || this.useFallback) return;

    // Queue the append — ChatStreamer buffers internally and auto-flushes
    // when the buffer reaches buffer_size characters
    this.appendQueue = this.appendQueue.then(() =>
      this.streamer.append({ markdown_text: delta }).catch(() => {
        this.useFallback = true;
      }),
    );
  }

  async sendTaskUpdate(
    taskId: string,
    title: string,
    status: 'pending' | 'in_progress' | 'complete' | 'error',
    details?: string,
  ): Promise<void> {
    if (this.isStopped || this.useFallback) return;

    const chunk: TaskUpdateChunk = {
      type: 'task_update',
      id: taskId,
      title,
      status,
      ...(details ? { details } : {}),
    };

    // Wait for pending appends, then send the task update
    await this.appendQueue;
    if (this.useFallback) return;

    this.appendQueue = this.streamer
      .append({ chunks: [chunk] as AnyChunk[] })
      .catch(() => {
        this.useFallback = true;
      });
    await this.appendQueue;
  }

  async stop(): Promise<void> {
    if (this.isStopped) return;
    this.isStopped = true;

    // Wait for all queued appends to complete
    await this.appendQueue;

    if (this.useFallback) {
      await this.postFallbackMessage();
      return;
    }

    try {
      const blocks = this.enableFeedback ? this.buildFeedbackBlocks() : undefined;
      await this.streamer.stop({
        ...(blocks ? { blocks } : {}),
      });
    } catch {
      await this.postFallbackMessage();
    }

    await this.setStatus('');
  }

  private async postFallbackMessage(): Promise<void> {
    if (!this.fullText) return;

    try {
      await this.client.chat.postMessage({
        channel: this.channel,
        thread_ts: this.threadTs,
        text: this.fullText,
        ...(this.enableFeedback ? { blocks: this.buildFeedbackBlocks() } : {}),
      });
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
