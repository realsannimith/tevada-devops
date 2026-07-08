import { describe, expect, it } from 'vitest';
import { buildAgentMessages, feedToMessages } from './chatMessages';
import type { ChatHistoryItem } from '@/shared/ipc-types';

const feed: ChatHistoryItem[] = [
  { kind: 'text', id: 'u1', role: 'user', content: 'deploy it' },
  { kind: 'tool', toolCallId: 't1', tool: 'runCommand', status: 'done' },
  { kind: 'text', id: 'a1', role: 'assistant', content: '  done  ' },
  { kind: 'text', id: 'e1', role: 'assistant', content: '   ' }, // blank → dropped
];

describe('feedToMessages', () => {
  it('keeps only trimmed, non-empty text turns (drops tools & blanks)', () => {
    expect(feedToMessages(feed)).toEqual([
      { role: 'user', content: 'deploy it' },
      { role: 'assistant', content: 'done' },
    ]);
  });
});

describe('buildAgentMessages', () => {
  it('appends the next user message after the history', () => {
    const out = buildAgentMessages(feed, 'now add TLS');
    expect(out[out.length - 1]).toEqual({ role: 'user', content: 'now add TLS' });
    expect(out).toHaveLength(3);
  });

  it('caps to the 40 most recent turns', () => {
    const big: ChatHistoryItem[] = Array.from({ length: 60 }, (_, i) => ({
      kind: 'text',
      id: `m${i}`,
      role: 'user',
      content: `msg ${i}`,
    }));
    expect(buildAgentMessages(big, 'last')).toHaveLength(40);
  });
});
