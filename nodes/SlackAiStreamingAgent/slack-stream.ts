import { WebClient } from '@slack/web-api';
import type { ChatStreamer } from '@slack/web-api';
import type { AnyChunk, TaskUpdateChunk } from '@slack/types';
import type { FeedbackBlock } from './types';

const FEEDBACK_BLOCKS: FeedbackBlock[] = [
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

export interface SlackStreamManagerOptions {
  client: WebClient;
  channel: string;
  threadTs: string;
  recipientUserId: string;
  recipientTeamId: string;
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
  private textChunks: string[] = [];
  private isStopped = false;
  private useFallback = false;

  constructor(options: SlackStreamManagerOptions) {
    this.client = options.client;
    this.channel = options.channel;
    this.threadTs = options.threadTs;
    this.enableFeedback = options.enableFeedback ?? false;

    this.streamer = this.client.chatStream({
      channel: options.channel,
      thread_ts: options.threadTs,
      recipient_team_id: options.recipientTeamId,
      recipient_user_id: options.recipientUserId,
      buffer_size: options.bufferSize ?? 64,
    });
  }

  get responseText(): string {
    return this.textChunks.join('');
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

  appendText(delta: string): void {
    this.textChunks.push(delta);

    if (this.isStopped || this.useFallback) return;

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

    await this.appendQueue;

    if (this.useFallback) {
      await this.postFallbackMessage();
      return;
    }

    try {
      await this.streamer.stop({
        ...(this.enableFeedback ? { blocks: FEEDBACK_BLOCKS } : {}),
      });
    } catch {
      await this.postFallbackMessage();
    }

    await this.setStatus('');
  }

  private async postFallbackMessage(): Promise<void> {
    const text = this.responseText;
    if (!text) return;

    try {
      await this.client.chat.postMessage({
        channel: this.channel,
        thread_ts: this.threadTs,
        text,
        ...(this.enableFeedback ? { blocks: FEEDBACK_BLOCKS } : {}),
      });
    } catch {
      // Last resort failed
    }
  }
}
