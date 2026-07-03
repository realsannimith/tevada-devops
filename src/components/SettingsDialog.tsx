import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { AppSettings } from '@/shared/ipc-types';

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    if (open) window.easyhost.settings.get().then(setSettings);
  }, [open]);

  async function patch(p: Partial<AppSettings>) {
    const next = await window.easyhost.settings.set(p);
    setSettings(next);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Control how the agent runs and how often servers are polled.
          </DialogDescription>
        </DialogHeader>

        {settings && (
          <div className="grid gap-5 py-2">
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
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
