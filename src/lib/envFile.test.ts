import { describe, expect, it } from 'vitest';
import { applyEnvEdits, isValidEnvKey, parseEnvFile } from './envFile';

const FILE = [
  '# app config',
  'PORT=3000',
  'export DATABASE_URL=postgres://u:p@127.0.0.1:5432/app',
  '',
  'SECRET="with = signs and #hash"',
  'not a valid line',
  'PORT=4000', // duplicate — last wins
].join('\n');

describe('parseEnvFile', () => {
  it('parses keys in first-seen order, last duplicate value wins, raw values', () => {
    const entries = parseEnvFile(FILE);
    expect(entries.map((e) => e.key)).toEqual(['PORT', 'DATABASE_URL', 'SECRET']);
    expect(entries[0].value).toBe('4000');
    expect(entries[1].value).toBe('postgres://u:p@127.0.0.1:5432/app');
    // No quote stripping — values are opaque.
    expect(entries[2].value).toBe('"with = signs and #hash"');
  });

  it('handles empty content', () => {
    expect(parseEnvFile('')).toEqual([]);
  });
});

describe('applyEnvEdits', () => {
  it('rewrites in place, preserves comments/unknown lines, appends new keys', () => {
    const next = applyEnvEdits(FILE, [
      { key: 'PORT', value: '5000' },
      { key: 'SECRET', value: 'plain' },
      { key: 'NEW_FLAG', value: 'true' },
    ]);
    expect(next).toBe(
      [
        '# app config',
        'PORT=5000',
        '',
        'SECRET=plain',
        'not a valid line',
        'NEW_FLAG=true',
        '',
      ].join('\n'),
    );
  });

  it('drops removed keys and duplicate occurrences', () => {
    const next = applyEnvEdits(FILE, [{ key: 'PORT', value: '3000' }]);
    expect(next).not.toContain('DATABASE_URL');
    expect(next).not.toContain('SECRET');
    expect(next.match(/^PORT=/gm)).toHaveLength(1);
  });

  it('round-trips: parse(applyEnvEdits(x, parse(x))) === parse(x)', () => {
    const entries = parseEnvFile(FILE);
    const rebuilt = applyEnvEdits(FILE, entries);
    expect(parseEnvFile(rebuilt)).toEqual(entries);
  });

  it('builds a fresh file from empty content', () => {
    expect(applyEnvEdits('', [{ key: 'A', value: '1' }])).toBe('A=1\n');
  });
});

describe('isValidEnvKey', () => {
  it('accepts POSIX names, rejects the rest', () => {
    expect(isValidEnvKey('DATABASE_URL')).toBe(true);
    expect(isValidEnvKey('_private')).toBe(true);
    for (const bad of ['1BAD', 'has space', 'dash-key', '', 'a=b']) {
      expect(isValidEnvKey(bad)).toBe(false);
    }
  });
});
