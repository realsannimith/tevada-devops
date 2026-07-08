import { describe, expect, it } from 'vitest';
import {
  buildDatabaseBackupForm,
  buildDomainForm,
  buildS3StorageForm,
} from './forms';

describe('buildDomainForm', () => {
  it('produces the domain, port, www, https and email fields', () => {
    const form = buildDomainForm({});
    const keys = form.fields.map((f) => f.key);
    expect(keys).toEqual(['domain', 'port', 'www', 'https', 'email']);
    expect(form.submitLabel).toBeTruthy();
  });

  it('marks domain and port required', () => {
    const form = buildDomainForm({});
    const required = form.fields.filter((f) => f.required).map((f) => f.key);
    expect(required).toEqual(['domain', 'port']);
  });

  it('prefills the suggested port and frames it as agent-detected', () => {
    const form = buildDomainForm({ appName: 'shop-api', suggestedPort: 8000 });
    const port = form.fields.find((f) => f.key === 'port');
    expect(port?.defaultValue).toBe('8000');
    expect(form.title).toContain('shop-api');
    // The help text tells the user the agent detected the port for them.
    expect(port?.help).toMatch(/detected/i);
    expect(port?.help).toContain('8000');
  });

  it('leaves the port blank (and asks for it) when none is suggested', () => {
    const port = buildDomainForm({}).fields.find((f) => f.key === 'port');
    expect(port?.defaultValue).toBeUndefined();
    expect(port?.help).not.toMatch(/detected/i);
  });

  it('defaults HTTPS on and www off (toggles as string booleans)', () => {
    const form = buildDomainForm({});
    expect(form.fields.find((f) => f.key === 'https')?.defaultValue).toBe('true');
    expect(form.fields.find((f) => f.key === 'www')?.defaultValue).toBe('false');
  });

  it('attaches a DNS guide carrying the server IP', () => {
    const form = buildDomainForm({ serverIp: '203.0.113.10' });
    expect(form.dnsGuide?.serverIp).toBe('203.0.113.10');
    expect(form.dnsGuide?.domainField).toBe('domain');
    expect(form.dnsGuide?.wwwField).toBe('www');
  });
});

describe('buildDatabaseBackupForm', () => {
  it('produces the engine, database, schedule, retention and offsite fields', () => {
    const form = buildDatabaseBackupForm({});
    const keys = form.fields.map((f) => f.key);
    expect(keys).toEqual([
      'engine',
      'database',
      'schedule',
      'retentionDays',
      'offsite',
    ]);
    expect(form.submitLabel).toBeTruthy();
  });

  it('pre-selects a detected engine and frames it as agent-detected', () => {
    const form = buildDatabaseBackupForm({ detectedEngine: 'postgresql' });
    const engine = form.fields.find((f) => f.key === 'engine');
    expect(engine?.defaultValue).toBe('postgresql');
    expect(engine?.help).toMatch(/detected/i);
    expect(form.title).toContain('postgresql');
  });

  it('ignores an unknown detected engine instead of pre-selecting it', () => {
    const form = buildDatabaseBackupForm({ detectedEngine: 'sqlite' });
    const engine = form.fields.find((f) => f.key === 'engine');
    expect(engine?.defaultValue).toBeUndefined();
    expect(engine?.help).not.toMatch(/detected/i);
  });

  it('defaults to daily backups, 7-day retention, off-site off', () => {
    const form = buildDatabaseBackupForm({});
    expect(form.fields.find((f) => f.key === 'schedule')?.defaultValue).toBe(
      'Every day (03:00)',
    );
    expect(
      form.fields.find((f) => f.key === 'retentionDays')?.defaultValue,
    ).toBe('7');
    expect(form.fields.find((f) => f.key === 'offsite')?.defaultValue).toBe(
      'false',
    );
  });
});

describe('buildS3StorageForm', () => {
  it('produces the provider, bucket, region, endpoint and key fields', () => {
    const form = buildS3StorageForm({ purpose: 'backups' });
    const keys = form.fields.map((f) => f.key);
    expect(keys).toEqual([
      'provider',
      'bucket',
      'region',
      'endpoint',
      'accessKeyId',
      'secretAccessKey',
    ]);
  });

  it('masks the secret access key as a password field', () => {
    const form = buildS3StorageForm({ purpose: 'image-uploads' });
    const secret = form.fields.find((f) => f.key === 'secretAccessKey');
    expect(secret?.type).toBe('password');
    expect(secret?.required).toBe(true);
  });

  it('adds the public-read toggle only for image uploads', () => {
    const uploads = buildS3StorageForm({
      purpose: 'image-uploads',
      appName: 'shop-api',
    });
    expect(
      uploads.fields.find((f) => f.key === 'publicRead')?.defaultValue,
    ).toBe('true');
    expect(uploads.title).toContain('shop-api');

    const backups = buildS3StorageForm({ purpose: 'backups' });
    expect(backups.fields.some((f) => f.key === 'publicRead')).toBe(false);
    expect(backups.title).toMatch(/backup/i);
  });
});
