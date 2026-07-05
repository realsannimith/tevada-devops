import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatSession } from '../shared/ipc-types';

const userDataDir = path.join(os.tmpdir(), 'easyhost-store-test');

// Point the store at a throwaway userData dir so read()/write() hit a temp file
// instead of a real Electron profile. getPath is only invoked at test time
// (inside store calls), well after these imports initialize — so no TDZ.
vi.mock('electron', () => ({
  app: { getPath: () => path.join(os.tmpdir(), 'easyhost-store-test') },
}));

import {
  deleteChatSession,
  getChatState,
  setChatSessionPinned,
  upsertChatSession,
} from './store';

function findSession(id: string): ChatSession | undefined {
  return getChatState().sessions.find((s) => s.id === id);
}

function session(overrides: Partial<ChatSession>): ChatSession {
  return {
    id: 's1',
    items: [{ kind: 'text', id: 'u1', role: 'user', content: 'hi' }],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

beforeEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('setChatSessionPinned', () => {
  it('pins and unpins a saved session (round-tripping through disk)', () => {
    upsertChatSession(session({ id: 'a' }));
    expect(findSession('a')?.pinned).toBeFalsy();

    setChatSessionPinned('a', true);
    expect(findSession('a')?.pinned).toBe(true);

    setChatSessionPinned('a', false);
    expect(findSession('a')?.pinned).toBeFalsy();
  });

  it('is a no-op for an unknown id and still returns current state', () => {
    upsertChatSession(session({ id: 'a' }));
    const state = setChatSessionPinned('missing', true);
    expect(state.sessions.map((s) => s.id)).toEqual(['a']);
    expect(findSession('a')?.pinned).toBeFalsy();
  });
});

describe('upsertChatSession preserves the pinned flag', () => {
  it('keeps a session pinned when a background re-save omits the flag', () => {
    // The ChatPanel's debounced saves don't carry `pinned`; a re-save must not
    // silently unpin the row.
    upsertChatSession(session({ id: 'a' }));
    setChatSessionPinned('a', true);

    upsertChatSession(
      session({
        id: 'a',
        items: [
          { kind: 'text', id: 'u1', role: 'user', content: 'hi' },
          { kind: 'text', id: 'a1', role: 'assistant', content: 'there' },
        ],
        updatedAt: 99,
      }),
    );

    const saved = findSession('a');
    expect(saved?.pinned).toBe(true);
    expect(saved?.items).toHaveLength(2); // the re-save DID land
  });

  it('does not unpin when an incoming save carries pinned:false (unpin goes through the setter only)', () => {
    upsertChatSession(session({ id: 'a' }));
    setChatSessionPinned('a', true);

    upsertChatSession(session({ id: 'a', pinned: false, updatedAt: 42 }));
    expect(findSession('a')?.pinned).toBe(true);
  });

  it('honors an explicit pinned:true on first insert', () => {
    upsertChatSession(session({ id: 'a', pinned: true }));
    expect(findSession('a')?.pinned).toBe(true);
  });
});

describe('upsertChatSession keeps updatedAt stable for no-op re-saves', () => {
  it('a verbatim re-save keeps the old timestamp (clicking History must not reorder it)', () => {
    upsertChatSession(session({ id: 'a', updatedAt: 100 }));
    // Reopening the conversation triggers the ChatPanel's normalize-after-load
    // save: same content, fresh Date.now() timestamp.
    upsertChatSession(session({ id: 'a', updatedAt: 999 }));
    expect(findSession('a')?.updatedAt).toBe(100);
  });

  it('a save with new content DOES bump the timestamp', () => {
    upsertChatSession(session({ id: 'a', updatedAt: 100 }));
    upsertChatSession(
      session({
        id: 'a',
        items: [
          { kind: 'text', id: 'u1', role: 'user', content: 'hi' },
          { kind: 'text', id: 'a1', role: 'assistant', content: 'there' },
        ],
        updatedAt: 999,
      }),
    );
    expect(findSession('a')?.updatedAt).toBe(999);
  });

  it('a status change alone bumps the timestamp (run finishing is activity)', () => {
    upsertChatSession(session({ id: 'a', status: 'running', updatedAt: 100 }));
    upsertChatSession(session({ id: 'a', status: 'done', updatedAt: 999 }));
    expect(findSession('a')?.updatedAt).toBe(999);
  });
});

describe('deleteChatSession', () => {
  it('removes a pinned session cleanly', () => {
    upsertChatSession(session({ id: 'a' }));
    setChatSessionPinned('a', true);
    deleteChatSession('a');
    expect(findSession('a')).toBeUndefined();
  });
});
