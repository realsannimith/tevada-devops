/**
 * Google Drive sync settings. OAuth and uploads happen in main; this component
 * only shows metadata and lets the user connect, disconnect, or sync now.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ConfirmButton';
import {
  SettingsRow,
  SettingsSection,
} from '@/components/settings/SettingsPrimitives';
import {
  CheckIcon,
  CloudDownloadIcon,
  CloudUploadIcon,
  Loader2Icon,
  RefreshIcon,
  XIcon,
} from '@/lib/icons';
import type { GoogleDriveStatus } from '@/shared/ipc-types';

// Survives the post-restore renderer reload so we can confirm it afterwards.
const RESTORE_FLAG = 'easyhost:drive-restored';

function formatDate(ts: number | undefined): string {
  if (!ts) return 'Not synced yet';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ts));
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function GoogleDriveSection() {
  const [status, setStatus] = useState<GoogleDriveStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [authPending, setAuthPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await window.easyhost.googleDrive.status());
  }, []);

  useEffect(() => {
    void refresh();
    const restored = sessionStorage.getItem(RESTORE_FLAG);
    if (restored !== null) {
      sessionStorage.removeItem(RESTORE_FLAG);
      const n = Number(restored);
      setMessage(
        `Restored ${n} item${n === 1 ? '' : 's'} from Google Drive.`,
      );
    }
    const unsub = window.easyhost.googleDrive.onAuthEvent((event) => {
      if (event.phase === 'pending') {
        setAuthPending(true);
        setError(null);
      } else if (event.phase === 'success') {
        setAuthPending(false);
        setMessage('Connected. First sync started…');
        void refresh();
      } else {
        setAuthPending(false);
        setError(event.error);
      }
    });
    // Main pushes status whenever a sync starts/finishes (incl. the background
    // first sync after connect). Reflect completion instead of polling.
    const unsubStatus = window.easyhost.googleDrive.onStatusChange((next) => {
      setStatus((prev) => {
        const wasSyncing = prev?.syncInProgress ?? false;
        if (wasSyncing && !next.syncInProgress) {
          if (next.account?.syncError) setError(next.account.syncError);
          else if (next.account?.lastSyncedAt) {
            setMessage('Synced to Google Drive.');
            setError(null);
          }
        }
        return next;
      });
    });
    return () => {
      unsub();
      unsubStatus();
      void window.easyhost.googleDrive.cancel();
    };
  }, [refresh]);

  async function connect() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await window.easyhost.googleDrive.login();
      if (!result.ok) setError(result.error ?? 'Could not start Google sign-in.');
    } finally {
      setBusy(false);
    }
  }

  async function cancelConnect() {
    setError(null);
    setMessage(null);
    await window.easyhost.googleDrive.cancel();
    setAuthPending(false);
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setStatus(await window.easyhost.googleDrive.disconnect());
    } finally {
      setBusy(false);
    }
  }

  async function syncNow() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await window.easyhost.googleDrive.syncNow();
      if (result.ok === false) {
        setError(result.error);
      } else {
        setMessage(result.skipped ? 'Already up to date.' : 'Synced to Google Drive.');
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await window.easyhost.googleDrive.restore();
      if (result.ok === false) {
        setError(result.error);
        setBusy(false);
        return;
      }
      // Main wrote the restored store/secrets/runtime files to disk, but every
      // open view is still showing data it loaded into memory earlier. Reload
      // the renderer so servers, chats, settings, etc. re-read the restored
      // state. A confirmation is stashed to show after the reload.
      sessionStorage.setItem(RESTORE_FLAG, String(result.fileCount));
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function keepLocal() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await window.easyhost.googleDrive.keepLocal();
      if (result.ok === false) setError(result.error);
      else setMessage('Kept this device’s data and updated the Drive backup.');
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const account = status?.account;
  const syncBits = [
    account?.lastSyncFileCount ? `${account.lastSyncFileCount} files` : null,
    formatBytes(account?.lastSyncBytes) || null,
  ].filter(Boolean);

  if (!status) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
        <Loader2Icon className="size-3.5 animate-spin" /> Checking Google Drive…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsSection title="Connection">
        <SettingsRow
          title="Google Drive"
          description={
            status.connected
              ? 'EasyHost automatically saves a backup snapshot to your hidden Google Drive app data.'
              : 'Connect Google Drive to keep EasyHost settings, chat history, server metadata, and encrypted credential blobs backed up.'
          }
          status={
            !status.secretsAvailable
              ? 'OS secure storage is unavailable, so Drive tokens cannot be saved.'
              : !status.clientConfigured
                ? 'Set GOOGLE_DRIVE_CLIENT_ID in .env to enable browser sign-in.'
                : account?.needsReauth
                  ? 'Google Drive needs to be reconnected.'
                  : undefined
          }
          control={
            status.connected ? (
              <ConfirmButton
                variant="outline"
                size="sm"
                disabled={busy}
                confirmTitle="Disconnect Google Drive?"
                confirmDescription="EasyHost stops backing up to Google Drive and the saved Drive tokens are removed from this device. Your existing Drive backup is left in place. You can reconnect anytime."
                confirmLabel="Disconnect"
                onConfirm={disconnect}
              >
                Disconnect
              </ConfirmButton>
            ) : authPending ? (
              <>
                <Button variant="outline" size="sm" onClick={cancelConnect}>
                  <XIcon className="size-3.5" />
                  Cancel
                </Button>
                <Button variant="prominent" size="sm" disabled>
                  <Loader2Icon className="size-3.5 animate-spin" />
                  Waiting…
                </Button>
              </>
            ) : (
              <Button
                variant="prominent"
                size="sm"
                onClick={connect}
                disabled={busy || !status.clientConfigured || !status.secretsAvailable}
              >
                {busy ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <CloudUploadIcon className="size-3.5" />
                )}
                Connect
              </Button>
            )
          }
        >
          {account && (
            <div className="mt-3 flex items-center gap-3 rounded-md border border-border bg-secondary/30 p-3">
              {account.picture ? (
                <img
                  src={account.picture}
                  alt=""
                  className="size-8 rounded-full border border-border"
                />
              ) : (
                <CloudUploadIcon className="size-8 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-ink">
                  {account.name || account.email}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {account.email}
                </p>
              </div>
            </div>
          )}
        </SettingsRow>
      </SettingsSection>

      {status.connected && status.remoteBackupPending && (
        <SettingsSection title="Restore">
          <div className="rounded-md border border-warning/40 bg-warning/10 p-3">
            <p className="text-xs font-medium text-ink">
              A backup already exists on Google Drive.
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Restore it to bring that data back onto this device, or keep this
              device’s current data and overwrite the Drive backup. Automatic
              sync is paused until you choose.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="prominent"
                size="sm"
                onClick={restore}
                disabled={busy || status.restoreInProgress}
              >
                {busy || status.restoreInProgress ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <CloudDownloadIcon className="size-3.5" />
                )}
                Restore from Drive
              </Button>
              <Button variant="outline" size="sm" onClick={keepLocal} disabled={busy}>
                Keep this device’s data
              </Button>
            </div>
          </div>
        </SettingsSection>
      )}

      {status.connected && !status.remoteBackupPending && (
        <SettingsSection title="Backup">
          <SettingsRow
            title="Drive sync"
            description="Backups include app settings and encrypted credential blobs; secrets are not decrypted for sync."
            status={
              account?.syncError ? (
                <span className="text-destructive">{account.syncError}</span>
              ) : (
                <>
                  Last sync: {formatDate(account?.lastSyncedAt)}
                  {syncBits.length > 0 ? ` · ${syncBits.join(' · ')}` : ''}
                </>
              )
            }
            control={
              <Button
                variant="outline"
                size="sm"
                onClick={syncNow}
                disabled={busy || status.syncInProgress}
              >
                {busy || status.syncInProgress ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <RefreshIcon className="size-3.5" />
                )}
                Sync now
              </Button>
            }
          />
        </SettingsSection>
      )}

      {message && (
        <p className="flex items-center gap-1 text-[11px] text-success">
          <CheckIcon className="size-3.5" /> {message}
        </p>
      )}
      {error && (
        <p className="text-[11px] text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
