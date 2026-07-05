import { describe, expect, it } from 'vitest';
import {
  markInterruptedToolsDone,
  summarizeChatHistory,
  summarizeChatSession,
} from './chatHistory';
import type { ChatSession } from '@/shared/ipc-types';

function session(overrides: Partial<ChatSession>): ChatSession {
  return {
    id: 's1',
    items: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe('summarizeChatSession', () => {
  it('titles a chat from its first user message and carries status', () => {
    const summary = summarizeChatSession(
      session({
        status: 'done',
        items: [
          { kind: 'text', id: 'u1', role: 'user', content: 'install nginx please' },
          { kind: 'text', id: 'a1', role: 'assistant', content: 'Done.' },
        ],
      }),
    );
    expect(summary).toMatchObject({
      kind: 'chat',
      title: 'install nginx please',
      status: 'done',
      messageCount: 2,
    });
  });

  it('carries the pinned flag through, defaulting to false', () => {
    const items = [
      { kind: 'text', id: 'u1', role: 'user', content: 'hi' } as const,
    ];
    expect(summarizeChatSession(session({ items }))).toMatchObject({
      pinned: false,
    });
    expect(
      summarizeChatSession(session({ items, pinned: true })),
    ).toMatchObject({ pinned: true });
  });

  it('hides empty chat drafts', () => {
    expect(summarizeChatSession(session({}))).toBeNull();
    expect(
      summarizeChatSession(
        session({
          items: [
            {
              kind: 'tool',
              toolCallId: 't1',
              tool: 'run_command',
              status: 'done',
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('lists wizard runs under their playbook title even without text items', () => {
    const summary = summarizeChatSession(
      session({
        kind: 'wizard',
        title: 'Host a website',
        playbookId: 'host-website',
        status: 'running',
        items: [
          { kind: 'tool', toolCallId: 't1', tool: 'run_command', status: 'running' },
        ],
      }),
    );
    expect(summary).toMatchObject({
      kind: 'wizard',
      title: 'Host a website',
      status: 'running',
    });
  });

  it('hides wizard sessions with no recorded activity', () => {
    expect(
      summarizeChatSession(session({ kind: 'wizard', title: 'Host a website' })),
    ).toBeNull();
  });
});

describe('summarizeChatHistory ordering', () => {
  // Every session needs at least one text item, else summarize drops it.
  const chat = (id: string, updatedAt: number, pinned?: boolean): ChatSession =>
    session({
      id,
      updatedAt,
      pinned,
      items: [{ kind: 'text', id: `${id}u`, role: 'user', content: id }],
    });

  it('floats pinned rows to the top, most-recent first within each group', () => {
    const ordered = summarizeChatHistory([
      chat('old-unpinned', 100),
      chat('new-unpinned', 400),
      chat('old-pinned', 200, true),
      chat('new-pinned', 300, true),
    ]);
    expect(ordered.map((s) => s.id)).toEqual([
      'new-pinned', // pinned group, newest first
      'old-pinned',
      'new-unpinned', // unpinned group, newest first
      'old-unpinned',
    ]);
  });

  it('keeps a pinned row above a MORE-recent unpinned row', () => {
    const ordered = summarizeChatHistory([
      chat('fresh-unpinned', 999),
      chat('stale-pinned', 1, true),
    ]);
    expect(ordered.map((s) => s.id)).toEqual(['stale-pinned', 'fresh-unpinned']);
  });

  it('orders purely by recency when nothing is pinned', () => {
    const ordered = summarizeChatHistory([
      chat('a', 1),
      chat('c', 3),
      chat('b', 2),
    ]);
    expect(ordered.map((s) => s.id)).toEqual(['c', 'b', 'a']);
  });

  it('drops empty drafts before ordering', () => {
    const ordered = summarizeChatHistory([
      chat('real', 5, true),
      session({ id: 'empty', updatedAt: 9 }), // no text items -> hidden
    ]);
    expect(ordered.map((s) => s.id)).toEqual(['real']);
  });
});

describe('markInterruptedToolsDone', () => {
  it('finishes tools frozen mid-run and leaves the rest untouched', () => {
    const items = markInterruptedToolsDone([
      { kind: 'text', id: 'u1', role: 'user', content: 'hi' },
      { kind: 'tool', toolCallId: 't1', tool: 'run_command', status: 'running' },
      { kind: 'tool', toolCallId: 't2', tool: 'run_command', status: 'done' },
    ]);
    expect(items[1]).toMatchObject({ toolCallId: 't1', status: 'done' });
    expect(items[2]).toMatchObject({ toolCallId: 't2', status: 'done' });
    expect(items[0]).toMatchObject({ kind: 'text', content: 'hi' });
  });
});
