/**
 * Composer chip + menu for the chat model (FCode-style). The chip reads
 * "Sonnet 5 Medium" (active model, then effort in muted text). Opening it shows:
 *   • Model — one submenu per provider that is actually SET UP (API key stored,
 *     or the Codex ChatGPT subscription connected); picking a model switches the
 *     active provider+model.
 *   • Options — a Thinking toggle.
 *   • Effort — reasoning effort with a check on the active level.
 * All of it persists in AppSettings, so the next agent run picks it up in main
 * (see ipc.ts agent-start + agent.ts buildProviderOptions).
 *
 * If NO provider is set up there is nothing to pick, so the whole chip is
 * hidden — the composer shows no model picker until the user configures a
 * provider in Settings → AI Provider (or connects Codex).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { COMPOSER_FOOTER_PICKER_TRIGGER_CLASS_NAME } from '@/components/chat/composerStyles';
import { CheckIcon, SparklesIcon } from '@/lib/icons';
import { cn } from '@/lib/utils';
import type { AiKeyStatus, AppSettings, CodexStatus } from '@/shared/ipc-types';
import {
  DEFAULT_MODEL,
  EFFORT_LEVELS,
  PROVIDER_MODELS,
  PROVIDERS,
  effortLabel,
  modelLabel,
  providerLabel,
  type EffortLevel,
  type ProviderId,
} from '@/shared/providers';

/** A provider is pickable only once it can actually run. */
function isProviderReady(
  id: ProviderId,
  keyStatus: AiKeyStatus | null,
  codex: CodexStatus | null,
  settings: AppSettings,
): boolean {
  if (id === 'codex') return !!codex?.connected;
  if (id === 'openai-compatible') {
    return !!keyStatus?.[id]?.stored && settings.aiBaseUrl.trim().length > 0;
  }
  return !!keyStatus?.[id]?.stored;
}

export function ModelOptionsMenu() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [keyStatus, setKeyStatus] = useState<AiKeyStatus | null>(null);
  const [codex, setCodex] = useState<CodexStatus | null>(null);
  const autoFixed = useRef(false);

  const reload = useCallback(async () => {
    const [s, k, c] = await Promise.all([
      window.easyhost.settings.get(),
      window.easyhost.ai.keyStatus(),
      window.easyhost.codex.status(),
    ]);
    setSettings(s);
    setKeyStatus(k);
    setCodex(c);
    return { s, k, c };
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const patch = useCallback(async (p: Partial<AppSettings>) => {
    setSettings(await window.easyhost.settings.set(p));
  }, []);

  // Readiness derived from the loaded status (null-safe until first load).
  const readyProviders = useMemo(
    () =>
      settings
        ? PROVIDERS.filter((p) =>
            isProviderReady(p.id, keyStatus, codex, settings),
          ).map((p) => p.id)
        : [],
    [settings, keyStatus, codex],
  );
  const activeReady = !!settings && readyProviders.includes(settings.aiProvider);
  // Keep the run pointed at a connected provider: if the active one isn't set
  // up but another is, switch to the first ready provider.
  const effectiveProvider =
    settings && (activeReady ? settings.aiProvider : readyProviders[0]);

  // Auto-correct the active provider in an effect (never during render).
  useEffect(() => {
    if (!settings || readyProviders.length === 0) return;
    if (activeReady || autoFixed.current) return;
    autoFixed.current = true;
    const next = readyProviders[0];
    void patch({ aiProvider: next, aiModel: DEFAULT_MODEL[next] });
  }, [settings, keyStatus, codex, activeReady, readyProviders, patch]);

  // Everything below needs readiness known, so wait for the first load.
  if (!settings || !keyStatus || !codex) return null;

  // No provider set up → no picker at all.
  if (readyProviders.length === 0 || !effectiveProvider) return null;

  return (
    <DropdownMenu onOpenChange={(open) => open && void reload()}>
      <DropdownMenuTrigger
        // The picker class is written for SelectTrigger, which brings its own
        // flex layout — the raw Radix trigger button needs it added back.
        className={cn('flex items-center', COMPOSER_FOOTER_PICKER_TRIGGER_CLASS_NAME)}
        aria-label="Model and reasoning options"
        title="Model, thinking and reasoning effort for agent runs"
      >
        <SparklesIcon aria-hidden className="size-3.5 shrink-0 text-foreground" />
        <span className="truncate">
          {modelLabel(effectiveProvider, settings.aiModel)}
        </span>
        <span className="truncate text-muted-foreground">
          {effortLabel(settings.aiEffort)}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuLabel>Model</DropdownMenuLabel>
        {readyProviders.map((id) => {
          const models = PROVIDER_MODELS[id];
          const isActiveProvider = id === effectiveProvider;
          return (
            <DropdownMenuSub key={id}>
              <DropdownMenuSubTrigger className="justify-between gap-2">
                <span className="truncate">{providerLabel(id)}</span>
                <CheckIcon
                  aria-hidden
                  className={cn(
                    'size-4 shrink-0',
                    isActiveProvider ? 'opacity-100' : 'opacity-0',
                  )}
                />
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 w-52 overflow-y-auto">
                {models.length === 0 ? (
                  // openai-compatible has a free-text model id — reflect the
                  // configured one; changing it happens in Settings.
                  <DropdownMenuItem disabled className="justify-between">
                    <span className="truncate">{settings.aiModel || 'Custom model'}</span>
                    {isActiveProvider && <CheckIcon aria-hidden className="size-4" />}
                  </DropdownMenuItem>
                ) : (
                  models.map((m) => {
                    const active = isActiveProvider && settings.aiModel === m.id;
                    return (
                      <DropdownMenuItem
                        key={m.id}
                        onSelect={() =>
                          void patch({ aiProvider: id, aiModel: m.id })
                        }
                        className="justify-between gap-2"
                      >
                        <span className="truncate">{m.label}</span>
                        <CheckIcon
                          aria-hidden
                          className={cn(
                            'size-4 shrink-0',
                            active ? 'opacity-100' : 'opacity-0',
                          )}
                        />
                      </DropdownMenuItem>
                    );
                  })
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Options</DropdownMenuLabel>
        <DropdownMenuItem
          // Toggle without closing the menu, like FCode's options popover.
          onSelect={(e) => {
            e.preventDefault();
            void patch({ aiThinking: !settings.aiThinking });
          }}
          className="justify-between"
        >
          Thinking
          <Switch
            checked={settings.aiThinking}
            aria-label="Extended thinking"
            className="pointer-events-none data-[state=checked]:bg-success"
          />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Effort</DropdownMenuLabel>
        {EFFORT_LEVELS.map((level) => {
          const active = settings.aiEffort === level.id;
          return (
            <DropdownMenuItem
              key={level.id}
              onSelect={() => void patch({ aiEffort: level.id as EffortLevel })}
              className="justify-between"
            >
              {level.label}
              <CheckIcon
                aria-hidden
                className={cn('size-4', active ? 'opacity-100' : 'opacity-0')}
              />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
