import { describe, expect, it } from 'vitest';
import {
  buildConnectionString,
  isRemoteHost,
  parseContainerCredentialGuess,
} from './credentials';

describe('isRemoteHost', () => {
  it('treats loopback / localhost as NOT remote', () => {
    expect(isRemoteHost('127.0.0.1')).toBe(false);
    expect(isRemoteHost('localhost')).toBe(false);
    expect(isRemoteHost('LOCALHOST')).toBe(false);
    expect(isRemoteHost('::1')).toBe(false);
    expect(isRemoteHost('  ')).toBe(false);
  });

  it('treats a public IP or domain as remote', () => {
    expect(isRemoteHost('152.42.254.59')).toBe(true);
    expect(isRemoteHost('db.example.com')).toBe(true);
    expect(isRemoteHost('10.0.0.5')).toBe(true);
  });
});

describe('buildConnectionString', () => {
  it('builds a postgres URI with the database and username', () => {
    expect(
      buildConnectionString(
        { engine: 'postgresql', host: '127.0.0.1', port: 5432, database: 'appdb', username: 'appuser' },
        'p@ss/w:rd',
      ),
    ).toBe('postgres://appuser:p%40ss%2Fw%3Ard@127.0.0.1:5432/appdb');
  });

  it('builds a mysql URI, defaulting the username to root', () => {
    expect(
      buildConnectionString(
        { engine: 'mysql', host: '10.0.0.5', port: 3306, database: 'appdb' },
        'secret',
      ),
    ).toBe('mysql://root:secret@10.0.0.5:3306/appdb');
  });

  it('builds a mongodb URI', () => {
    expect(
      buildConnectionString(
        { engine: 'mongodb', host: '127.0.0.1', port: 27017, database: 'appdb', username: 'appuser' },
        'secret',
      ),
    ).toBe('mongodb://appuser:secret@127.0.0.1:27017/appdb');
  });

  it('builds a redis URI with no username (password-only auth)', () => {
    expect(
      buildConnectionString({ engine: 'redis', host: '127.0.0.1', port: 6379 }, 'secret'),
    ).toBe('redis://:secret@127.0.0.1:6379');
  });

  it('falls back to host:port for an unknown engine', () => {
    expect(
      buildConnectionString({ engine: 'unknown', host: 'h', port: 1 }, 'x'),
    ).toBe('h:1');
  });
});

describe('parseContainerCredentialGuess', () => {
  it('reads a postgres container env', () => {
    expect(
      parseContainerCredentialGuess(
        'postgresql',
        ['POSTGRES_PASSWORD=abc123', 'POSTGRES_USER=appuser', 'POSTGRES_DB=appdb'],
        [],
      ),
    ).toEqual({ password: 'abc123', username: 'appuser', database: 'appdb' });
  });

  it('reads a mariadb container env, preferring the app user over root', () => {
    expect(
      parseContainerCredentialGuess(
        'mysql',
        [
          'MARIADB_ROOT_PASSWORD=rootpw',
          'MARIADB_PASSWORD=apppw',
          'MARIADB_USER=appuser',
          'MARIADB_DATABASE=appdb',
        ],
        [],
      ),
    ).toEqual({ password: 'apppw', username: 'appuser', database: 'appdb' });
  });

  it('reads a mongo container env', () => {
    expect(
      parseContainerCredentialGuess(
        'mongodb',
        ['MONGO_INITDB_ROOT_PASSWORD=rootpw', 'MONGO_INITDB_ROOT_USERNAME=root'],
        [],
      ),
    ).toEqual({ password: 'rootpw', username: 'root', database: undefined });
  });

  it('reads a redis --requirepass flag from Cmd', () => {
    expect(
      parseContainerCredentialGuess('redis', [], ['redis-server', '--requirepass', 'secretpw']),
    ).toEqual({ password: 'secretpw' });
  });

  it('returns undefined when nothing recognizable is present', () => {
    expect(parseContainerCredentialGuess('postgresql', ['PGDATA=/data'], [])).toBeUndefined();
  });
});
