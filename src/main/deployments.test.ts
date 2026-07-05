import { describe, expect, it } from 'vitest';
import {
  assembleDeployments,
  NOTIFY_HELPER_SCRIPT,
  parseEvents,
  parseRegistry,
} from './deployments';

const REGISTRY_BLOCK = [
  '@@FILE /etc/easyhost/deploys/blog.json',
  '{"app":"blog","repo":"loy/blog","branch":"main","dir":"/opt/blog","port":3000,"script":"/usr/local/bin/blog-deploy.sh","log":"/var/log/blog-deploy.log","envFile":"/opt/blog/.env","createdAt":"2026-07-04T10:00:00+00:00"}',
  '',
  '@@FILE /etc/easyhost/deploys/api.json',
  '{',
  '  "app": "api",',
  '  "branch": "main"',
  '}',
  '',
  '@@FILE /etc/easyhost/deploys/broken.json',
  '{not json at all',
  '',
  '@@FILE /etc/easyhost/deploys/no-app.json',
  '{"repo":"x/y"}',
  '',
].join('\n');

describe('parseRegistry', () => {
  it('parses single-line and pretty-printed files, skips broken ones', () => {
    const regs = parseRegistry(REGISTRY_BLOCK);
    expect(regs.map((r) => r.app)).toEqual(['blog', 'api']);
    const blog = regs[0];
    expect(blog.repo).toBe('loy/blog');
    expect(blog.port).toBe(3000);
    expect(blog.log).toBe('/var/log/blog-deploy.log');
    expect(blog.envFile).toBe('/opt/blog/.env');
    expect(blog.createdAt).toBe(Date.parse('2026-07-04T10:00:00+00:00'));
  });

  it('returns [] for an empty section (no deploys dir yet)', () => {
    expect(parseRegistry('')).toEqual([]);
    expect(parseRegistry('\n')).toEqual([]);
  });
});

describe('parseEvents', () => {
  it('parses jsonl newest-first and skips torn lines', () => {
    const events = parseEvents(
      [
        '{"ts":"2026-07-05T10:00:00+00:00","app":"blog","status":"start","message":"Deploying abc1234 from main"}',
        '{"ts":"2026-07-05T10:01:00+00:00","app":"blog","status":"ok","message":"Deployed abc1234 from main"}',
        '{"ts":"2026-07-05T10:0', // torn mid-write
        'garbage line',
        '{"ts":"2026-07-05T11:00:00+00:00","app":"api","status":"failed","message":"Build of def5678 failed"}',
      ].join('\n'),
    );
    expect(events.map((e) => e.status)).toEqual(['failed', 'ok', 'start']);
    expect(events[0].app).toBe('api');
    expect(events[1].ts).toBe(Date.parse('2026-07-05T10:01:00+00:00'));
  });

  it('tolerates a missing/invalid timestamp', () => {
    const events = parseEvents('{"app":"a","status":"ok","message":""}');
    expect(events).toHaveLength(1);
    expect(events[0].ts).toBe(0);
  });
});

describe('assembleDeployments', () => {
  it('attaches events to registry rows and synthesizes rows for orphans', () => {
    const regs = parseRegistry(REGISTRY_BLOCK);
    const events = parseEvents(
      [
        '{"ts":"2026-07-05T10:01:00+00:00","app":"blog","status":"ok","message":"Deployed"}',
        '{"ts":"2026-07-05T11:00:00+00:00","app":"ghost-app","status":"failed","message":"boom"}',
      ].join('\n'),
    );
    const out = assembleDeployments(regs, events);
    // Most recently active first; registered-but-quiet apps last.
    expect(out.map((d) => d.app)).toEqual(['ghost-app', 'blog', 'api']);
    expect(out.find((d) => d.app === 'blog')?.lastEvent?.status).toBe('ok');
    expect(out.find((d) => d.app === 'ghost-app')?.repo).toBeUndefined();
    expect(out.find((d) => d.app === 'api')?.events).toEqual([]);
  });

  it('caps stored events per app', () => {
    const lines = Array.from({ length: 50 }, (_, i) =>
      JSON.stringify({
        ts: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        app: 'blog',
        status: 'ok',
        message: `deploy ${i}`,
      }),
    ).join('\n');
    const out = assembleDeployments([], parseEvents(lines));
    expect(out).toHaveLength(1);
    expect(out[0].events.length).toBe(30);
    expect(out[0].lastEvent?.message).toBe('deploy 49'); // newest kept first
  });
});

describe('NOTIFY_HELPER_SCRIPT', () => {
  // The script is built from a TS template literal with escaped $ and \ —
  // these assertions pin that the emitted BASH (not the TS source) is right.
  it('emits valid shell, not half-escaped TypeScript', () => {
    const s = NOTIFY_HELPER_SCRIPT;
    expect(s.startsWith('#!/bin/bash')).toBe(true);
    expect(s).toContain('APP="${1:-unknown}"; STATUS="${2:-info}"; MSG="${3:-}"');
    expect(s).toContain(">> /var/log/easyhost/deploy-events.jsonl");
    expect(s).toContain('. /etc/easyhost/telegram.env');
    expect(s).toContain('case "$STATUS" in ok|failed|rollback|error|test) ;; *) exit 0 ;; esac');
    // JSON escaping in the shell esc(): backslash doubling then quote escaping.
    expect(s).toContain(`sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g'`);
    expect(s).toContain('https://api.telegram.org/bot${EASYHOST_TG_TOKEN}/sendMessage');
    // A failed curl must never fail the deploy script.
    expect(s).toContain('|| true');
    expect(s.trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('never interpolated an undefined into the script', () => {
    expect(NOTIFY_HELPER_SCRIPT).not.toContain('undefined');
  });
});
