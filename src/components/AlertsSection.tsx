/**
 * "Telegram alerts" section of the Settings dialog. Lets the user connect a
 * Telegram bot, pick the chat that receives alerts, and choose which servers to
 * watch (with per-server thresholds). The bot token never reaches this process —
 * main validates/stores it and only sends back non-secret status (see alerts.ts).
 *
 * The anti-noise controls (failure/success thresholds, reminder interval) are
 * surfaced under "Advanced" so the sane defaults just work.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useServers } from '@/hooks/useServers';
import { TelegramIcon } from '@/lib/brand-icons';
import { CheckIcon, Loader2Icon } from '@/lib/icons';
import {
  DEFAULT_ALERT_THRESHOLDS,
  type AlertsStatus,
  type ServerAlertConfig,
} from '@/shared/ipc-types';

export function AlertsSection() {
  const { servers } = useServers();
  const [status, setStatus] = useState<AlertsStatus | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [chats, setChats] = useState<{ id: string; title: string }[] | null>(null);
  const [manualChat, setManualChat] = useState('');
  const [testState, setTestState] = useState<'idle' | 'sending' | 'ok' | 'err'>('idle');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const refresh = useCallback(async () => {
    setStatus(await window.easyhost.alerts.status());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const config = status?.config;

  async function connect() {
    if (!token.trim()) return;
    setBusy(true);
    setError(null);
    const r = await window.easyhost.alerts.connectToken(token);
    if (r.ok === false) {
      setError(r.error);
    } else {
      setToken('');
      await refresh();
    }
    setBusy(false);
  }

  async function disconnect() {
    setBusy(true);
    setChats(null);
    setStatus(await window.easyhost.alerts.disconnect());
    setBusy(false);
  }

  async function detectChat() {
    setDetecting(true);
    setError(null);
    const r = await window.easyhost.alerts.detectChat();
    if (r.ok === false) setError(r.error);
    else setChats(r.chats);
    setDetecting(false);
  }

  async function pickChat(chatId: string) {
    setStatus(await window.easyhost.alerts.setChat(chatId));
    setChats(null);
    setManualChat('');
  }

  async function sendTest() {
    setTestState('sending');
    const r = await window.easyhost.alerts.test();
    setTestState(r.ok ? 'ok' : 'err');
    if (r.ok === false) setError(r.error);
    setTimeout(() => setTestState('idle'), 2500);
  }

  async function patchConfig(patch: {
    failureThreshold?: number;
    successThreshold?: number;
    reminderMinutes?: number;
  }) {
    setStatus(await window.easyhost.alerts.setConfig(patch));
  }

  async function saveServer(sc: ServerAlertConfig) {
    setStatus(await window.easyhost.alerts.setServer(sc));
  }

  function serverConfigFor(serverId: string): ServerAlertConfig {
    return (
      config?.servers.find((s) => s.serverId === serverId) ?? {
        serverId,
        enabled: false,
        reachability: true,
        thresholds: { ...DEFAULT_ALERT_THRESHOLDS },
      }
    );
  }

  return (
    <div className="grid gap-2">
      <div className="pr-4">
        <Label>Telegram alerts</Label>
        <p className="text-xs text-muted-foreground">
          Get a message when a server goes down or runs low on resources. Alerts
          only fire on sustained problems, never on brief spikes.
        </p>
      </div>

      {!status ? (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" /> Checking…
        </div>
      ) : !status.hasToken ? (
        <div className="grid gap-2">
          <Input
            type="password"
            placeholder="Bot token from @BotFather"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && connect()}
          />
          <Button
            variant="prominent"
            onClick={connect}
            disabled={busy || !token.trim()}
            className="justify-center"
          >
            <TelegramIcon className="size-4" />
            {busy ? 'Connecting…' : 'Connect Telegram bot'}
          </Button>
          <p className="text-[11px] text-muted-foreground">
            In Telegram, message <span className="font-mono">@BotFather</span>,
            send <span className="font-mono">/newbot</span>, and paste the token
            it gives you here.
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {/* Connected bot */}
          <div className="surface-panel flex items-center gap-3 p-3">
            <TelegramIcon className="size-7 text-[#26A5E4]" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold tracking-[-0.015em] text-ink">
                {config?.botName || 'Telegram bot'}
              </p>
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                {config?.botUsername ? `@${config.botUsername}` : 'connected'}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={disconnect} disabled={busy}>
              Disconnect
            </Button>
          </div>

          {/* Chat picker */}
          {config?.chatId ? (
            <div className="surface-panel flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] text-muted-foreground">Alerts go to chat</p>
                <p className="truncate font-mono text-xs text-ink">{config.chatId}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={sendTest}
                disabled={testState === 'sending'}
              >
                {testState === 'sending' ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : testState === 'ok' ? (
                  <CheckIcon className="size-3.5 text-success" />
                ) : null}
                {testState === 'ok' ? 'Sent' : 'Send test'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => pickChat('')}>
                Change
              </Button>
            </div>
          ) : (
            <div className="surface-panel grid gap-2 p-3">
              <p className="text-xs text-muted-foreground">
                Open Telegram, send your bot any message, then detect the chat.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="prominent"
                  size="sm"
                  onClick={detectChat}
                  disabled={detecting}
                  className="justify-center"
                >
                  {detecting ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : null}
                  Detect chat
                </Button>
                <Input
                  placeholder="…or paste chat ID"
                  value={manualChat}
                  onChange={(e) => setManualChat(e.target.value)}
                  onKeyDown={(e) =>
                    e.key === 'Enter' && manualChat.trim() && pickChat(manualChat.trim())
                  }
                  className="h-8"
                />
              </div>
              {chats && chats.length > 0 && (
                <div className="divide-y divide-border rounded-md border border-border">
                  {chats.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => pickChat(c.id)}
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-xs text-ink hover:bg-accent"
                    >
                      <span className="truncate">{c.title}</span>
                      <span className="ml-2 shrink-0 font-mono text-[11px] text-muted-foreground">
                        {c.id}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Per-server watch list */}
          <div>
            <p className="text-[11px] text-muted-foreground">Watched servers</p>
            <p className="pb-1.5 text-xs text-muted-foreground">
              Turn on a server to watch it. Blank threshold = that check is off.
            </p>
            {servers.length === 0 ? (
              <div className="surface-panel p-3 text-xs text-muted-foreground">
                No servers yet. Add one from the sidebar first.
              </div>
            ) : (
              <div className="surface-panel divide-y divide-border">
                {servers.map((s) => (
                  <ServerAlertRow
                    key={s.id}
                    name={s.name}
                    host={`${s.username}@${s.host}`}
                    sc={serverConfigFor(s.id)}
                    onChange={saveServer}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Advanced anti-noise controls */}
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
            >
              {showAdvanced ? 'Hide advanced' : 'Advanced (sensitivity)'}
            </button>
            {showAdvanced && config && (
              <div className="surface-panel mt-1.5 grid gap-3 p-3">
                <NumberField
                  label="Breaches before alerting"
                  hint="Consecutive bad checks before the first alert."
                  value={config.failureThreshold}
                  min={1}
                  onCommit={(v) => patchConfig({ failureThreshold: v })}
                />
                <NumberField
                  label="Good checks before resolved"
                  hint="Consecutive healthy checks before sending the recovery message."
                  value={config.successThreshold}
                  min={1}
                  onCommit={(v) => patchConfig({ successThreshold: v })}
                />
                <NumberField
                  label="Reminder interval (minutes)"
                  hint="Re-send while still broken. 0 = remind once, never repeat."
                  value={config.reminderMinutes}
                  min={0}
                  onCommit={(v) => patchConfig({ reminderMinutes: v })}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {error && (
        <p className="text-[11px] text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ServerAlertRow({
  name,
  host,
  sc,
  onChange,
}: {
  name: string;
  host: string;
  sc: ServerAlertConfig;
  onChange: (sc: ServerAlertConfig) => void;
}) {
  const setThreshold = (key: keyof ServerAlertConfig['thresholds'], v: number | null) =>
    onChange({ ...sc, thresholds: { ...sc.thresholds, [key]: v } });

  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-ink">{name}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{host}</p>
        </div>
        <Switch
          checked={sc.enabled}
          onCheckedChange={(v) => onChange({ ...sc, enabled: v })}
        />
      </div>

      {sc.enabled && (
        <div className="mt-2.5 grid gap-2 border-t border-border pt-2.5">
          <label className="flex items-center justify-between text-[11px] text-muted-foreground">
            Alert when unreachable (down)
            <Switch
              checked={sc.reachability}
              onCheckedChange={(v) => onChange({ ...sc, reachability: v })}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <ThresholdField
              label="Memory ≥ %"
              value={sc.thresholds.memory}
              onCommit={(v) => setThreshold('memory', v)}
            />
            <ThresholdField
              label="Disk ≥ %"
              value={sc.thresholds.disk}
              onCommit={(v) => setThreshold('disk', v)}
            />
            <ThresholdField
              label="CPU ≥ %"
              value={sc.thresholds.cpu}
              onCommit={(v) => setThreshold('cpu', v)}
            />
            <ThresholdField
              label="Load ≥"
              value={sc.thresholds.load}
              onCommit={(v) => setThreshold('load', v)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** A percent/number threshold that can be cleared to null (rule off). */
function ThresholdField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number | null;
  onCommit: (v: number | null) => void;
}) {
  const [text, setText] = useState(value == null ? '' : String(value));
  useEffect(() => setText(value == null ? '' : String(value)), [value]);
  return (
    <label className="grid gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <Input
        type="number"
        inputMode="numeric"
        placeholder="off"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const trimmed = text.trim();
          onCommit(trimmed === '' ? null : Number(trimmed));
        }}
        className="h-8"
      />
    </label>
  );
}

function NumberField({
  label,
  hint,
  value,
  min,
  onCommit,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <div className="grid gap-1">
      <Label className="text-[11px]">{label}</Label>
      <Input
        type="number"
        value={text}
        min={min}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const n = Math.max(min, Math.floor(Number(text) || min));
          onCommit(n);
        }}
        className="h-8"
      />
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}
