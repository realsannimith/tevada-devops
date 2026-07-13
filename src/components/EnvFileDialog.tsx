/**
 * Environment (.env) editor for a deployed app — opened from the Artifacts tab
 * so the user configures a project's variables right where they see the
 * project. A clean KEY / VALUE table (Render-style): column headers, boxed
 * fields, a per-row reveal toggle, and — because a container bakes its env at
 * creation time — a Redeploy action so saved values actually take effect.
 *
 * Reads/writes go through the deploys IPC (main/deployments.ts): the file is
 * root-owned 600, values are secrets and cross IPC only on this explicit open.
 * Redeploy runs the app's own registered deploy script (build → health check →
 * rollback); it's only available when such a script exists.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  applyEnvEdits,
  isValidEnvKey,
  parseEnvFile,
  type EnvEntry,
} from '@/lib/envFile';
import {
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  Loader2Icon,
  PlusIcon,
  RefreshIcon,
  XIcon,
} from '@/lib/icons';

const MASK = '••••••••••••';

/** What the dialog edits. `script` present ⇒ one-click redeploy is possible. */
export type EnvTarget = {
  serverId: string;
  appName: string;
  /** Resolved env-file path (registered, or the <dir>/.env fallback). */
  envFile: string;
  /** False when the path was inferred — surfaces a "will be created" hint. */
  registered: boolean;
  /** Registered deploy script; without it, redeploy is unavailable. */
  script?: string;
};

