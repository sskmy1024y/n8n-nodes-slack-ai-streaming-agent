import type { CoreMessage } from 'ai';

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

export interface IntermediateStep {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface MemoryAdapter {
  load(): Promise<CoreMessage[]>;
  save(messages: CoreMessage[]): Promise<void>;
}
