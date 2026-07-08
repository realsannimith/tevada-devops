import { describe, expect, it } from 'vitest';
import { computeDnsRecordName } from './dns';

describe('computeDnsRecordName', () => {
  it('uses @ for a bare/registrable domain', () => {
    expect(computeDnsRecordName('example.com')).toEqual({ name: '@', bare: true });
  });

  it('uses the label for a subdomain', () => {
    expect(computeDnsRecordName('app.example.com')).toEqual({
      name: 'app',
      bare: false,
    });
  });

  it('keeps multi-level subdomain labels', () => {
    expect(computeDnsRecordName('a.b.example.com').name).toBe('a.b');
  });

  it('strips protocol, path and trailing dot, and lowercases', () => {
    expect(computeDnsRecordName('HTTPS://App.Example.com/docs')).toEqual({
      name: 'app',
      bare: false,
    });
  });

  it('treats empty / partial input as bare', () => {
    expect(computeDnsRecordName('').bare).toBe(true);
    expect(computeDnsRecordName('example').bare).toBe(true);
  });
});
