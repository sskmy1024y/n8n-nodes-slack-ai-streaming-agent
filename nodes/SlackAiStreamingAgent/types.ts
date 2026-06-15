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

export type PromptSource = 'takePreviousNode' | 'defineBelow';

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | Array<Record<string, unknown>> }
  | { role: 'tool'; content: Array<Record<string, unknown>> };

export interface IntermediateStep {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface MemoryAdapter {
  load(): Promise<ChatMessage[]>;
  save(messages: ChatMessage[]): Promise<void>;
}

export interface AgentStreamManager {
  readonly responseText: string;
  appendText(delta: string): void;
  sendTaskUpdate(
    taskId: string,
    title: string,
    status: 'pending' | 'in_progress' | 'complete' | 'error',
    details?: string,
  ): Promise<void>;
}
