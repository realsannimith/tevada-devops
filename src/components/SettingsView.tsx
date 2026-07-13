/**
 * Settings — FCode-style two-pane layout: a dense left nav of sections
 * (grouped, 28px rows, icon + label) and a centered content pane that renders
 * ONE section at a time with a large header, a "Restore defaults" action for
 * settings-backed sections, and hairline-divided settings cards.
 */
import { useEffect, useState, type ComponentType } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ThemeSegmentedControl } from '@/components/ThemeToggle';
import { AiProviderSection } from '@/components/AiProviderSection';
import { GithubSection } from '@/components/GithubSection';
import { GoogleDriveSection } from '@/components/GoogleDriveSection';
import { AlertsSection } from '@/components/AlertsSection';
import { McpSection } from '@/components/McpSection';
import {
  SettingsRow,
  SettingsSection,
} from '@/components/settings/SettingsPrimitives';
import { GithubIcon, TelegramIcon } from '@/lib/brand-icons';
import {
  BotIcon,
  ChartBarIcon,
  CloudUploadIcon,
  NetworkIcon,
  SettingsIcon,
  SparklesIcon,
} from '@/lib/icons';
import { cn } from '@/lib/utils';
import { DEFAULT_SETTINGS, type AppSettings } from '@/shared/ipc-types';

type SectionId =
  | 'general'
  | 'agent'
  | 'monitoring'
  | 'ai'
  | 'mcp'
  | 'github'
  | 'drive'
  | 'alerts';

type SectionItem = {
  id: SectionId;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  /** AppSettings keys owned by this section — drives "Restore defaults". */
  settingsKeys?: (keyof AppSettings)[];
};

const SECTION_GROUPS: { label: string; items: SectionItem[] }[] = [
  {
    label: 'App',
    items: [
      {
        id: 'general',
        label: 'General',
        description: 'Appearance and how the terminal feels.',
        icon: SettingsIcon,
        settingsKeys: ['localEcho'],
      },
      {
        id: 'agent',
        label: 'Agent',
        description: 'How much the agent may do on its own, and for how long.',
        icon: BotIcon,
        settingsKeys: ['approvalMode', 'agentMaxSteps'],
      },
      {
        id: 'monitoring',
        label: 'Monitoring',
        description: 'How often server stats are polled.',
        icon: ChartBarIcon,
        settingsKeys: ['pollIntervalMs'],
      },
    ],
  },
  {
    label: 'Connections',
    items: [
      {
        id: 'ai',
        label: 'AI Provider',
        description:
          'Choose which AI powers the agent — an API key, or the Codex ChatGPT subscription. Credentials are stored encrypted on this machine.',
        icon: SparklesIcon,
      },
      {
        id: 'mcp',
        label: 'Agent Access (MCP)',
        description:
          'Let coding agents on this machine — Claude Code, Codex, or any MCP client — work on your servers through this app. The endpoint runs on localhost only and your SSH credentials never leave the app.',
        icon: NetworkIcon,
      },
      {
        id: 'github',
        label: 'GitHub',
        description:
          'Connect your account and choose which repositories this app — and the agent — can reach. Your servers can then clone them, including private ones, during deploys.',
        icon: GithubIcon,
      },
      {
        id: 'drive',
        label: 'Google Drive',
        description:
          'Optionally sync EasyHost app data to your Google Drive app data folder so settings, chat history, server metadata, and encrypted credentials have a backup.',
        icon: CloudUploadIcon,
      },
      {
        id: 'alerts',
        label: 'Alerts',
        description:
          'Get a Telegram message when a server goes down or runs low on resources. Alerts only fire on sustained problems, never on brief spikes.',
        icon: TelegramIcon,
      },
    ],
  },
];

const ALL_SECTIONS = SECTION_GROUPS.flatMap((g) => g.items);

