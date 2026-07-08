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
  addServer,
  deleteChatSession,
  getChatState,
  getGoogleDriveAccount,
  listServers,
  renameChatSession,
  restoreStoreData,
  setChatSessionPinned,
  setGoogleDriveAccount,
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

describe('restoreStoreData', () => {
  it('replaces store contents but preserves the live Google Drive connection', () => {
    // Current device state: a connected Drive account + a local server.
    setGoogleDriveAccount({
      email: 'me@example.com',
      connectedAt: 1,
      lastSyncHash: 'local-hash',
    });
    addServer({
      id: 'local-server',
      name: 'Local',
      host: '1.1.1.1',
      port: 22,
      username: 'root',
      projectIds: [],
    } as never);

    // A snapshot pulled from Drive (note: backups omit `googleDrive`).
    restoreStoreData({
      servers: [
        {
          id: 'restored-server',
          name: 'Restored',
          host: '2.2.2.2',
          port: 22,
          username: 'root',
          projectIds: [],
        },
      ],
      chatSessions: [session({ id: 'restored-chat' })],
    });

    // Servers/chats come from the snapshot...
    const servers = listServers();
    expect(servers.map((s) => s.id)).toEqual(['restored-server']);
    expect(findSession('restored-chat')).toBeTruthy();

    // ...but the Drive account (tokens/connection) is untouched, so restoring
    // never signs the user out of the Drive they restored from.
    expect(getGoogleDriveAccount()?.email).toBe('me@example.com');
  });

  it('tolerates a non-object snapshot without throwing', () => {
    setGoogleDriveAccount({ email: 'me@example.com', connectedAt: 1 });
    expect(() => restoreStoreData(null)).not.toThrow();
    expect(getGoogleDriveAccount()?.email).toBe('me@example.com');
    expect(listServers()).toEqual([]);
  });
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

describe('renameChatSession', () => {
  it('sets an explicit title and survives a background re-save without one', () => {
    upsertChatSession(session({ id: 'a' }));
    renameChatSession('a', 'Deploy the shop API');
    expect(findSession('a')?.title).toBe('Deploy the shop API');

    // A debounced ChatPanel/run-manager save never carries a title — the
    // rename must not be wiped by it.
    upsertChatSession(session({ id: 'a', status: 'done' }));
    expect(findSession('a')?.title).toBe('Deploy the shop API');
  });

  it('clears the rename when given an empty title', () => {
    upsertChatSession(session({ id: 'a' }));
    renameChatSession('a', 'Named');
    renameChatSession('a', '   ');
    expect(findSession('a')?.title).toBeUndefined();
  });

  it('is a no-op for an unknown id', () => {
    upsertChatSession(session({ id: 'a' }));
    const state = renameChatSession('missing', 'X');
    expect(state.sessions.map((s) => s.id)).toEqual(['a']);
  });
});

describe('upsertChatSession persists the token tally', () => {
  it('round-trips tokens and keeps them when a later save omits them', () => {
    upsertChatSession(session({ id: 'a', tokens: 12345 }));
    expect(findSession('a')?.tokens).toBe(12345);

    upsertChatSession(session({ id: 'a', status: 'done' }));
    expect(findSession('a')?.tokens).toBe(12345);
  });

  it('drops a non-positive or malformed token count', () => {
    upsertChatSession(session({ id: 'a', tokens: 0 }));
    expect(findSession('a')?.tokens).toBeUndefined();
    upsertChatSession(
      session({ id: 'b', tokens: Number.NaN }),
    );
    expect(findSession('b')?.tokens).toBeUndefined();
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

describe('upsertChatSession persists todo-list items', () => {
  it('keeps a todos item through a save/load round-trip', () => {
    upsertChatSession(
      session({
        id: 'a',
        items: [
          { kind: 'text', id: 'u1', role: 'user', content: 'deploy it' },
          {
            kind: 'todos',
            id: 'todo_1',
            todos: [
              { text: 'Install Docker', status: 'completed' },
              { text: 'Run the container', status: 'in_progress' },
              { text: 'Verify it responds', status: 'pending' },
            ],
          },
        ],
      }),
    );
    const saved = findSession('a');
    expect(saved?.items.map((i) => i.kind)).toEqual(['text', 'todos']);
    const todosItem = saved?.items.find((i) => i.kind === 'todos');
    expect(todosItem && todosItem.kind === 'todos' && todosItem.todos).toHaveLength(3);
  });

  it('drops a malformed todos item (bad status) but keeps the valid ones', () => {
    upsertChatSession(
      session({
        id: 'a',
        items: [
          {
            kind: 'todos',
            id: 'good',
            todos: [{ text: 'ok', status: 'pending' }],
          },
          // @ts-expect-error — intentionally invalid status, must be rejected
          { kind: 'todos', id: 'bad', todos: [{ text: 'x', status: 'huh' }] },
        ],
      }),
    );
    const saved = findSession('a');
    expect(saved?.items.map((i) => i.kind)).toEqual(['todos']);
  });
});

describe('upsertChatSession persists message attachments', () => {
  it('keeps a user message with attachments through a round-trip', () => {
    upsertChatSession(
      session({
        id: 'a',
        items: [
          {
            kind: 'text',
            id: 'u1',
            role: 'user',
            content: 'what is this error?',
            attachments: [
              {
                id: 'att1',
                name: 'error.png',
                mediaType: 'image/png',
                kind: 'image',
                size: 1234,
                dataUrl: 'data:image/png;base64,AAA',
              },
            ],
          },
        ],
      }),
    );
    const saved = findSession('a');
    const msg = saved?.items[0];
    expect(msg?.kind === 'text' && msg.attachments?.[0]?.name).toBe('error.png');
  });
});

describe('upsertChatSession persists agent form items', () => {
  it('keeps a form item (with its submitted values) through a round-trip', () => {
    upsertChatSession(
      session({
        id: 'a',
        items: [
          { kind: 'text', id: 'u1', role: 'user', content: 'add a domain' },
          {
            kind: 'form',
            formId: 'form_1',
            title: 'Set up a domain',
            fields: [
              { key: 'domain', label: 'Domain', type: 'text', required: true },
              { key: 'https', label: 'HTTPS', type: 'toggle' },
            ],
            status: 'submitted',
            values: { domain: 'app.example.com', https: 'true' },
          },
        ],
      }),
    );
    const saved = findSession('a');
    expect(saved?.items.map((i) => i.kind)).toEqual(['text', 'form']);
    const form = saved?.items.find((i) => i.kind === 'form');
    expect(form && form.kind === 'form' && form.values?.domain).toBe(
      'app.example.com',
    );
  });

  it('drops a malformed form item (bad status)', () => {
    upsertChatSession(
      session({
        id: 'a',
        items: [
          {
            kind: 'form',
            formId: 'ok',
            title: 'Fine',
            fields: [],
            status: 'pending',
          },
          {
            kind: 'form',
            formId: 'bad',
            title: 'Broken',
            fields: [],
            // @ts-expect-error — intentionally invalid status, must be rejected
            status: 'weird',
          },
        ],
      }),
    );
    const saved = findSession('a');
    expect(saved?.items).toHaveLength(1);
    const form = saved?.items[0];
    expect(form?.kind === 'form' && form.formId).toBe('ok');
  });
});

describe('corrupt store recovery', () => {
  const storeFile = path.join(userDataDir, 'easyhost.json');

  it('recovers servers from the last-good backup when the store file is corrupt', () => {
    // A normal write creates easyhost.json and (on the next write) a .bak.
    addServer({
      id: 'srv-1',
      name: 'Prod',
      host: '10.0.0.1',
      port: 22,
      username: 'root',
      projectIds: [],
    } as never);
    // Second write so a .bak of the good file exists.
    addServer({
      id: 'srv-2',
      name: 'Staging',
      host: '10.0.0.2',
      port: 22,
      username: 'root',
      projectIds: [],
    } as never);
    expect(fs.existsSync(`${storeFile}.bak`)).toBe(true);

    // Simulate on-disk corruption (truncated JSON).
    fs.writeFileSync(storeFile, '{ "servers": [ {"id":"srv-1"', 'utf8');

    // read() must not silently return empty (which the next write would persist).
    const recovered = listServers();
    expect(recovered.map((s) => s.id)).toContain('srv-1');

    // The corrupt file is preserved for forensics, not overwritten.
    const corruptCopies = fs
      .readdirSync(userDataDir)
      .filter((f) => f.startsWith('easyhost.json.corrupt-'));
    expect(corruptCopies.length).toBeGreaterThan(0);
  });

  it('returns empty (fresh) when the store file is absent', () => {
    expect(fs.existsSync(storeFile)).toBe(false);
    expect(listServers()).toEqual([]);
  });
});
