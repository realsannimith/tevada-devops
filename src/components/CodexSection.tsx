/**
 * "Codex" section of the Settings dialog: sign in with a ChatGPT subscription
 * so the agent can run on Codex WITHOUT an OpenAI API key. Mirrors GithubSection
 * — the OAuth tokens never reach the renderer; main does the browser flow and
 * encrypted storage, and this UI only sees `CodexStatus` metadata + auth events.
 *
 * Signing in here also selects Codex as the active AI provider (a convenience so
 * the user doesn't have to also flip the provider in the AI Provider section).
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ConfirmButton';
import { OpenaiIcon } from '@/lib/brand-icons';
import { Loader2Icon } from '@/lib/icons';
import { cn } from '@/lib/utils';
import { DEFAULT_MODEL } from '@/shared/providers';
import type { AppSettings, CodexStatus } from '@/shared/ipc-types';

export function CodexSection({
  onPatch,
}: {
  /** Patch AppSettings — used to switch the active provider to Codex on sign-in. */
  onPatch?: (p: Partial<AppSettings>) => Promise<void>;
}) {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await window.easyhost.codex.status());
  }, []);

  useEffect(() => {
    void refresh();
    const unsub = window.easyhost.codex.onAuthEvent((e) => {
      if (e.phase === 'success') {
        setPending(false);
        setError(null);
        void refresh();
        // Make Codex the active provider so the next run uses the subscription.
        void onPatch?.({ aiProvider: 'codex', aiModel: DEFAULT_MODEL.codex });
      } else if (e.phase === 'error') {
        setPending(false);
        setError(e.error);
      }
    });
    return () => {
      unsub();
      // Cancel a dangling login if the dialog closes mid-flow.
      void window.easyhost.codex.cancel();
    };
  }, [refresh, onPatch]);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const r = await window.easyhost.codex.login();
      if (!r.ok) setError(r.error ?? 'Could not start sign-in.');
      else setPending(true);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    await window.easyhost.codex.cancel();
    setPending(false);
  }

  async function disconnect() {
    setBusy(true);
    try {
      setStatus(await window.easyhost.codex.logout());
    } finally {
      setBusy(false);
    }
  }

  const account = status?.account;

  return (
    <div className="grid gap-2">
      {!status ? (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" /> Checking…
        </div>
      ) : pending ? (
        <div className="surface-panel grid gap-2 p-4 text-center">
          <p className="text-xs text-muted-foreground">
            Complete the sign-in in your browser — we opened the ChatGPT
            authorization page for you.
          </p>
          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" /> Waiting for browser
            sign-in…
          </div>
          <Button variant="ghost" size="sm" onClick={cancel}>
            Cancel
          </Button>
        </div>
      ) : account ? (
        <>
          {account.needsReauth && (
            <div className="surface-panel flex items-center gap-3 p-3">
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                Your ChatGPT session expired. Sign in again to keep the agent
                running on your subscription.
              </p>
              <Button variant="prominent" size="sm" onClick={signIn} disabled={busy}>
                Sign in
              </Button>
            </div>
          )}

          <div className="surface-panel flex items-center gap-3 p-3">
            <OpenaiIcon className="size-8 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold tracking-[-0.015em] text-ink">
                {account.planLabel ?? 'ChatGPT'}
              </p>
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                {account.email ?? 'Signed in'}
              </p>
            </div>
            <ConfirmButton
              variant="outline"
              size="sm"
              disabled={busy}
              confirmTitle="Disconnect Codex?"
              confirmDescription="You’re signed out of your ChatGPT subscription and the saved Codex tokens are removed from this device. The agent can no longer run on Codex until you sign in again."
              confirmLabel="Disconnect"
              onConfirm={disconnect}
            >
              Disconnect
            </ConfirmButton>
          </div>

          <p className="text-[11px] text-muted-foreground">
            The agent uses your ChatGPT subscription — no OpenAI API key needed.
            Choose the Codex model below.
          </p>
        </>
      ) : (
        <div className="grid gap-2">
          <Button
            variant="prominent"
            onClick={signIn}
            disabled={busy || !status.secretsAvailable}
            className="justify-center"
          >
            <OpenaiIcon className="size-4" />
            {busy ? 'Opening browser…' : 'Sign in with ChatGPT'}
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Use your ChatGPT Plus / Pro / Team / Edu subscription to run the agent
            on Codex — no API key required. We open OpenAI&apos;s sign-in page in
            your browser; the login is stored encrypted on this machine and never
            leaves except to call OpenAI.
          </p>
          {!status.secretsAvailable && (
            <p className="text-[11px] text-destructive" role="alert">
              OS secure storage is unavailable, so the sign-in can&apos;t be saved
              safely. On Linux, ensure a keyring (gnome-keyring / kwallet) is
              running.
            </p>
          )}
        </div>
      )}

      {error && (
        <p className={cn('text-[11px] text-destructive')} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
