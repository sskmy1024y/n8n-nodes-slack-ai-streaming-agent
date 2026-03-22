import type { CoreMessage } from 'ai';
import type { N8nMemory } from './getConnectedMemory';
import type { MemoryAdapter } from '../nodes/SlackAiStreamingAgent/types';

/**
 * LangChain message types used by n8n's memory sub-nodes.
 */
interface LangChainMessage {
  _getType(): string;
  content: string | unknown[];
  toJSON?(): unknown;
}

/**
 * Bridges n8n's LangChain-based memory with Vercel AI SDK's CoreMessage[] format.
 *
 * Reads from memory: LangChain messages → CoreMessage[]
 * Writes to memory: CoreMessage[] → LangChain messages
 */
export class ChatArrayMemory implements MemoryAdapter {
  private memory: N8nMemory;
  private maxMessages: number;

  constructor(memory: N8nMemory, maxMessages = 50) {
    this.memory = memory;
    this.maxMessages = maxMessages;
  }

  async load(): Promise<CoreMessage[]> {
    const langchainMessages = (await this.memory.chatHistory.getMessages()) as LangChainMessage[];
    const coreMessages: CoreMessage[] = [];

    for (const msg of langchainMessages) {
      const msgType = msg._getType();
      const content =
        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

      if (msgType === 'human') {
        coreMessages.push({ role: 'user', content });
      } else if (msgType === 'ai') {
        // The better-ai-agent stores CoreMessage[] as JSON in AI messages.
        // Try to parse, fall back to plain text.
        try {
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) {
            for (const m of parsed as CoreMessage[]) {
              if (m.role && m.content !== undefined) {
                coreMessages.push(m);
              }
            }
            continue;
          }
        } catch {
          // Not JSON, use as plain text
        }
        coreMessages.push({ role: 'assistant', content });
      } else if (msgType === 'system') {
        coreMessages.push({ role: 'system', content });
      }
    }

    // Apply windowing limit
    if (coreMessages.length > this.maxMessages) {
      const trimmed = coreMessages.slice(-this.maxMessages);
      // Ensure we don't start with an orphaned tool result
      while (trimmed.length > 0 && trimmed[0].role === 'tool') {
        trimmed.shift();
      }
      return trimmed;
    }

    return coreMessages;
  }

  async save(messages: CoreMessage[]): Promise<void> {
    // Find the new user and assistant messages to persist.
    // We save the user message as a human message and
    // the assistant response (+ any tool calls/results) as a single AI message.
    const userMessages = messages.filter((m) => m.role === 'user');
    const lastUser = userMessages[userMessages.length - 1];
    if (lastUser) {
      const content = typeof lastUser.content === 'string'
        ? lastUser.content
        : JSON.stringify(lastUser.content);
      await this.memory.chatHistory.addUserMessage(content);
    }

    // Save non-user messages as a batch in a single AI message
    const assistantTurn = messages.filter((m) => m.role !== 'user' && m.role !== 'system');
    if (assistantTurn.length > 0) {
      // Store as JSON array so we can reconstruct tool calls on load
      const serialized = JSON.stringify(assistantTurn);
      if (this.memory.chatHistory.addAIChatMessage) {
        await this.memory.chatHistory.addAIChatMessage(serialized);
      } else {
        // Fallback: add as a generic message
        await this.memory.chatHistory.addMessage({
          type: 'ai',
          data: { content: serialized },
        });
      }
    }
  }
}