export function SettingsView() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [section, setSection] = useState<SectionId>('general');

  useEffect(() => {
    window.easyhost.settings.get().then(setSettings);
  }, []);

  async function patch(p: Partial<AppSettings>) {
    const next = await window.easyhost.settings.set(p);
    setSettings(next);
  }

  const active = ALL_SECTIONS.find((s) => s.id === section) ?? ALL_SECTIONS[0];
  const isDirty =
    settings != null &&
    (active.settingsKeys ?? []).some((k) => settings[k] !== DEFAULT_SETTINGS[k]);

  function restoreDefaults() {
    if (!active.settingsKeys) return;
    const patchObj: Partial<AppSettings> = {};
    for (const k of active.settingsKeys) {
      (patchObj as Record<string, unknown>)[k] = DEFAULT_SETTINGS[k];
    }
    void patch(patchObj);
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Section nav */}
      <aside className="w-48 shrink-0 overflow-y-auto border-r border-border px-1.5 py-2">
        {SECTION_GROUPS.map((group) => (
          <section key={group.label} className="flex flex-col not-first:mt-3">
            <h2 className="px-2 py-1 text-xs font-normal text-muted-foreground/60">
              {group.label}
            </h2>
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const isActive = item.id === section;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-current={isActive ? 'page' : undefined}
                      onClick={() => setSection(item.id)}
                      className={cn(
                        'flex h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs font-normal select-none transition-colors',
                        isActive
                          ? 'bg-secondary text-ink'
                          : 'text-muted-foreground hover:bg-secondary/60 hover:text-ink',
                      )}
                    >
                      <item.icon className="size-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </aside>

      {/* Content pane */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {settings && (
          <div className="mx-auto w-full max-w-2xl px-6 py-8">
            <div className="mb-8 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h1 className="text-xl font-medium tracking-tight text-ink">
                  {active.label}
                </h1>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                  {active.description}
                </p>
              </div>
              {active.settingsKeys && (
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  disabled={!isDirty}
                  onClick={restoreDefaults}
                >
                  Restore defaults
                </Button>
              )}
            </div>

            {section === 'general' && (
              <div className="space-y-6">
                <SettingsSection title="Appearance">
                  <SettingsRow
                    title="Theme"
                    description="Match your OS, or lock to light or dark."
                    control={
                      <div className="w-full sm:w-72">
                        <ThemeSegmentedControl />
                      </div>
                    }
                  />
                </SettingsSection>
                <SettingsSection title="Terminal">
                  <SettingsRow
                    title="Predictive typing"
                    description="Show typed characters instantly (dimmed) before the server confirms them, so the terminal feels native over latency."
                    control={
                      <Switch
                        checked={settings.localEcho}
                        onCheckedChange={(v) => patch({ localEcho: v })}
                        aria-label="Predictive typing"
                      />
                    }
                  />
                </SettingsSection>
              </div>
            )}

            {section === 'agent' && (
              <div className="space-y-6">
                <SettingsSection title="Autonomy">
                  <SettingsRow
                    title="Require approval"
                    description="Ask before every state-changing command. Off = full-auto (catastrophic commands are always confirmed)."
                    control={
                      <Switch
                        checked={settings.approvalMode}
                        onCheckedChange={(v) => patch({ approvalMode: v })}
                        aria-label="Require approval"
                      />
                    }
                  />
                  <SettingsRow
                    title="Max steps per run"
                    description="How many tool-loop steps one agent run may take before pausing."
                    control={
                      <Input
                        id="steps"
                        type="number"
                        className="w-full text-right sm:w-24"
                        value={settings.agentMaxSteps}
                        onChange={(e) =>
                          patch({ agentMaxSteps: Number(e.target.value) || 1 })
                        }
                        aria-label="Max agent steps per run"
                      />
                    }
                  />
                </SettingsSection>
              </div>
            )}

            {section === 'monitoring' && (
              <div className="space-y-6">
                <SettingsSection title="Polling">
                  <SettingsRow
                    title="Poll interval"
                    description="Milliseconds between server stats refreshes on the dashboard."
                    control={
                      <Input
                        id="poll"
                        type="number"
                        className="w-full text-right sm:w-28"
                        value={settings.pollIntervalMs}
                        onChange={(e) =>
                          patch({ pollIntervalMs: Number(e.target.value) || 1000 })
                        }
                        aria-label="Monitoring poll interval in milliseconds"
                      />
                    }
                  />
                </SettingsSection>
              </div>
            )}

            {section === 'ai' && <AiProviderSection settings={settings} onPatch={patch} />}

            {section === 'mcp' && <McpSection settings={settings} onPatch={patch} />}

            {section === 'github' && <GithubSection />}

            {section === 'drive' && <GoogleDriveSection />}

            {section === 'alerts' && <AlertsSection />}
          </div>
        )}
      </div>
    </div>
  );
}
