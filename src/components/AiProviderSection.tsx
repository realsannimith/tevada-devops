/**
 * "AI Provider" panel of the Settings view (OpenCode-style multi-provider): a
 * LIST of every provider, each configured independently — paste an API key, set
 * a base URL, or sign in to Codex — and they all coexist. Any set-up provider
 * can be made the active one; the chat model picker then switches between them.
 *
 * Keys travel to main exactly once and are stored encrypted (OS keychain via
 * safeStorage); this UI only ever sees presence booleans (AiKeyStatus) and the
 * Codex connection status, never the secret material itself.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  SettingsRow,
  SettingsSection,
} from '@/components/settings/SettingsPrimitives';
import { CodexSection } from '@/components/CodexSection';
import { CheckIcon } from '@/lib/icons';
import { cn } from '@/lib/utils';
import type { AiKeyStatus, AppSettings, CodexStatus } from '@/shared/ipc-types';
import {
  CUSTOM_MODEL_VALUE,
  DEFAULT_MODEL,
  PROVIDER_MODELS,
  PROVIDERS,
  type ProviderId,
  type ProviderMeta,
} from '@/shared/providers';

/** A provider counts as "set up" only once it can actually run. */
function providerReady(
  meta: ProviderMeta,
  keyStatus: AiKeyStatus | null,
  codex: CodexStatus | null,
  settings: AppSettings,
): boolean {
  if (meta.subscriptionAuth) return !!codex?.connected;
  const stored = !!keyStatus?.[meta.id]?.stored;
  if (meta.needsBaseUrl) return stored && settings.aiBaseUrl.trim().length > 0;
  return stored;
}

export function AiProviderSection({
  settings,
  onPatch,
}: {
  settings: AppSettings;
  onPatch: (p: Partial<AppSettings>) => Promise<void>;
}) {
  const [keyStatus, setKeyStatus] = useState<AiKeyStatus | null>(null);
  const [codex, setCodex] = useState<CodexStatus | null>(null);
  const [expanded, setExpanded] = useState<ProviderId | null>(null);

  const reloadKeys = useCallback(async () => {
    setKeyStatus(await window.easyhost.ai.keyStatus());
  }, []);
  const reloadCodex = useCallback(async () => {
    setCodex(await window.easyhost.codex.status());
  }, []);

  useEffect(() => {
    void reloadKeys();
    void reloadCodex();
    // Codex connects/expires via its own OAuth flow — keep the row's badge live.
    const unsub = window.easyhost.codex.onAuthEvent(() => void reloadCodex());
    return () => unsub();
  }, [reloadKeys, reloadCodex]);

  const isReady = useCallback(
    (meta: ProviderMeta) => providerReady(meta, keyStatus, codex, settings),
    [keyStatus, codex, settings],
  );

  /** Make a provider the active one (used for the next agent run). */
  const useProvider = useCallback(
    async (id: ProviderId) => {
      if (settings.aiProvider === id) return;
      await onPatch({ aiProvider: id, aiModel: DEFAULT_MODEL[id] });
    },
    [onPatch, settings.aiProvider],
  );

  /** After a key is saved, if the app has no working active provider yet, adopt
   *  the one just configured so a run works immediately. */
  const afterKeyChange = useCallback(
    async (id: ProviderId) => {
      await reloadKeys();
      const activeMeta = PROVIDERS.find((p) => p.id === settings.aiProvider);
      if (activeMeta && !providerReady(activeMeta, await window.easyhost.ai.keyStatus(), codex, settings)) {
        await onPatch({ aiProvider: id, aiModel: DEFAULT_MODEL[id] });
      }
    },
    [reloadKeys, settings, codex, onPatch],
  );

  const anyReady = PROVIDERS.some(isReady);
  const activeReady = !!PROVIDERS.find((p) => p.id === settings.aiProvider && isReady(p));

  return (
    <div className="space-y-6">
      <SettingsSection title="Providers">
        {PROVIDERS.map((meta) => {
          const ready = isReady(meta);
          const active = settings.aiProvider === meta.id;
          const open = expanded === meta.id;
          return (
            <SettingsRow
              key={meta.id}
              title={meta.label}
              description={
                meta.subscriptionAuth
                  ? 'Sign in with your ChatGPT subscription — no API key needed.'
                  : meta.needsBaseUrl
                    ? 'Any OpenAI-compatible endpoint (Ollama, LM Studio, a proxy).'
                    : ready
                      ? 'API key saved — encrypted on this machine.'
                      : 'Add an API key to enable this provider.'
              }
              control={
                <>
                  {ready &&
                    (active ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">
                        <CheckIcon className="size-3" /> Active
                      </span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void useProvider(meta.id)}
                      >
                        Use
                      </Button>
                    ))}
                  {!ready && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                      Not set up
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={open}
                    onClick={() => setExpanded(open ? null : meta.id)}
                  >
                    {open
                      ? 'Close'
                      : meta.subscriptionAuth
                        ? ready
                          ? 'Manage'
                          : 'Sign in'
                        : ready
                          ? 'Edit'
                          : 'Add key'}
                  </Button>
                </>
              }
            >
              {open && (
                <div className="mt-3 border-t border-border pt-3">
                  {meta.subscriptionAuth ? (
                    <CodexSection onPatch={onPatch} />
                  ) : (
                    <ProviderKeyEditor
                      meta={meta}
                      stored={!!keyStatus?.[meta.id]?.stored}
                      baseUrl={settings.aiBaseUrl}
                      onSaveKey={async (key) => {
                        await window.easyhost.ai.setKey(meta.id, key);
                        await afterKeyChange(meta.id);
                      }}
                      onRemoveKey={async () => {
                        setKeyStatus(await window.easyhost.ai.clearKey(meta.id));
                      }}
                      onSaveBaseUrl={async (url) => {
                        await onPatch({ aiBaseUrl: url });
                      }}
                    />
                  )}
                </div>
              )}
            </SettingsRow>
          );
        })}
      </SettingsSection>

      {!anyReady && (
        <p className="px-2 text-[11px] text-muted-foreground">
          No provider is set up yet — add an API key above (or sign in to Codex) to
          start using the agent.
        </p>
      )}

      {activeReady && <ActiveModelSection settings={settings} onPatch={onPatch} />}
    </div>
  );
}

