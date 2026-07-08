/**
 * Build the plain-text message history the agent run consumes from a feed.
 * Shared by ChatPanel (new sends) and chatRunManager (steer fallback / resends).
 * Attachments and the current turn's multimodal content are applied separately
 * in the main process (see agent/attachments.ts).
 */
import type { ChatHistoryItem } from '@/shared/ipc-types';

const MAX_HISTORY = 40;

export type AgentTextMessage = { role: 'user' | 'assistant'; content: string };

/** Map the transcript's text items to trimmed, non-empty role/content pairs. */
export function feedToMessages(feed: ChatHistoryItem[]): AgentTextMessage[] {
  return feed
    .filter(
      (item): item is Extract<ChatHistoryItem, { kind: 'text' }> =>
        item.kind === 'text',
    )
    .map((item) => ({ role: item.role, content: item.content.trim() }))
    .filter((message) => message.content.length > 0);
}

/** History + the next user message, capped to the most recent MAX_HISTORY turns. */
export function buildAgentMessages(
  feed: ChatHistoryItem[],
  nextUserMessage: string,
): AgentTextMessage[] {
  return [
    ...feedToMessages(feed),
    { role: 'user' as const, content: nextUserMessage },
  ].slice(-MAX_HISTORY);
}
