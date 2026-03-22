import type { CoreMessage } from 'ai';

// Slack Streaming API types
export interface SlackStreamChunk {
  type: 'markdown_text' | 'task_update' | 'plan_update';
}

export interface MarkdownTextChunk extends SlackStreamChunk {
  type: 'markdown_text';
  markdown_text: string;
}

export interface TaskUpdateChunk extends SlackStreamChunk {
  type: 'task_update';
  task: {
    task_id: string;
    title: string;
    status: 'pending' | 'in_progress' | 'complete' | 'error';
    details?: string;
    output?: Record<string, unknown>;
    sources?: Array<{ type: string; url: string; text: string }>;
  };
}

export interface PlanUpdateChunk extends SlackStreamChunk {
  type: 'plan_update';
  title: string;
}

export type StreamChunk = MarkdownTextChunk | TaskUpdateChunk | PlanUpdateChunk;

// Feedback blocks
export interface FeedbackBlock {
  type: 'context_actions';
  elements: Array<{
    type: 'feedback_buttons';
    action_id: string;
    positive_button: {
      text: { type: 'plain_text'; text: string };
      value: string;
    };
    negative_button: {
      text: { type: 'plain_text'; text: string };
      value: string;
    };
  }>;
}

// Node parameter types
export type TaskDisplayMode = 'timeline' | 'plan';
export type PromptSource = 'takePreviousNode' | 'defineBelow';

export interface IntermediateStep {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  result: unknown;
}

// Memory types
export interface MemoryAdapter {
  load(): Promise<CoreMessage[]>;
  save(messages: CoreMessage[]): Promise<void>;
}