export function EnvFileDialog({
  target,
  onOpenChange,
  onRedeployStarted,
}: {
  target: EnvTarget | null;
  onOpenChange: (open: boolean) => void;
  onRedeployStarted?: () => void;
}) {
  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-0 overflow-hidden p-0 sm:max-w-3xl">
        {target && (
          <EnvEditor
            // Remount when the app changes so stale state can't leak across.
            key={`${target.serverId}:${target.appName}`}
            target={target}
            onRedeployStarted={onRedeployStarted}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

type DraftRow = { id: number; key: string; value: string };
let draftRowId = 0;

function EnvEditor({
  target,
  onRedeployStarted,
}: {
  target: EnvTarget;
  onRedeployStarted?: () => void;
}) {
  const { serverId, appName, envFile, registered, script } = target;
  const [original, setOriginal] = useState<string | null>(null);
  const [entries, setEntries] = useState<EnvEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DraftRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadEnv = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await window.easyhost.deploys.envRead(serverId, envFile);
      if (res.ok === false) {
        setLoadError(res.error);
      } else {
        setOriginal(res.content);
        setEntries(parseEnvFile(res.content));
      }
    } catch {
      setLoadError('Could not read the env file.');
    }
  }, [serverId, envFile]);

  useEffect(() => {
    void loadEnv();
  }, [loadEnv]);

  const startEditing = () => {
    setDraft(entries.map((e) => ({ id: draftRowId++, ...e })));
    setNotice(null);
    setEditing(true);
  };

  const draftProblem = useMemo(() => {
    const keys = draft.map((r) => r.key.trim());
    if (keys.some((k) => !isValidEnvKey(k)))
      return 'Keys must look like DATABASE_URL (letters, digits, _).';
    if (new Set(keys).size !== keys.length) return 'Duplicate keys.';
    return null;
  }, [draft]);

  const triggerRedeploy = useCallback(
    async (successMsg: string) => {
      if (!script) return;
      const dep = await window.easyhost.deploys.redeploy(serverId, script);
      setNotice(dep.ok === false ? `Redeploy did not start: ${dep.error}` : successMsg);
      if (dep.ok !== false) onRedeployStarted?.();
    },
    [serverId, script, onRedeployStarted],
  );

  const save = async (thenDeploy: boolean) => {
    if (original === null || draftProblem) return;
    setBusy(true);
    setNotice(null);
    try {
      const next = applyEnvEdits(
        original,
        draft.map((r) => ({ key: r.key.trim(), value: r.value })),
      );
      const res = await window.easyhost.deploys.envWrite(serverId, envFile, next);
      if (res.ok === false) {
        setNotice(res.error);
        return;
      }
      setEditing(false);
      await loadEnv();
      if (thenDeploy && script) {
        await triggerRedeploy('Saved — redeploy started. Watch it in the Deploys tab.');
      } else {
        setNotice(
          script
            ? 'Saved. Hit Redeploy to apply the new values to the running app.'
            : 'Saved. Values apply next time this app is deployed.',
        );
      }
    } catch {
      setNotice('Saving failed.');
    } finally {
      setBusy(false);
    }
  };

  const redeployNow = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await triggerRedeploy('Redeploy started. Watch it in the Deploys tab.');
    } catch {
      setNotice('Redeploy failed to start.');
    } finally {
      setBusy(false);
    }
  };

  const copyEnv = async () => {
    if (original === null) return;
    try {
      await navigator.clipboard.writeText(original);
      setNotice('Copied the .env contents to your clipboard.');
    } catch {
      setNotice('Could not access the clipboard.');
    }
  };

  const fileName = envFile.split('/').pop() ?? '.env';

  return (
    <div className="flex max-h-[85vh] flex-col">
      {/* Header */}
      <DialogHeader className="space-y-1 border-b border-border pb-4 pl-6 pr-14 pt-5 text-left">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <DialogTitle className="text-[15px] font-semibold tracking-[-0.01em] text-ink">
              Environment Variables
            </DialogTitle>
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Set config and secrets (such as API keys) for{' '}
              <span className="font-medium text-ink">{appName}</span>, then read
              them from your code.
              <br />
              <span className="font-mono text-[11px] text-muted-foreground/70">
                {envFile}
              </span>
            </p>
          </div>
          {!editing && original !== null && (
            <div className="flex shrink-0 items-center gap-1.5">
              {entries.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 px-2.5 text-[12px]"
                  onClick={() => void copyEnv()}
                >
                  <CopyIcon className="size-3.5" />
                  Copy
                </Button>
              )}
              <Button
                size="sm"
                className="h-7 px-3 text-[12px]"
                onClick={startEditing}
              >
                Edit
              </Button>
            </div>
          )}
        </div>
      </DialogHeader>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {loadError ? (
          <p className="text-[12px] text-destructive">{loadError}</p>
        ) : original === null ? (
          <p className="flex items-center gap-2 py-6 text-[12px] text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" />
            Loading…
          </p>
        ) : editing ? (
          <EnvTable header>
            {draft.map((row) => (
              <div key={row.id} className="grid grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)_auto] items-center gap-2">
                <Input
                  value={row.key}
                  placeholder="KEY"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoComplete="off"
                  className="h-9 border-border bg-secondary font-mono text-[12px]"
                  onChange={(e) =>
                    setDraft(draft.map((r) => (r.id === row.id ? { ...r, key: e.target.value } : r)))
                  }
                />
                <Input
                  value={row.value}
                  placeholder="value"
                  spellCheck={false}
                  autoComplete="off"
                  className="h-9 border-border bg-secondary font-mono text-[12px]"
                  onChange={(e) =>
                    setDraft(draft.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)))
                  }
                />
                <Button
                  variant="destructive"
                  size="sm"
                  className="size-9 shrink-0 p-0"
                  aria-label={`Remove ${row.key || 'variable'}`}
                  onClick={() => setDraft(draft.filter((r) => r.id !== row.id))}
                >
                  <XIcon className="size-4" />
                </Button>
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="mt-0.5 h-8 w-fit gap-1.5 px-2 text-[12px] text-muted-foreground"
              onClick={() => setDraft([...draft, { id: draftRowId++, key: '', value: '' }])}
            >
              <PlusIcon className="size-3.5" />
              Add variable
            </Button>
          </EnvTable>
        ) : entries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
            <p className="text-[13px] font-medium text-ink">
              {original === ''
                ? `No ${fileName} yet${registered ? '' : ' — it will be created on save'}.`
                : 'No variables set yet.'}
            </p>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Hit <span className="font-medium text-ink">Edit</span> to add your
              first variable.
            </p>
          </div>
        ) : (
          <EnvTable header>
            {entries.map((e) => {
              const shown = revealed.has(e.key);
              return (
                <div key={e.key} className="grid grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)_auto] items-center gap-2">
                  <div className="truncate rounded-md border border-border bg-secondary px-3 py-2 font-mono text-[12px] text-ink">
                    {e.key}
                  </div>
                  <div className="truncate rounded-md border border-border bg-secondary px-3 py-2 font-mono text-[12px] text-muted-foreground">
                    {shown ? e.value || '(empty)' : MASK}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="size-9 shrink-0 p-0 text-muted-foreground/70"
                    aria-label={shown ? `Hide ${e.key}` : `Reveal ${e.key}`}
                    onClick={() => {
                      const next = new Set(revealed);
                      if (next.has(e.key)) next.delete(e.key);
                      else next.add(e.key);
                      setRevealed(next);
                    }}
                  >
                    {shown ? (
                      <EyeOffIcon className="size-4" />
                    ) : (
                      <EyeIcon className="size-4" />
                    )}
                  </Button>
                </div>
              );
            })}
          </EnvTable>
        )}
      </div>

      {/* Footer */}
      {original !== null && (
        <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-3">
          <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {notice ??
              (editing
                ? draftProblem ??
                  (script
                    ? 'Save writes the file; redeploy applies it to the running app.'
                    : 'No auto-deploy script yet — saved values apply on the next deploy.')
                : script
                  ? 'Changes take effect after a redeploy.'
                  : `Ask the agent to “set up auto-deploy for ${appName}” to enable one-click redeploy.`)}
          </p>

          {editing ? (
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-3 text-[12px] text-muted-foreground"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setNotice(null);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-3 text-[12px]"
                disabled={busy || !!draftProblem}
                onClick={() => void save(false)}
              >
                Save
              </Button>
              <Button
                size="sm"
                className="h-8 gap-1.5 px-3 text-[12px]"
                disabled={busy || !!draftProblem || !script}
                onClick={() => void save(true)}
              >
                {busy ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <RefreshIcon className="size-3.5" />
                )}
                Save &amp; redeploy
              </Button>
            </div>
          ) : (
            script && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0 gap-1.5 px-3 text-[12px]"
                disabled={busy}
                onClick={() => void redeployNow()}
              >
                {busy ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <RefreshIcon className="size-3.5" />
                )}
                Redeploy
              </Button>
            )
          )}
        </div>
      )}
    </div>
  );
}

/** KEY / VALUE column headers + a consistent row stack. */
function EnvTable({
  header,
  children,
}: {
  header?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      {header && (
        <div className="grid grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)_auto] gap-2 px-1">
          <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
            Key
          </span>
          <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
            Value
          </span>
          <span className="w-9" />
        </div>
      )}
      {children}
    </div>
  );
}
