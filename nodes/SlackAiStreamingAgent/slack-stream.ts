import type { WebClient } from '@slack/web-api';
import type { StreamChunk, TaskDisplayMode, FeedbackBlock } from './types';

/**
 * Non-blocking stream loop inspired by OpenClaw's draft-stream-loop.
 * Accumulates text and sends it to Slack at throttled intervals.
 * The `update()` call returns immediately — sends happen in the background.
 */
class StreamLoop {
  private pendingText = '';
  private inFlightPromise: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private throttleMs: number;
  private sendFn: (text: string) => Promise<void>;
  private stopped = false;

  constructor(throttleMs: number, sendFn: (text: string) => Promise<void>) {
    this.throttleMs = throttleMs;
    this.sendFn = sendFn;
  }

  update(text: string): void {
    this.pendingText += text;
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlightPromise) {
      await this.inFlightPromise;
    }
    await this.drainPending();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleFlush(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drainPending();
    }, this.throttleMs);
  }

  private async drainPending(): Promise<void> {
    if (this.pendingText.length === 0) return;

    if (this.inFlightPromise) {
      await this.inFlightPromise;
    }

    const text = this.pendingText;
    this.pendingText = '';

    this.inFlightPromise = this.sendFn(text);
    try {
      await this.inFlightPromise;
    } finally {
      this.inFlightPromise = null;
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

export class SlackStreamManager {
  private client: WebClient;
  private channel: string;
  private threadTs: string;
  private recipientUserId: string;
  private recipientTeamId: string;
  private taskDisplayMode: TaskDisplayMode;
  private throttleMs: number;
  private enableFeedback: boolean;

  private streamLoop: StreamLoop | null = null;
  private streamTs: string | null = null;
  private fullText = '';
  private isStopped = false;
  private useFallback = false;

  // Guards against multiple startStream calls during async initialization
  private startStreamPromise: Promise<void> | null = null;
  private preStreamBuffer: string[] = [];

  constructor(options: SlackStreamManagerOptions) {
    this.client = options.client;
    this.channel = options.channel;
    this.threadTs = options.threadTs;
    this.recipientUserId = options.recipientUserId;
    this.recipientTeamId = options.recipientTeamId;
    this.taskDisplayMode = options.taskDisplayMode ?? 'timeline';
    this.throttleMs = options.throttleMs ?? 100;
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

  /**
   * Append a text delta. Returns immediately — Slack sends happen in the background.
   */
  appendText(delta: string): void {
    this.fullText += delta;

    if (this.isStopped || this.useFallback) return;

    // Stream already initialized → feed the loop
    if (this.streamTs && this.streamLoop) {
      this.streamLoop.update(delta);
      return;
    }

    // Stream is being initialized → buffer for later
    if (this.startStreamPromise) {
      this.preStreamBuffer.push(delta);
      return;
    }

    // First token → start the stream
    this.startStreamPromise = this.initializeStream(delta);
  }

  async sendTaskUpdate(
    taskId: string,
    title: string,
    status: 'pending' | 'in_progress' | 'complete' | 'error',
    details?: string,
  ): Promise<void> {
    // Wait for stream to be ready
    if (this.startStreamPromise) {
      await this.startStreamPromise;
    }

    if (!this.streamTs || this.isStopped || this.useFallback) return;

    if (this.streamLoop) {
      await this.streamLoop.flush();
    }

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

    // Wait for stream initialization to complete
    if (this.startStreamPromise) {
      await this.startStreamPromise;
    }

    if (!this.streamTs || this.useFallback) {
      if (this.streamLoop) this.streamLoop.stop();
      await this.postFallbackMessage();
      return;
    }

    // Flush remaining buffered text
    if (this.streamLoop) {
      await this.streamLoop.flush();
      this.streamLoop.stop();
    }

    if (this.useFallback) {
      await this.postFallbackMessage();
      return;
    }

    // Brief delay to ensure Slack processes the last appendStream
    await new Promise((resolve) => setTimeout(resolve, 150));

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

  /**
   * Initialize the stream: call startStream, create the StreamLoop,
   * and flush any tokens that arrived during initialization.
   */
  private async initializeStream(firstChunk: string): Promise<void> {
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

        // Create the stream loop for subsequent tokens
        this.streamLoop = new StreamLoop(this.throttleMs, (text) =>
          this.sendAppendStream([{ type: 'markdown_text', markdown_text: text }]),
        );

        // Flush tokens that arrived while startStream was in progress
        if (this.preStreamBuffer.length > 0) {
          const buffered = this.preStreamBuffer.join('');
          this.preStreamBuffer = [];
          this.streamLoop.update(buffered);
        }
      } else {
        this.useFallback = true;
      }
    } catch {
      this.useFallback = true;
    }
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
