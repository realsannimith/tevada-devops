import { useEffect, useRef, useState } from 'react';
import { Copy, Check, KeyRound, Sparkles, Upload } from 'lucide-react';
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
} from '@/components/ui/select';
import { ProviderLogo } from '@/components/providerLogos';
import type { AuthType, ServerSecret, ServerWithStatus } from '@/shared/ipc-types';
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
      'DigitalOcean uses root initially on most images. Add the public key under Settings → Security, then select it while creating the Droplet; adding it to your account later does not install it on an existing Droplet.',
  },
  aws: {
    label: 'AWS EC2',
    user: 'ec2-user',
    ipHint: 'EC2 → Instances → your instance → "Public IPv4 address".',
    keyHint:
      'Use the private key pair assigned when this instance was launched. Login user depends on the AMI: "ec2-user" for Amazon Linux, "ubuntu" for Ubuntu, or "admin" for Debian.',
  },
  linode: {
    label: 'Linode / Akamai',
    user: 'root',
    ipHint: 'Linode dashboard → your Linode → "SSH Access" IP.',
    keyHint:
      'Linode installs selected account SSH keys for root during creation. For an existing Linode, add the public key to /root/.ssh/authorized_keys.',
  },
  vultr: {
    label: 'Vultr',
    user: 'root',
    ipHint: 'Vultr → Products → your server → main IP.',
    keyHint:
      'Vultr commonly uses root; confirm the displayed username on the instance Overview page. Select the SSH key under Server Settings when deploying, or install it manually on an existing instance.',
  },
  hetzner: {
    label: 'Hetzner Cloud',
    user: 'root',
    ipHint: 'Hetzner Cloud console → your server → "IPv4".',
    keyHint:
      'Hetzner Cloud uses root initially. Add the public key under Security → SSH Keys and select it when creating the server; existing servers require manual installation.',
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
  server,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  server?: ServerWithStatus | null;
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
  const [keyFileName, setKeyFileName] = useState('');
  const keyFileInput = useRef<HTMLInputElement>(null);
  const [passphrase, setPassphrase] = useState('');
  const [genPublicKey, setGenPublicKey] = useState('');
  const [genKeyRef, setGenKeyRef] = useState('');
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const prov = PROVIDERS[provider];
  const isEditing = Boolean(server);

  useEffect(() => {
    if (!open || !server) return;
    setProvider('other');
    setName(server.name);
    setHost(server.host);
    setPort(String(server.port));
    setUsername(server.username);
    setAuthType(server.authType);
    setPassword('');
    setKeyMode('paste');
    setPrivateKey('');
    setKeyFileName('');
    setPassphrase('');
    setGenPublicKey('');
    setGenKeyRef('');
    setCopied(false);
    setMsg({
      ok: false,
      text:
        server.authType === 'password'
          ? 'Enter the password again to replace the unreadable saved credential.'
          : 'Paste the private key again to replace the unreadable saved credential.',
    });
  }, [open, server]);

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
    setKeyFileName('');
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
      name.trim() || host.trim() || 'tevada-devops',
    );
    setGenKeyRef(keyRef);
    setGenPublicKey(publicKey);
    setGenerating(false);
    // A freshly generated key replaces any unreadable saved credential, so drop
    // the stale "paste the key again" warning.
    setMsg(null);
  }

  async function onKeyFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be re-picked later
    if (!file) return;
    if (file.size > 512 * 1024) {
      setMsg({ ok: false, text: 'That file is too large to be an SSH key.' });
      return;
    }
    const text = await file.text();
    if (!/-----BEGIN [\w ]*PRIVATE KEY-----/.test(text)) {
      setMsg({
        ok: false,
        text: `"${file.name}" doesn't look like a private key file. Pick the .pem AWS gave you.`,
      });
      return;
    }
    setPrivateKey(text);
    setKeyFileName(file.name);
    setMsg({ ok: true, text: `Loaded key from "${file.name}".` });
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
    if (!valid) return;
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
    if (server) {
      await window.easyhost.servers.update(server.id, profile, secret);
    } else {
      await window.easyhost.servers.add(profile, secret);
    }
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
          <DialogTitle>{isEditing ? 'Update server credentials' : 'Add server'}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? 'Replace the saved login secret for this server. Credentials stay encrypted on this machine.'
              : 'No terminal needed. Credentials are encrypted with your OS keychain and never leave this machine.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label>Provider</Label>
            <Select value={provider} onValueChange={pickProvider}>
              <SelectTrigger>
                <span className="flex items-center gap-2">
                  <ProviderLogo id={provider} />
                  {prov.label}
                </span>
              </SelectTrigger>
              <SelectContent>
                {Object.entries(PROVIDERS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    <span className="flex items-center gap-2">
                      <ProviderLogo id={k} />
                      {v.label}
                    </span>
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
                      <p className="text-xs text-muted-foreground">
                        Once the key is on your server, click{' '}
                        <span className="font-medium text-ink">Test connection</span>{' '}
                        to verify it before saving.
                      </p>
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="paste" className="space-y-2 pt-3">
                  <input
                    ref={keyFileInput}
                    type="file"
                    accept=".pem,.key,.txt,application/x-pem-file,text/plain"
                    className="hidden"
                    onChange={onKeyFile}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    className="w-full"
                    onClick={() => keyFileInput.current?.click()}
                  >
                    <Upload className="h-4 w-4" />
                    {keyFileName
                      ? `Loaded: ${keyFileName}`
                      : 'Upload key file (.pem from AWS)'}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Pick the <code>.pem</code> key AWS gave you when you created the
                    instance — or paste it below.
                  </p>
                  <Label htmlFor="key">Private key (PEM / OpenSSH)</Label>
                  <Textarea
                    id="key"
                    value={privateKey}
                    onChange={(e) => {
                      setPrivateKey(e.target.value);
                      if (keyFileName) setKeyFileName('');
                    }}
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
            disabled={!valid || testing}
            title={
              usingGenerated
                ? 'Add the generated public key to your server first, then test.'
                : undefined
            }
          >
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
          <Button onClick={save} disabled={!valid || saving}>
            {saving ? 'Saving…' : isEditing ? 'Update credentials' : 'Save server'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