/** Inline API-key (and base-URL) editor for one non-subscription provider. */
function ProviderKeyEditor({
  meta,
  stored,
  baseUrl,
  onSaveKey,
  onRemoveKey,
  onSaveBaseUrl,
}: {
  meta: ProviderMeta;
  stored: boolean;
  baseUrl: string;
  onSaveKey: (key: string) => Promise<void>;
  onRemoveKey: () => Promise<void>;
  onSaveBaseUrl: (url: string) => Promise<void>;
}) {
  const [keyInput, setKeyInput] = useState('');
  const [urlDraft, setUrlDraft] = useState(baseUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  async function save() {
    if (!keyInput.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSaveKey(keyInput.trim());
      setKeyInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^.*Error: /, '') : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await onRemoveKey();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {meta.needsBaseUrl && (
        <div>
          <label className="mb-1 block text-[11px] text-muted-foreground">Base URL</label>
          <Input
            placeholder="https://my-endpoint.example.com/v1"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onBlur={() => {
              const v = urlDraft.trim().replace(/\/+$/, '');
              setUrlDraft(v);
              if (v !== baseUrl) void onSaveBaseUrl(v);
            }}
          />
        </div>
      )}

      <div>
        <label className="mb-1 block text-[11px] text-muted-foreground">
          API key {stored && <span className="text-success">· saved</span>}
        </label>
        <div className="flex items-center gap-2">
          <Input
            type="password"
            placeholder={stored ? 'Enter a new key to replace' : meta.keyPlaceholder}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
          <Button
            variant="prominent"
            size="sm"
            className="shrink-0"
            onClick={save}
            disabled={busy || !keyInput.trim()}
          >
            {busy ? 'Saving…' : stored ? 'Replace' : 'Save'}
          </Button>
          {stored && (
            <Button
              variant="destructive"
              size="sm"
              className="shrink-0"
              onClick={() => setConfirmRemove(true)}
              disabled={busy}
            >
              Remove
            </Button>
          )}
        </div>
      </div>

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {meta.label} API key?</AlertDialogTitle>
            <AlertDialogDescription>
              The stored API key for {meta.label} is deleted from this device. You
              can add it again later. This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmRemove(false);
                void remove();
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {meta.keyUrl && (
        <a
          href={meta.keyUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-block text-[11px] text-muted-foreground underline-offset-2 hover:underline"
        >
          Get an API key from {meta.label} ↗
        </a>
      )}
      {error && (
        <p className="text-[11px] text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Model picker for the currently active provider (also pickable in chat). */
function ActiveModelSection({
  settings,
  onPatch,
}: {
  settings: AppSettings;
  onPatch: (p: Partial<AppSettings>) => Promise<void>;
}) {
  const models = PROVIDER_MODELS[settings.aiProvider];
  const isCurated = models.some((m) => m.id === settings.aiModel);
  const [customModel, setCustomModel] = useState(!isCurated);
  const [modelDraft, setModelDraft] = useState(settings.aiModel);

  // Keep local model state in sync when the active provider/model changes
  // elsewhere (e.g. the chat picker, or switching provider above).
  useEffect(() => {
    setModelDraft(settings.aiModel);
    setCustomModel(!PROVIDER_MODELS[settings.aiProvider].some((m) => m.id === settings.aiModel));
  }, [settings.aiProvider, settings.aiModel]);

  function commitModel(value: string) {
    const v = value.trim();
    setModelDraft(v);
    if (v && v !== settings.aiModel) void onPatch({ aiModel: v });
  }

  function selectModel(value: string) {
    if (value === CUSTOM_MODEL_VALUE) {
      setCustomModel(true);
      return;
    }
    setCustomModel(false);
    commitModel(value);
  }

  return (
    <SettingsSection title="Model">
      <SettingsRow
        title="Active model"
        description="Sent to the active provider on every agent run. You can also switch it from the chat composer."
        control={
          models.length > 0 ? (
            <Select
              value={customModel ? CUSTOM_MODEL_VALUE : settings.aiModel}
              onValueChange={selectModel}
            >
              <SelectTrigger className="w-full sm:w-52" aria-label="Model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {m.id}
                    </span>
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_MODEL_VALUE}>Custom…</SelectItem>
              </SelectContent>
            </Select>
          ) : undefined
        }
      >
        {(customModel || models.length === 0) && (
          <div className="mt-3">
            <Input
              placeholder="model id (as the provider expects it)"
              value={modelDraft}
              onChange={(e) => setModelDraft(e.target.value)}
              onBlur={() => commitModel(modelDraft)}
              onKeyDown={(e) => e.key === 'Enter' && commitModel(modelDraft)}
              className={cn('font-mono')}
            />
          </div>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}
