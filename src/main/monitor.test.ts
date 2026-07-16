import { describe, expect, it } from 'vitest';
import { parseHost, parseStats } from './monitor';

describe('parseHost', () => {
  it('reads cores, arch, and derives Intel vendor', () => {
    const block = [
      'cores=2',
      'arch=x86_64',
      'vendor_id\t: GenuineIntel',
      'model name\t: Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz',
    ].join('\n');
    expect(parseHost(block)).toEqual({
      cores: 2,
      vendor: 'Intel',
      arch: 'x86_64',
    });
  });

  it('derives AMD from vendor_id', () => {
    const block = ['cores=4', 'arch=x86_64', 'vendor_id\t: AuthenticAMD'].join(
      '\n',
    );
    expect(parseHost(block)?.vendor).toBe('AMD');
  });

  it('falls back to ARM for aarch64 with no vendor_id', () => {
    const block = ['cores=1', 'arch=aarch64'].join('\n');
    expect(parseHost(block)).toEqual({
      cores: 1,
      vendor: 'ARM',
      arch: 'aarch64',
    });
  });

  it('returns undefined when nothing useful was read', () => {
    expect(parseHost('')).toBeUndefined();
    expect(parseHost('cores=\narch=')).toBeUndefined();
  });
});

describe('parseStats host section', () => {
  const SEP = '===EH-SEP===';

  it('attaches host info from the trailing probe section', () => {
    const raw = [
      'cpu  100 0 50 800 10 0 0 0 0 0', // cpu
      'Mem:  1000000 400000 200000 0 400000 600000', // free -b
      'Filesystem 1B-blocks Used Avail Use% Mounted', // df (header only)
      'eth0: 100 0 0 0 0 0 0 0 200 0', // net
      '1234.5 9999.0', // uptime
      '0.10 0.20 0.30 1/100 123', // loadavg
      'USER PID %CPU %MEM COMMAND', // ps (header only)
      ['cores=2', 'arch=x86_64', 'vendor_id\t: GenuineIntel'].join('\n'), // host
    ].join(`\n${SEP}\n`);

    const { stats } = parseStats(raw, undefined, undefined, 1000);
    expect(stats.host).toEqual({ cores: 2, vendor: 'Intel', arch: 'x86_64' });
    expect(stats.mem.totalBytes).toBe(1000000);
  });

  it('omits host when the section is absent', () => {
    const raw = [
      'cpu  100 0 50 800 10 0 0 0 0 0',
      'Mem:  1000000 400000 200000 0 400000 600000',
      '',
      '',
      '1234.5 9999.0',
      '0.10 0.20 0.30 1/100 123',
      '',
    ].join(`\n${SEP}\n`);
    const { stats } = parseStats(raw, undefined, undefined, 1000);
    expect(stats.host).toBeUndefined();
  });
});
