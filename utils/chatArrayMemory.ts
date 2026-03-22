import type { CoreMessage } from 'ai';
import type { N8nMemory } from './getConnectedMemory';
import type { MemoryAdapter } from '../nodes/SlackAiStreamingAgent/types';

/**
 * Get the message type from a LangChain message object.
 * Handles both class instances (with _getType method) and plain objects.
 */
function getMessageType(msg: unknown): string {
  const record = msg as Record<string, unknown>;

  // Class instance with _getType method
  if (typeof record['_getType'] === 'function') {
    return (record['_getType'] as () => string)();
  }

  // Plain object with type or lc_id
  if (typeof record['type'] === 'string') return record['type'];

  // LangChain serialized format: lc_id: ["langchain_core", "messages", "HumanMessage"]
  const lcId = record['lc_id'] as string[] | undefined;
  if (Array.isArray(lcId)) {
    const last = lcId[lcId.length - 1]?.toLowerCase() ?? '';
    if (last.includes('human')) return 'human';
    if (last.includes('ai')) return 'ai';
    if (last.includes('system')) return 'system';
    if (last.includes('tool')) return 'tool';
  }

  // Check role field (already in CoreMessage-like format)
  if (typeof record['role'] === 'string') {
    const role = record['role'] as string;
    if (role === 'user') return 'human';
    if (role === 'assistant') return 'ai';
    return role;
  }

  // data.type for serialized messages
  const data = record['data'] as Record<string, unknown> | undefined;
  if (data && typeof data['type'] === 'string') return data['type'];

  return 'unknown';
}

/**
 * Extract content from a LangChain message object.
 */
function getMessageContent(msg: unknown): string {
  const record = msg as Record<string, unknown>;

  if (typeof record['content'] === 'string') return record['content'];
  if (record['content'] !== undefined) return JSON.stringify(record['content']);

  // Serialized format
  const data = record['data'] as Record<string, unknown> | undefined;
  if (data && typeof data['content'] === 'string') return data['content'];
  if (data && data['content'] !== undefined) return JSON.stringify(data['content']);

  return '';
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
    const langchainMessages = await this.memory.chatHistory.getMessages();
    const coreMessages: CoreMessage[] = [];

    for (const msg of langchainMessages) {
      const msgType = getMessageType(msg);
      const content = getMessageContent(msg);

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
