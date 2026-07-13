/**
 * Settings → Agent Access (MCP). Runs the local MCP endpoint and gets the
 * user's coding agent connected to it with as little friction as possible:
 * a start/stop switch, one-click config installs for Claude Code and Codex,
 * and copy-paste snippets for everything else.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  SettingsRow,
  SettingsSection,
} from '@/components/settings/SettingsPrimitives';
import { CheckIcon, CopyIcon } from '@/lib/icons';
import type {
  AppSettings,
  McpInstallClient,
  McpStatus,
} from '@/shared/ipc-types';

export function McpSection({
  settings,
  onPatch,
}: {
  settings: AppSettings;
  onPatch: (p: Partial<AppSettings>) => Promise<void> | void;
}) {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [portDraft, setPortDraft] = useState(String(settings.mcpPort));
  const [installing, setInstalling] = useState<McpInstallClient | null>(null);
  const [installed, setInstalled] = useState<
    Partial<Record<McpInstallClient, string>>
  >({});

  useEffect(() => {
    void window.easyhost.mcp.status().then(setStatus);
    return window.easyhost.mcp.onStatus(setStatus);
  }, []);

  const running = status?.running ?? false;
  const port = Number(portDraft) || settings.mcpPort;
  const url = status?.url ?? `http://127.0.0.1:${port}/mcp`;

  async function toggle(on: boolean) {
    setBusy(true);
    try {
      const next = on
        ? await window.easyhost.mcp.start(port)
        : await window.easyhost.mcp.stop();
      setStatus(next);
      if (on && !next.running) {
        toast.error(next.error ?? 'The MCP server could not start.');
      } else if (on) {
        void onPatch({ mcpPort: port });
      }
    } finally {
      setBusy(false);
    }
  }

  async function install(client: McpInstallClient) {
    setInstalling(client);
    try {
      const result = await window.easyhost.mcp.install(client);
      // Explicit `=== false`: this repo compiles without strictNullChecks,
      // where a bare truthiness check does not narrow the union.
      if (result.ok === false) {
        toast.error(result.error);
      } else {
        setInstalled((prev) => ({ ...prev, [client]: result.detail }));
        toast.success(result.detail);
      }
    } finally {
      setInstalling(null);
    }
  }

  return (
    <div className="space-y-6">
      <SettingsSection title="MCP server">
        <SettingsRow
          title="Run MCP server"
          description="Expose your servers to coding agents on this machine over MCP. The endpoint only listens on localhost; credentials never leave this app."
          status={
            running ? (
              <span className="text-success">Running at {url}</span>
            ) : status?.error ? (
              <span className="text-destructive">{status.error}</span>
            ) : undefined
          }
          control={
            <Switch
              checked={running}
              disabled={busy}
              onCheckedChange={(v) => void toggle(v)}
              aria-label="Run MCP server"
            />
          }
        />
        <SettingsRow
          title="Port"
          description="Localhost port for the endpoint. Stop the server to change it."
          control={
            <Input
              type="number"
              className="w-full text-right sm:w-28"
              value={portDraft}
              disabled={running}
              onChange={(e) => setPortDraft(e.target.value)}
              onBlur={() => {
                const p = Number(portDraft);
                if (Number.isInteger(p) && p > 0 && p < 65536) {
                  void onPatch({ mcpPort: p });
                } else {
                  setPortDraft(String(settings.mcpPort));
                }
              }}
              aria-label="MCP server port"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Connect your agent (one click)">
        <SettingsRow
          title="Claude Code"
          description="Writes the endpoint into ~/.claude.json (user scope) — every Claude Code session on this machine gets the tools."
          status={
            installed['claude-code'] ? (
              <span className="flex items-center gap-1 text-success">
                <CheckIcon className="size-3" /> {installed['claude-code']}
              </span>
            ) : undefined
          }
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={installing !== null}
              onClick={() => void install('claude-code')}
            >
              {installing === 'claude-code' ? 'Adding…' : 'Add to Claude Code'}
            </Button>
          }
        />
        <SettingsRow
          title="Codex"
          description="Writes the endpoint into ~/.codex/config.toml. Needs a Codex CLI version with HTTP MCP support."
          status={
            installed.codex ? (
              <span className="flex items-center gap-1 text-success">
                <CheckIcon className="size-3" /> {installed.codex}
              </span>
            ) : undefined
          }
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={installing !== null}
              onClick={() => void install('codex')}
            >
              {installing === 'codex' ? 'Adding…' : 'Add to Codex'}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="Manual setup (any MCP client)">
        <SettingsRow
          title="Claude Code CLI"
          description="Run this in a terminal instead of the one-click button."
        >
          <Snippet value={`claude mcp add --transport http tevada-devops ${url}`} />
        </SettingsRow>
        <SettingsRow
          title="JSON config"
          description="For clients configured with an mcpServers JSON block (Claude Desktop via HTTP, Cursor, Windsurf, …)."
        >
          <Snippet
            value={`{\n  "mcpServers": {\n    "tevada-devops": {\n      "type": "http",\n      "url": "${url}"\n    }\n  }\n}`}
          />
        </SettingsRow>
        <SettingsRow
          title="Stdio bridge"
          description="For clients that only speak stdio, bridge to the endpoint with mcp-remote."
        >
          <Snippet value={`npx -y mcp-remote ${url}`} />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="What connected agents can do">
        <SettingsRow
          title="Tools exposed"
          description={
            <>
              <span className="block">
                list_servers · list_projects · run_command · get_server_stats
              </span>
              <span className="mt-1 block">
                Agents see your server list and can run shell commands on them
                over this app&apos;s SSH connections — the same access the
                in-app agent has. Only start the MCP server when the agents on
                this machine are ones you trust with your servers.
              </span>
            </>
          }
        />
      </SettingsSection>
    </div>
  );
}

/** A copyable one-liner / block: monospace, with a copy button that flashes ✓. */
function Snippet({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2">
      <pre className="min-w-0 flex-1 overflow-x-auto rounded-md bg-secondary px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre">
        {value}
      </pre>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Copy to clipboard"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? (
          <CheckIcon className="size-4 text-success" />
        ) : (
          <CopyIcon className="size-4" />
        )}
      </Button>
    </div>
  );
}
