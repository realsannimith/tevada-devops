import { useEffect, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { ThemeSegmentedControl } from '@/components/ThemeToggle';
import { GithubSection } from '@/components/GithubSection';
import { AlertsSection } from '@/components/AlertsSection';
import type { AppSettings } from '@/shared/ipc-types';

export function SettingsView() {
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    window.easyhost.settings.get().then(setSettings);
  }, []);

  async function patch(p: Partial<AppSettings>) {
    const next = await window.easyhost.settings.set(p);
    setSettings(next);
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-5 py-3">
        <h1 className="text-sm font-semibold tracking-[-0.015em] text-ink">
          Settings
        </h1>
        <p className="text-[11px] text-muted-foreground">
          Control how the agent runs and how often servers are polled.
        </p>
      </header>

      <div className="flex-1 overflow-y-auto">
        {settings && (
          <div className="mx-auto grid max-w-xl gap-5 px-5 py-6">
            <div className="grid gap-2">
              <div className="pr-4">
                <Label>Appearance</Label>
                <p className="text-xs text-muted-foreground">
                  Match your OS, or lock to light or dark.
                </p>
              </div>
              <ThemeSegmentedControl />
            </div>

            <div className="flex items-center justify-between">
              <div className="pr-4">
                <Label>Require approval</Label>
                <p className="text-xs text-muted-foreground">
                  Ask before every state-changing command. Off = full-auto
                  (catastrophic commands are always confirmed).
                </p>
              </div>
              <Switch
                checked={settings.approvalMode}
                onCheckedChange={(v) => patch({ approvalMode: v })}
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="pr-4">
                <Label>Predictive typing</Label>
                <p className="text-xs text-muted-foreground">
                  Show typed characters instantly (dimmed) before the server
                  confirms them, so the terminal feels native over latency.
                </p>
              </div>
              <Switch
                checked={settings.localEcho}
                onCheckedChange={(v) => patch({ localEcho: v })}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="steps">Max agent steps per run</Label>
              <Input
                id="steps"
                type="number"
                value={settings.agentMaxSteps}
                onChange={(e) =>
                  patch({ agentMaxSteps: Number(e.target.value) || 1 })
                }
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="poll">Monitoring poll interval (ms)</Label>
              <Input
                id="poll"
                type="number"
                value={settings.pollIntervalMs}
                onChange={(e) =>
                  patch({ pollIntervalMs: Number(e.target.value) || 1000 })
                }
              />
            </div>

            <Separator />

            <GithubSection />

            <Separator />

            <AlertsSection />
          </div>
        )}
      </div>
    </div>
  );
}
