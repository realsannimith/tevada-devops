import { describe, expect, it } from 'vitest';
import { isSqlEngine, parseMy, parsePg } from './db-query';

const FS = '\x1f';
const RS = '\x1e';
const NULL = '\x00NULL\x00';

describe('isSqlEngine', () => {
  it('accepts the browsable relational engines', () => {
    expect(isSqlEngine('postgresql')).toBe(true);
    expect(isSqlEngine('mysql')).toBe(true);
    expect(isSqlEngine('mariadb')).toBe(true);
  });
  it('rejects non-relational engines', () => {
    expect(isSqlEngine('redis')).toBe(false);
    expect(isSqlEngine('mongodb')).toBe(false);
    expect(isSqlEngine('')).toBe(false);
  });
});

describe('parsePg', () => {
  it('parses a header + two rows', () => {
    const out = ['id' + FS + 'name', '1' + FS + 'alice', '2' + FS + 'bob'].join(RS);
    expect(parsePg(out)).toEqual({
      columns: ['id', 'name'],
      rows: [
        ['1', 'alice'],
        ['2', 'bob'],
      ],
    });
  });

  it('distinguishes NULL from empty string via the sentinel', () => {
    const out = ['a' + FS + 'b', NULL + FS + ''].join(RS);
    expect(parsePg(out)).toEqual({ columns: ['a', 'b'], rows: [[null, '']] });
  });

  it('returns the header alone for a zero-row result', () => {
    const out = 'id' + FS + 'name';
    expect(parsePg(out)).toEqual({ columns: ['id', 'name'], rows: [] });
  });

  it('tolerates a trailing record separator', () => {
    const out = 'id' + RS + '1' + RS;
    expect(parsePg(out)).toEqual({ columns: ['id'], rows: [['1']] });
  });

  it('returns empty on empty output', () => {
    expect(parsePg('')).toEqual({ columns: [], rows: [] });
  });
});

describe('parseMy', () => {
  it('parses tab-separated rows with a header', () => {
    const out = 'id\tname\n1\talice\n2\tbob\n';
    expect(parseMy(out)).toEqual({
      columns: ['id', 'name'],
      rows: [
        ['1', 'alice'],
        ['2', 'bob'],
      ],
    });
  });

  it('maps the bare NULL token to null', () => {
    const out = 'a\tb\nNULL\t\n';
    expect(parseMy(out)).toEqual({ columns: ['a', 'b'], rows: [[null, '']] });
  });

  it('unescapes tabs and newlines embedded in values', () => {
    const out = 'v\ntwo\\tcols\\nline\n';
    expect(parseMy(out)).toEqual({ columns: ['v'], rows: [['two\tcols\nline']] });
  });

  it('returns the header alone for a zero-row result', () => {
    expect(parseMy('id\tname\n')).toEqual({ columns: ['id', 'name'], rows: [] });
  });
});
