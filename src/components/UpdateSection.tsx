/**
 * "Updates" section of the Settings dialog: shows the running version, checks
 * the GitHub releases feed on demand (main also checks on startup and every
 * 4 h), and reflects the automatic background download — once an update is
 * staged, installing is a one-click restart. Falls back to the releases page
 * on platforms where self-install isn't possible.
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { CloudDownloadIcon, ExternalLinkIcon, Loader2Icon, RefreshIcon } from '@/lib/icons';
import type { UpdateState } from '@/shared/ipc-types';

export function UpdateSection() {
  const [state, setState] = useState<UpdateState | null>(null);

  useEffect(() => {
    void window.easyhost.updates.state().then(setState);
    return window.easyhost.updates.onState(setState);
  }, []);

  if (!state) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
        <Loader2Icon className="size-3.5 animate-spin" /> Checking…
      </div>
    );
  }

  const busy = state.status === 'checking' || state.status === 'downloading' || state.status === 'installing';

  return (
    <div className="grid gap-2">
      <div className="surface-panel flex items-center gap-3 p-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold tracking-[-0.015em] text-ink">
            Tevada DevOps {state.currentVersion}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {state.status === 'disabled'
              ? state.disabledReason
              : state.status === 'checking'
                ? 'Checking for updates…'
                : state.status === 'downloading'
                  ? `Downloading v${state.availableVersion}… ${Math.round(state.downloadPercent ?? 0)}%`
                  : state.status === 'downloaded'
                    ? `Version ${state.availableVersion} is ready — restart to finish installing.`
                    : state.status === 'installing'
                      ? 'Installing — the app will restart itself.'
                      : state.status === 'available'
                        ? `Version ${state.availableVersion} is available.`
                        : state.status === 'up-to-date'
                          ? 'You are on the latest version.'
                          : state.status === 'error'
                            ? `Update check failed: ${state.error}`
                            : 'Updates are checked automatically in the background.'}
          </p>
        </div>
        {state.status !== 'disabled' &&
          state.status !== 'available' &&
          state.status !== 'downloaded' && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void window.easyhost.updates.check()}
          >
            {state.status === 'checking' ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <RefreshIcon className="size-3.5" />
            )}
            Check now
          </Button>
        )}
        {state.status === 'downloaded' && (
          <div className="flex items-center gap-2">
            {state.releaseUrl && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void window.easyhost.updates.openReleases()}
                title="Open the release notes on GitHub"
              >
                Notes
                <ExternalLinkIcon className="size-3.5" />
              </Button>
            )}
            <Button
              variant="prominent"
              size="sm"
              onClick={() => void window.easyhost.updates.install()}
            >
              <CloudDownloadIcon className="size-3.5" />
              Restart to update
            </Button>
          </div>
        )}
        {state.status === 'available' && (
          <div className="flex items-center gap-2">
            {state.releaseUrl && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void window.easyhost.updates.openReleases()}
                title="Open the release notes on GitHub"
              >
                Notes
                <ExternalLinkIcon className="size-3.5" />
              </Button>
            )}
            {state.canInstallInApp ? (
              <Button
                variant="prominent"
                size="sm"
                onClick={() => void window.easyhost.updates.install()}
              >
                <CloudDownloadIcon className="size-3.5" />
                Update to {state.availableVersion}
              </Button>
            ) : (
              <Button
                variant="prominent"
                size="sm"
                onClick={() => void window.easyhost.updates.openReleases()}
              >
                Get it on GitHub
                <ExternalLinkIcon className="size-3.5" />
              </Button>
            )}
          </div>
        )}
      </div>

      {(state.status === 'downloading' || state.status === 'installing') && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${Math.round(state.downloadPercent ?? 0)}%` }}
          />
        </div>
      )}

      {(state.status === 'available' || state.status === 'downloaded') && state.error && (
        <p className="text-[11px] text-destructive" role="alert">
          {state.error} — you can retry, or download it from the releases page.
        </p>
      )}
    </div>
  );
}
