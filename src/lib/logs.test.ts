import { describe, expect, it } from 'vitest';
import {
  ansiToHtml,
  createLineAssembler,
  getLogLevel,
  logLinesToText,
  parseLogLines,
  stripAnsi,
} from './logs';

const ESC = '';

describe('stripAnsi', () => {
  it('removes colour codes but keeps the text', () => {
    expect(stripAnsi(`${ESC}[31mfailed${ESC}[0m`)).toBe('failed');
  });

  it('leaves a literal bracket tag alone', () => {
    // Regression: an ESC-less regex would eat "[i" here and break level tags.
    expect(stripAnsi('[info] starting')).toBe('[info] starting');
  });
});

describe('getLogLevel', () => {
  it('reads the emoji markers our deploy scripts print', () => {
    expect(getLogLevel('✅ Docker build completed.')).toBe('success');
    expect(getLogLevel('❌ Nixpacks build failed')).toBe('error');
    expect(getLogLevel('⚠ falling back to cache')).toBe('warning');
  });

  it('reads explicit level tags through ANSI colour', () => {
    expect(getLogLevel(`${ESC}[31m[error]${ESC}[0m boom`)).toBe('error');
    expect(getLogLevel('[warn] deprecated flag')).toBe('warning');
    expect(getLogLevel('[debug] resolved 41 modules')).toBe('debug');
    expect(getLogLevel('[info] listening')).toBe('info');
  });

  it('classifies HTTP status codes ahead of everything else', () => {
    expect(getLogLevel('"statusCode": 500 request done')).toBe('error');
    expect(getLogLevel('"statusCode": 404')).toBe('warning');
    expect(getLogLevel('status=200')).toBe('success');
  });

  it('falls back to content sniffing', () => {
    expect(getLogLevel('npm ERR! code ENOENT: no such file')).toBe('error');
    expect(getLogLevel('    at Module._load (node:internal/x:12:3)')).toBe('error');
    expect(getLogLevel('Server listening on port 3000')).toBe('success');
    expect(getLogLevel('Cloning into "repo"...')).toBe('info');
  });

  it('prefers an explicit tag over a stray word in the same line', () => {
    // "failed" appears, but the line announces itself as info.
    expect(getLogLevel('[info] retry after a failed attempt')).toBe('info');
  });
});

describe('parseLogLines', () => {
  it('splits off a docker --timestamps prefix', () => {
    const [line] = parseLogLines(['2026-07-14T10:00:00.123456789Z hello world']);
    expect(line.rawTimestamp).toBe('2026-07-14T10:00:00.123456789Z');
    expect(line.timestamp?.toISOString()).toBe('2026-07-14T10:00:00.123Z');
    expect(line.message).toBe('hello world');
  });

  it('handles build-log lines that carry no timestamp', () => {
    const [line] = parseLogLines(['Step 3/8 : RUN npm ci']);
    expect(line.rawTimestamp).toBeNull();
    expect(line.timestamp).toBeNull();
    expect(line.message).toBe('Step 3/8 : RUN npm ci');
  });

  it('drops blank lines and trailing CRs', () => {
    const lines = parseLogLines(['a\r', '', '   ', 'b']);
    expect(lines.map((l) => l.message)).toEqual(['a', 'b']);
  });

  it('gives every line a unique id even when text repeats', () => {
    const lines = parseLogLines(['same', 'same', 'same']);
    expect(new Set(lines.map((l) => l.id)).size).toBe(3);
  });
});

describe('ansiToHtml', () => {
  it('turns colour codes into markup and escapes the payload', () => {
    const html = ansiToHtml(`${ESC}[31mdanger${ESC}[0m`);
    expect(html).toContain('danger');
    expect(html).toContain('<span');
  });

  it('escapes HTML so log content cannot inject markup', () => {
    const html = ansiToHtml('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('createLineAssembler', () => {
  const texts = (lines: { message: string }[]) => lines.map((l) => l.message);

  it('holds back a line split across chunks and emits it once complete', () => {
    const a = createLineAssembler();
    // A real tail -f will happily split mid-word.
    expect(texts(a.push('Step 3/8 : RU'))).toEqual([]);
    expect(texts(a.push('N npm ci\n'))).toEqual(['Step 3/8 : RUN npm ci']);
  });

  it('emits complete lines immediately and carries only the remainder', () => {
    const a = createLineAssembler();
    expect(texts(a.push('one\ntwo\nthr'))).toEqual(['one', 'two']);
    expect(texts(a.push('ee\n'))).toEqual(['three']);
  });

  it('carries nothing when a chunk ends exactly on a newline', () => {
    const a = createLineAssembler();
    expect(texts(a.push('done\n'))).toEqual(['done']);
    expect(texts(a.flush())).toEqual([]); // no phantom empty line
  });

  it('flushes a final line that never got a trailing newline', () => {
    const a = createLineAssembler();
    expect(texts(a.push('build failed'))).toEqual([]);
    expect(texts(a.flush())).toEqual(['build failed']);
  });

  it('flush is idempotent', () => {
    const a = createLineAssembler();
    a.push('tail');
    expect(texts(a.flush())).toEqual(['tail']);
    expect(texts(a.flush())).toEqual([]);
  });

  it('reassembles an ANSI escape split across a chunk boundary', () => {
    const a = createLineAssembler();
    // The colour code itself can be torn in half by a chunk boundary.
    expect(texts(a.push('[3'))).toEqual([]);
    const out = a.push('1mfailed[0m\n');
    expect(stripAnsi(out[0].message)).toBe('failed');
    expect(out[0].level).toBe('error');
  });

  it('keeps a docker timestamp attached to its own line across chunks', () => {
    const a = createLineAssembler();
    a.push('2026-07-14T10:00:00Z star');
    const [line] = a.push('ting\n');
    expect(line.rawTimestamp).toBe('2026-07-14T10:00:00Z');
    expect(line.message).toBe('starting');
  });
});

describe('logLinesToText', () => {
  it('renders plain text for download, without ANSI', () => {
    const lines = parseLogLines([
      `2026-07-14T10:00:00Z ${ESC}[32mok${ESC}[0m`,
      'plain',
    ]);
    expect(logLinesToText(lines)).toBe('2026-07-14T10:00:00Z ok\nplain');
  });
});
