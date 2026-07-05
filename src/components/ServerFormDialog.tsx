import { useState } from 'react';
import { Copy, Check, KeyRound, Sparkles } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AuthType, ServerSecret } from '@/shared/ipc-types';
import { useServers } from '@/hooks/useServers';

// Provider presets: default login user + where to paste the SSH public key.
const PROVIDERS: Record<
  string,
  { label: string; user: string; ipHint: string; keyHint: string }
> = {
  digitalocean: {
    label: 'DigitalOcean',
    user: 'root',
    ipHint: 'Find the IP on your Droplet page (the "ipv4" address).',
    keyHint:
      'DigitalOcean → Settings → Security → Add SSH Key. Add it there, then select it when creating (or rebuilding) your Droplet.',
  },
  aws: {
    label: 'AWS EC2',
    user: 'ubuntu',
    ipHint: 'EC2 → Instances → your instance → "Public IPv4 address".',
    keyHint:
      'Add this key to the instance (EC2 Instance Connect, or paste into ~/.ssh/authorized_keys). Username is usually "ubuntu" or "ec2-user".',
  },
  linode: {
    label: 'Linode / Akamai',
    user: 'root',
    ipHint: 'Linode dashboard → your Linode → "SSH Access" IP.',
    keyHint: 'Linode → Profile → SSH Keys → Add a key, then deploy/rebuild.',
  },
  vultr: {
    label: 'Vultr',
    user: 'root',
    ipHint: 'Vultr → Products → your server → main IP.',
    keyHint: 'Vultr → Account → SSH Keys → Add SSH Key, then attach on deploy.',
  },
  hetzner: {
    label: 'Hetzner Cloud',
    user: 'root',
    ipHint: 'Hetzner Cloud console → your server → "IPv4".',
    keyHint:
      'Hetzner Cloud → Security → SSH Keys → Add, then select it when creating the server.',
  },
  other: {
    label: 'Other / self-hosted',
    user: 'root',
    ipHint: "Use the server's public IP or hostname.",
    keyHint:
      "Add this public key to the server's ~/.ssh/authorized_keys for the login user.",
  },
};

type KeyMode = 'generate' | 'paste';

