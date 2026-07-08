import { describe, expect, it, vi } from 'vitest';
import { AgentToolContext, buildTools } from './tools';
import { AgentFormSpec } from '../shared/ipc-types';

/** Minimal ctx: only requestForm matters for the form-first tools under test.
 *  writeS3Credentials is stubbed to succeed so the S3 tool can run end to end. */
function ctxWithForm(
  respond: (spec: Omit<AgentFormSpec, 'formId'>) => Record<string, string> | null,
) {
  const requestForm = vi.fn(async (spec: Omit<AgentFormSpec, 'formId'>) =>
    respond(spec),
  );
  const writeS3Credentials = vi.fn(
    async (_input: {
      serverId: string;
      purpose: 'image-uploads' | 'backups';
      values: Record<string, string>;
    }) => ({
      ok: true,
      envPath: '/etc/easyhost/s3-uploads.env',
    }),
  );
  const ctx = { requestForm, writeS3Credentials } as unknown as AgentToolContext;
  return { tools: buildTools(ctx), requestForm, writeS3Credentials };
}

/** ctx wired for the runCommand seatbelt path: records approvals + execs. */
function ctxForExec(opts: { approvalMode: boolean; approve: boolean }) {
  const requestApproval = vi.fn(
    async (_serverId: string, _command: string, _reason: string) => opts.approve,
  );
  const exec = vi.fn(async () => ({
    stdout: 'ok',
    stderr: '',
    exitCode: 0,
    truncated: false,
    timedOut: false,
  }));
  const emit = vi.fn();
  const ctx = {
    cm: { exec },
    approvalMode: opts.approvalMode,
    emit,
    requestApproval,
  } as unknown as AgentToolContext;
  return { tools: buildTools(ctx), requestApproval, exec };
}

describe('runCommand seatbelt', () => {
  it('forces confirmation for a catastrophic command even in full-auto mode', async () => {
    const { tools, requestApproval, exec } = ctxForExec({
      approvalMode: false,
      approve: false,
    });
    const res = await tools.runCommand.execute!(
      { serverId: 's1', command: 'rm -rf /', timeoutSec: 60, description: 'x' },
      {} as never,
    );
    expect(requestApproval).toHaveBeenCalledOnce();
    expect(requestApproval.mock.calls[0][2]).toMatch(/safety guard/i);
    // Denied → the command must never reach the server.
    expect(exec).not.toHaveBeenCalled();
    expect(res).toMatchObject({ approved: false });
  });

  it('runs a benign command in full-auto without asking for approval', async () => {
    const { tools, requestApproval, exec } = ctxForExec({
      approvalMode: false,
      approve: true,
    });
    const res = await tools.runCommand.execute!(
      {
        serverId: 's1',
        command: 'systemctl restart nginx',
        timeoutSec: 60,
        description: 'x',
      },
      {} as never,
    );
    expect(requestApproval).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ exitCode: 0 });
  });

  it('asks for confirmation on every command when approval mode is on', async () => {
    const { tools, requestApproval, exec } = ctxForExec({
      approvalMode: true,
      approve: true,
    });
    await tools.runCommand.execute!(
      { serverId: 's1', command: 'ls -la', timeoutSec: 60, description: 'x' },
      {} as never,
    );
    expect(requestApproval).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledOnce();
  });
});

describe('requestDatabaseBackupSetup', () => {
  it('renders the backup form and returns the submitted values', async () => {
    const { tools, requestForm } = ctxWithForm(() => ({
      engine: 'postgresql',
      schedule: 'Every day (03:00)',
      retentionDays: '7',
      offsite: 'true',
    }));
    const res = await tools.requestDatabaseBackupSetup.execute!(
      { detectedEngine: 'postgresql', suggestedDatabase: undefined },
      {} as never,
    );
    expect(requestForm).toHaveBeenCalledOnce();
    const spec = requestForm.mock.calls[0][0];
    expect(spec.title).toMatch(/backups/i);
    expect(spec.fields.map((f) => f.key)).toContain('schedule');
    expect(res).toEqual({
      submitted: true,
      values: {
        engine: 'postgresql',
        schedule: 'Every day (03:00)',
        retentionDays: '7',
        offsite: 'true',
      },
    });
  });

  it('reports a cancel instead of guessing', async () => {
    const { tools } = ctxWithForm(() => null);
    const res = await tools.requestDatabaseBackupSetup.execute!(
      { detectedEngine: undefined, suggestedDatabase: undefined },
      {} as never,
    );
    expect(res).toMatchObject({ submitted: false });
  });
});

describe('requestS3StorageSetup', () => {
  it('writes the keys via main and never returns the secret to the model', async () => {
    const { tools, requestForm, writeS3Credentials } = ctxWithForm(() => ({
      provider: 'Cloudflare R2',
      bucket: 'shop-images',
      region: 'auto',
      accessKeyId: 'AKIA123',
      secretAccessKey: 's3cret',
    }));
    const res = await tools.requestS3StorageSetup.execute!(
      { serverId: 's1', purpose: 'image-uploads', appName: 'shop-api' },
      {} as never,
    );
    const spec = requestForm.mock.calls[0][0];
    expect(spec.title).toContain('shop-api');
    expect(
      spec.fields.find((f) => f.key === 'secretAccessKey')?.type,
    ).toBe('password');
    // main was handed the secret to write server-side.
    expect(writeS3Credentials).toHaveBeenCalledOnce();
    expect(writeS3Credentials.mock.calls[0][0]).toMatchObject({
      serverId: 's1',
      purpose: 'image-uploads',
    });
    // The tool result — which becomes model context — must not contain either key.
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('s3cret');
    expect(serialized).not.toContain('AKIA123');
    expect(res).toMatchObject({
      submitted: true,
      secretStored: true,
      envPath: '/etc/easyhost/s3-uploads.env',
      values: { bucket: 'shop-images' },
    });
  });

  it('reports a cancel instead of guessing', async () => {
    const { tools } = ctxWithForm(() => null);
    const res = await tools.requestS3StorageSetup.execute!(
      { serverId: 's1', purpose: 'backups', appName: undefined },
      {} as never,
    );
    expect(res).toMatchObject({ submitted: false });
  });
});
