import { describe, expect, it, vi } from 'vitest';
import { TunnelManager, validateTunnelInput } from './tunnels';
import type { ConnectionManager } from './connection-manager';
import type { TunnelConfig } from '../shared/ipc-types';

describe('validateTunnelInput', () => {
  const ok = { localPort: 5433, remoteHost: '127.0.0.1', remotePort: 5432 };

  it('accepts a normal forward', () => {
    expect(validateTunnelInput(ok)).toBeUndefined();
    expect(validateTunnelInput({ ...ok, remoteHost: 'db.internal' })).toBeUndefined();
    expect(validateTunnelInput({ ...ok, remoteHost: '::1' })).toBeUndefined();
  });

  it('rejects out-of-range or non-integer ports', () => {
    expect(validateTunnelInput({ ...ok, localPort: 0 })).toBeTruthy();
    expect(validateTunnelInput({ ...ok, localPort: 65536 })).toBeTruthy();
    expect(validateTunnelInput({ ...ok, remotePort: 1.5 })).toBeTruthy();
    expect(validateTunnelInput({ ...ok, remotePort: NaN })).toBeTruthy();
  });

  it('rejects hosts that could escape into a shell or URL context', () => {
    expect(validateTunnelInput({ ...ok, remoteHost: '' })).toBeTruthy();
    expect(validateTunnelInput({ ...ok, remoteHost: 'a b' })).toBeTruthy();
    expect(validateTunnelInput({ ...ok, remoteHost: "x'; rm -rf" })).toBeTruthy();
  });
});

describe('TunnelManager', () => {
  const CONFIG: TunnelConfig = {
    id: 'tun-1',
    serverId: 'srv-1',
    localPort: 0, // OS-assigned port keeps the test free of collisions
    remoteHost: '127.0.0.1',
    remotePort: 5432,
    createdAt: 1,
  };

  function makeManager(overrides: {
    status?: string;
    connect?: () => Promise<{ ok: boolean; error?: string }>;
  } = {}) {
    const emit = vi.fn();
    const cm = {
      getStatus: () => overrides.status ?? 'connected',
      forwardOut: vi.fn(async () => {
        throw new Error('no server in tests');
      }),
    } as unknown as ConnectionManager;
    const manager = new TunnelManager({
      cm,
      connect: overrides.connect ?? (async () => ({ ok: true })),
      listConfigs: () => [CONFIG],
      emit,
    });
    return { manager, emit };
  }

  it('reports every saved config with inactive runtime state', () => {
    const { manager } = makeManager();
    expect(manager.states()).toEqual([
      { config: CONFIG, active: false, connections: 0, error: undefined },
    ]);
  });

  it('start() flips the state to active and stop() reverts it', async () => {
    const { manager, emit } = makeManager();
    const res = await manager.start('tun-1');
    expect(res.ok).toBe(true);
    expect(manager.states()[0].active).toBe(true);
    expect(emit).toHaveBeenCalled();

    manager.stop('tun-1');
    expect(manager.states()[0].active).toBe(false);
  });

  it('start() connects a disconnected server first and propagates failure', async () => {
    const connect = vi.fn(async () => ({ ok: false, error: 'auth failed' }));
    const { manager } = makeManager({ status: 'disconnected', connect });
    const res = await manager.start('tun-1');
    expect(connect).toHaveBeenCalledWith('srv-1');
    expect(res).toEqual({ ok: false, error: 'auth failed' });
    expect(manager.states()[0].active).toBe(false);
  });

  it('start() on an unknown id fails cleanly', async () => {
    const { manager } = makeManager();
    expect(await manager.start('ghost')).toEqual({
      ok: false,
      error: 'Unknown tunnel.',
    });
  });

  it('stopForServer stops only that server’s tunnels', async () => {
    const { manager } = makeManager();
    await manager.start('tun-1');
    manager.stopForServer('other-server');
    expect(manager.states()[0].active).toBe(true);
    manager.stopForServer('srv-1');
    expect(manager.states()[0].active).toBe(false);
  });
});