export function ServerFormDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { refresh } = useServers();
  const [provider, setProvider] = useState('digitalocean');
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('root');
  const [authType, setAuthType] = useState<AuthType>('key');
  const [password, setPassword] = useState('');

  const [keyMode, setKeyMode] = useState<KeyMode>('generate');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [genPublicKey, setGenPublicKey] = useState('');
  const [genKeyRef, setGenKeyRef] = useState('');
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const prov = PROVIDERS[provider];

  function reset() {
    setProvider('digitalocean');
    setName('');
    setHost('');
    setPort('22');
    setUsername('root');
    setAuthType('key');
    setPassword('');
    setKeyMode('generate');
    setPrivateKey('');
    setPassphrase('');
    setGenPublicKey('');
    setGenKeyRef('');
    setCopied(false);
    setMsg(null);
  }

  function pickProvider(p: string) {
    setProvider(p);
    setUsername(PROVIDERS[p].user);
  }

  async function generate() {
    setGenerating(true);
    const { keyRef, publicKey } = await window.easyhost.keys.generate(
      name.trim() || host.trim() || 'easy-host',
    );
    setGenKeyRef(keyRef);
    setGenPublicKey(publicKey);
    setGenerating(false);
  }

  async function copyKey() {
    await navigator.clipboard.writeText(genPublicKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const usingGenerated = authType === 'key' && keyMode === 'generate';

  function buildPayload() {
    const profile = {
      name: name.trim() || host.trim(),
      host: host.trim(),
      port: Number(port) || 22,
      username: username.trim(),
      authType,
    };
    const secret: ServerSecret =
      authType === 'password'
        ? { password }
        : usingGenerated
          ? { keyRef: genKeyRef, passphrase: undefined }
          : { privateKey, passphrase: passphrase || undefined };
    return { profile, secret };
  }

  const valid =
    host.trim() &&
    username.trim() &&
    (authType === 'password'
      ? !!password
      : usingGenerated
        ? !!genKeyRef
        : !!privateKey);

  async function test() {
    if (!valid || usingGenerated) return;
    setTesting(true);
    setMsg(null);
    const { profile, secret } = buildPayload();
    const res = await window.easyhost.servers.test(profile, secret);
    setTesting(false);
    setMsg(
      res.ok
        ? { ok: true, text: 'Connection succeeded.' }
        : { ok: false, text: res.error ?? 'Connection failed.' },
    );
  }

  async function save() {
    if (!valid) return;
    setSaving(true);
    const { profile, secret } = buildPayload();
    await window.easyhost.servers.add(profile, secret);
    await refresh();
    setSaving(false);
    reset();
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add server</DialogTitle>
          <DialogDescription>
            No terminal needed. Credentials are encrypted with your OS keychain
            and never leave this machine.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label>Provider</Label>
            <Select value={provider} onValueChange={pickProvider}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(PROVIDERS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Production web"
            />
          </div>

          <div className="grid grid-cols-[1fr_100px] gap-2">
            <div className="grid gap-2">
              <Label htmlFor="host">Host / IP</Label>
              <Input
                id="host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="203.0.113.10"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="port">Port</Label>
              <Input
                id="port"
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">{prov.ipHint}</p>

          <div className="grid gap-2">
            <Label htmlFor="user">Username</Label>
            <Input
              id="user"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>

          <Tabs value={authType} onValueChange={(v) => setAuthType(v as AuthType)}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="key">SSH key</TabsTrigger>
              <TabsTrigger value="password">Password</TabsTrigger>
            </TabsList>

            <TabsContent value="key" className="space-y-3 pt-3">
              <Tabs value={keyMode} onValueChange={(v) => setKeyMode(v as KeyMode)}>
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="generate">
                    <Sparkles className="mr-1 h-3.5 w-3.5" /> Generate for me
                  </TabsTrigger>
                  <TabsTrigger value="paste">
                    <KeyRound className="mr-1 h-3.5 w-3.5" /> Paste my key
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="generate" className="space-y-3 pt-3">
                  {!genPublicKey ? (
                    <Button
                      type="button"
                      variant="secondary"
                      className="w-full"
                      onClick={generate}
                      disabled={generating}
                    >
                      <Sparkles className="h-4 w-4" />
                      {generating ? 'Generating…' : 'Generate an SSH key'}
                    </Button>
                  ) : (
                    <div className="space-y-2 rounded-md border border-border bg-secondary/60 p-3">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs">
                          Your public key — copy & paste it into {prov.label}
                        </Label>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={copyKey}
                        >
                          {copied ? (
                            <Check className="h-3.5 w-3.5 text-success" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                          {copied ? 'Copied' : 'Copy'}
                        </Button>
                      </div>
                      <pre className="max-h-24 overflow-auto rounded-md bg-card p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-ink">
                        {genPublicKey}
                      </pre>
                      <p className="text-xs text-muted-foreground">
                        {prov.keyHint} The private key stays encrypted on this
                        Mac — you never handle it.
                      </p>
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="paste" className="space-y-2 pt-3">
                  <Label htmlFor="key">Private key (PEM / OpenSSH)</Label>
                  <Textarea
                    id="key"
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    className="h-24 font-mono text-xs"
                  />
                  <Label htmlFor="pass">Passphrase (optional)</Label>
                  <Input
                    id="pass"
                    type="password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                  />
                </TabsContent>
              </Tabs>
            </TabsContent>

            <TabsContent value="password" className="pt-3">
              <div className="grid gap-2">
                <Label htmlFor="pw">Password</Label>
                <Input
                  id="pw"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Most providers let you set or email a root password when you
                  create the server — paste it here.
                </p>
              </div>
            </TabsContent>
          </Tabs>

          {msg && (
            <p
              className={
                msg.ok ? 'text-xs text-success' : 'text-xs text-destructive'
              }
            >
              {msg.text}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="outline"
            onClick={test}
            disabled={!valid || testing || usingGenerated}
            title={
              usingGenerated
                ? 'Save first, then Connect — a new key must be added to the server before it works.'
                : undefined
            }
          >
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
          <Button onClick={save} disabled={!valid || saving}>
            {saving ? 'Saving…' : 'Save server'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
