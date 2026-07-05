/**
 * Lets the user retrieve — or, if nothing was auto-saved, manually record —
 * the credentials for a database artifact. Auto-save happens via the
 * saveDatabaseCredential agent tool during a "Set up a database" wizard run
 * (see agent/playbooks.ts); the manual form here covers everything else:
 * databases that predate this feature, or ones set up outside the wizard.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AlertTriangleIcon,
  CheckIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  Loader2Icon,
  SparklesIcon,
  TrashIcon,
} from '@/lib/icons';
import { cn } from '@/lib/utils';
import type { DatabaseCredential, DatabaseCredentialMeta } from '@/shared/ipc-types';

/** What the dialog should show: an existing saved credential to reveal, or
 *  the shell of a database artifact with nothing saved yet, to fill in. */
export type CredentialDialogTarget =
  | { mode: 'view'; meta: DatabaseCredentialMeta }
  | {
      mode: 'add';
      serverId: string;
      engine: string;
      host: string;
      port: number;
      /** Set when the artifact is a Docker container — enables "Detect from container". */
      containerName?: string;
    };

const FIELD_CLASS = 'h-8 border-border bg-secondary text-xs shadow-none';

export function DatabaseCredentialDialog({
  target,
  onOpenChange,
  onSaved,
  onDeleted,
}: {
  target: CredentialDialogTarget | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  onDeleted: (id: string) => void;
}) {
  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {target?.mode === 'view' ? (
          <ViewCredential
            meta={target.meta}
            onDeleted={(id) => {
              onDeleted(id);
              onOpenChange(false);
            }}
          />
        ) : target?.mode === 'add' ? (
          <AddCredential
            target={target}
            onSaved={() => {
              onSaved();
              onOpenChange(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ViewCredential({
  meta,
  onDeleted,
}: {
  meta: DatabaseCredentialMeta;
  onDeleted: (id: string) => void;
}) {
  const [credential, setCredential] = useState<DatabaseCredential | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCredential(null);
    setError(null);
    setShowPassword(false);
    setLoading(true);
    window.easyhost.credentials
      .reveal(meta.id)
      .then((c) => {
        if (cancelled) return;
        if (c) setCredential(c);
        else setError('These credentials are no longer available.');
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load credentials.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [meta]);

  async function forget() {
    await window.easyhost.credentials.delete(meta.id);
    onDeleted(meta.id);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Database credentials</DialogTitle>
        <DialogDescription>
          Saved when this database was set up — kept encrypted on this device.
        </DialogDescription>
      </DialogHeader>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          Loading…
        </div>
      ) : error ? (
        <p className="py-4 text-xs text-destructive">{error}</p>
      ) : credential ? (
        <div className="space-y-3">
          {/* Shared identity + secret — the same across both endpoints. */}
          <div className="space-y-2">
            {credential.database && (
              <CredField label="Database" value={credential.database} />
            )}
            {credential.username && (
              <CredField label="Username" value={credential.username} />
            )}
            <CredField
              label="Password"
              value={credential.password}
              masked={!showPassword}
              trailing={
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="shrink-0 rounded-sm p-1 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
                  title={showPassword ? 'Hide password' : 'Show password'}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? (
                    <EyeOffIcon className="size-3.5" />
                  ) : (
                    <EyeIcon className="size-3.5" />
                  )}
                </button>
              }
            />
          </div>

          {/* Internal endpoint — always reachable from the server itself. */}
          <CredSection
            title="Internal"
            hint="From apps & containers on the same server."
          >
            <CredField label="Host" value={credential.host} />
            <CredField label="Port" value={String(credential.port)} />
            <CredField
              label="Connection string"
              value={credential.connectionString}
              masked={!showPassword}
              multiline
            />
          </CredSection>

          {/* External endpoint — only when the database is exposed publicly. */}
          {credential.externalHost && credential.externalConnectionString ? (
            <CredSection title="External" hint="From anywhere over the internet.">
              <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-2 text-[11px] text-warning">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Reachable from the internet — protected only by this password.
                </span>
              </div>
              <CredField label="Host" value={credential.externalHost} />
              <CredField label="Port" value={String(credential.port)} />
              <CredField
                label="Connection string"
                value={credential.externalConnectionString}
                masked={!showPassword}
                multiline
              />
            </CredSection>
          ) : null}
        </div>
      ) : null}

      <div className="-mx-5 -mb-5 flex items-center justify-between rounded-b-2xl border-t border-border bg-muted/40 px-5 py-3">
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={forget}
          disabled={!credential}
        >
          <TrashIcon className="size-3.5" />
          Forget credentials
        </Button>
      </div>
    </>
  );
}

function AddCredential({
  target,
  onSaved,
}: {
  target: {
    serverId: string;
    engine: string;
    host: string;
    port: number;
    containerName?: string;
  };
  onSaved: () => void;
}) {
  const isRedis = target.engine === 'redis';
  const [host, setHost] = useState(target.host);
  const [port, setPort] = useState(String(target.port));
  const [database, setDatabase] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectResult, setDetectResult] = useState<'found' | 'not-found' | null>(null);

  const portNum = Number(port);
  const valid = host.trim() && Number.isFinite(portNum) && portNum > 0 && password.trim();

  const detect = useCallback(async () => {
    if (!target.containerName) return;
    setDetecting(true);
    setDetectResult(null);
    setError(null);
    try {
      const guess = await window.easyhost.credentials.recoverFromContainer(
        target.serverId,
        target.containerName,
        target.engine,
      );
      if (guess) {
        setPassword(guess.password);
        if (guess.username) setUsername(guess.username);
        if (guess.database) setDatabase(guess.database);
        setDetectResult('found');
      } else {
        setDetectResult('not-found');
      }
    } catch {
      setDetectResult('not-found');
    } finally {
      setDetecting(false);
    }
  }, [target.containerName, target.serverId, target.engine]);

  // Container-backed database: try to read the password straight off the
  // container the moment the dialog opens, so "where do I get the credentials"
  // is answered without an extra click. Falls back to the manual form.
  useEffect(() => {
    if (target.containerName) void detect();
  }, [detect, target.containerName]);

  async function save() {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      await window.easyhost.credentials.save({
        serverId: target.serverId,
        engine: target.engine,
        host: host.trim(),
        port: portNum,
        database: isRedis ? undefined : database.trim() || undefined,
        username: isRedis ? undefined : username.trim() || undefined,
        password,
      });
      onSaved();
    } catch {
      setError('Failed to save credentials.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Save credentials</DialogTitle>
        <DialogDescription>
          No saved credentials for this database yet — enter them once and
          retrieve them here anytime. Kept encrypted on this device.
        </DialogDescription>
      </DialogHeader>

      {target.containerName && (
        <div className="space-y-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-full gap-1.5 text-xs"
            onClick={detect}
            disabled={detecting}
          >
            {detecting ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <SparklesIcon className="size-3.5" />
            )}
            {detecting ? 'Checking container…' : 'Detect from container'}
          </Button>
          {detectResult === 'found' && (
            <p className="text-[11px] text-success">
              Found it — filled in below. Review, then save.
            </p>
          )}
          {detectResult === 'not-found' && (
            <p className="text-[11px] text-muted-foreground">
              Couldn&rsquo;t read it off the container — fill it in manually below.
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2.5">
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">Host</Label>
          <Input value={host} onChange={(e) => setHost(e.target.value)} className={cn(FIELD_CLASS, 'font-mono')} />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">Port</Label>
          <Input
            value={port}
            onChange={(e) => setPort(e.target.value)}
            inputMode="numeric"
            className={cn(FIELD_CLASS, 'font-mono')}
          />
        </div>
        {!isRedis && (
          <>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Database</Label>
              <Input
                value={database}
                onChange={(e) => setDatabase(e.target.value)}
                placeholder="appdb"
                className={cn(FIELD_CLASS, 'font-mono')}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Username</Label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="appuser"
                className={cn(FIELD_CLASS, 'font-mono')}
              />
            </div>
          </>
        )}
        <div className="col-span-2 space-y-1">
          <Label className="text-[11px] text-muted-foreground">Password</Label>
          <Input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="text"
            placeholder="the password this database was set up with"
            className={cn(FIELD_CLASS, 'font-mono')}
          />
        </div>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="-mx-5 -mb-5 flex items-center justify-end rounded-b-2xl border-t border-border bg-muted/40 px-5 py-3">
        <Button size="sm" onClick={save} disabled={!valid || saving}>
          {saving && <Loader2Icon className="size-3.5 animate-spin" />}
          Save
        </Button>
      </div>
    </>
  );
}

/** A labeled group of credential fields — the "Internal" / "External" cards,
 *  mirroring Dokploy's split of a database's two reachable endpoints. */
function CredSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2 rounded-xl border border-border bg-muted/30 p-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold text-foreground">{title}</span>
        {hint && (
          <span className="truncate text-[10px] text-muted-foreground">{hint}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function CredField({
  label,
  value,
  masked,
  multiline,
  trailing,
}: {
  label: string;
  value: string;
  masked?: boolean;
  multiline?: boolean;
  trailing?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const display = masked ? '•'.repeat(Math.min(value.length, 28)) : value;

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="space-y-1">
      <span className="text-[10px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
        {label}
      </span>
      <div className="flex items-center gap-1 rounded-lg border border-border bg-secondary px-2.5 py-1.5">
        <span
          className={cn(
            'min-w-0 flex-1 font-mono text-[11px] text-foreground',
            multiline ? 'break-all' : 'truncate',
          )}
        >
          {display}
        </span>
        {trailing}
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded-sm p-1 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
          title={`Copy ${label.toLowerCase()}`}
          aria-label={`Copy ${label.toLowerCase()}`}
        >
          {copied ? (
            <CheckIcon className="size-3.5 text-success" />
          ) : (
            <CopyIcon className="size-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}
