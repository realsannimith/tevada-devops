import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  KeyRound,
  Lock,
  Sparkles,
  Upload,
} from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { ProviderLogo } from '@/components/providerLogos';
import { cn } from '@/lib/utils';
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

/** One flat choice instead of the old nested tabs (SSH key / Password, then
 *  Generate / Paste): pick how to log in and the form below follows. */
type AuthMethod = 'generate' | 'paste' | 'password';

const AUTH_METHODS: {
  id: AuthMethod;
  title: string;
  hint: string;
  icon: typeof Sparkles;
}[] = [
  {
    id: 'generate',
    title: 'Create an SSH key for me',
    hint: 'Recommended — we generate a key and you paste the public half into your provider.',
    icon: Sparkles,
  },
  {
    id: 'paste',
    title: 'I already have a key',
    hint: 'Upload or paste the private key you use for this server (e.g. the .pem from AWS).',
    icon: KeyRound,
  },
  {
    id: 'password',
    title: 'Use a password',
    hint: 'The root/login password your provider set or emailed you.',
    icon: Lock,
  },
];

const STEPS = [
  { n: 1, label: 'Server' },
  { n: 2, label: 'Log in' },
  { n: 3, label: 'Connect' },
] as const;

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
  const [step, setStep] = useState(1);
  const [provider, setProvider] = useState('digitalocean');
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('root');
  const [method, setMethod] = useState<AuthMethod>('generate');
  const [password, setPassword] = useState('');

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
  const [navDir, setNavDir] = useState<'fwd' | 'back'>('fwd');

  const prov = PROVIDERS[provider];
  const isEditing = Boolean(server);
  const authType: AuthType = method === 'password' ? 'password' : 'key';
  const usingGenerated = method === 'generate';

  useEffect(() => {
    if (!open || !server) return;
    setProvider('other');
    setName(server.name);
    setHost(server.host);
    setPort(String(server.port));
    setUsername(server.username);
    setMethod(server.authType === 'password' ? 'password' : 'paste');
    setPassword('');
    setPrivateKey('');
    setKeyFileName('');
    setPassphrase('');
    setGenPublicKey('');
    setGenKeyRef('');
    setCopied(false);
    // Editing is about replacing the secret, so land directly on the login step.
    setStep(2);
    setMsg({
      ok: false,
      text:
        server.authType === 'password'
          ? 'Enter the password again to replace the unreadable saved credential.'
          : 'Paste the private key again to replace the unreadable saved credential.',
    });
  }, [open, server]);

  function reset() {
    setStep(1);
    setProvider('digitalocean');
    setName('');
    setHost('');
    setPort('22');
    setUsername('root');
    setMethod('generate');
    setPassword('');
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

  const serverStepValid = Boolean(host.trim());
  const loginStepValid =
    Boolean(username.trim()) &&
    (method === 'password'
      ? !!password
      : usingGenerated
        ? !!genKeyRef
        : !!privateKey);
  const valid = serverStepValid && loginStepValid;

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

  const stepValid = step === 1 ? serverStepValid : step === 2 ? loginStepValid : valid;

  /** Step navigation remembers its direction so the content can slide the
   *  right way (forward slides in from the right, back from the left). */
  function go(n: number) {
    setNavDir(n < step ? 'back' : 'fwd');
    setStep(n);
  }

  function goNext() {
    if (!stepValid || step >= 3) return;
    setMsg(null);
    go(step + 1);
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

        {/* Step rail — passed steps stay clickable so it doubles as "back". */}
        <div className="flex items-center gap-1.5">
          {STEPS.map((s, i) => {
            const passed = step > s.n;
            const active = step === s.n;
            return (
              <div key={s.n} className="flex min-w-0 flex-1 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => passed && go(s.n)}
                  disabled={!passed && !active}
                  className={cn(
                    'flex min-w-0 items-center gap-1.5 rounded-full py-0.5 pr-2 pl-0.5 text-xs transition-colors',
                    active
                      ? 'font-medium text-ink'
                      : passed
                        ? 'text-muted-foreground hover:text-ink'
                        : 'text-muted-foreground/50',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-medium',
                      active
                        ? 'border-transparent bg-primary text-primary-foreground'
                        : passed
                          ? 'border-transparent bg-primary/15 text-primary'
                          : 'border-border',
                    )}
                  >
                    {passed ? <Check className="size-3" /> : s.n}
                  </span>
                  <span className="truncate">{s.label}</span>
                </button>
                {i < STEPS.length - 1 && (
                  <div
                    className={cn(
                      'h-px flex-1',
                      passed ? 'bg-primary/40' : 'bg-border',
                    )}
                  />
                )}
              </div>
            );
          })}
        </div>

        <div className="grid gap-4 py-2">
          {/* Keyed per step so each step glides in instead of snapping. */}
          <div
            key={step}
            className={cn(
              'grid gap-4 duration-300 animate-in fade-in-0',
              navDir === 'back' ? 'slide-in-from-left-2' : 'slide-in-from-right-2',
            )}
          >
          {step === 1 && (
            <>
              <div className="grid gap-2">
                <Label>Where is this server hosted?</Label>
                <Select value={provider} onValueChange={pickProvider}>
                  <SelectTrigger className="w-full">
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
                <p className="text-xs text-muted-foreground">
                  Picking your provider pre-fills the right login user and shows
                  where to find things.
                </p>
              </div>

              <div className="grid grid-cols-[1fr_100px] gap-2">
                <div className="grid gap-2">
                  <Label htmlFor="host">Host / IP</Label>
                  <Input
                    id="host"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="203.0.113.10"
                    autoFocus={!isEditing}
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
                <Label htmlFor="name">
                  Name{' '}
                  <span className="font-normal text-muted-foreground">
                    (optional)
                  </span>
                </Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={host.trim() || 'Production web'}
                />
                <p className="text-xs text-muted-foreground">
                  How this server appears in the sidebar. Defaults to the host.
                </p>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="grid gap-2">
                <Label htmlFor="user">Login username</Label>
                <Input
                  id="user"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>

              <div className="grid gap-2">
                <Label>How do you log in?</Label>
                <div className="grid gap-2" role="radiogroup">
                  {AUTH_METHODS.map((m) => {
                    const on = method === m.id;
                    const Icon = m.icon;
                    return (
                      <div
                        key={m.id}
                        role="radio"
                        aria-checked={on}
                        tabIndex={0}
                        onClick={() => {
                          setMethod(m.id);
                          if (!isEditing) setMsg(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setMethod(m.id);
                            if (!isEditing) setMsg(null);
                          }
                        }}
                        className={cn(
                          'flex cursor-pointer items-start gap-3 rounded-md border p-3 text-left transition-colors',
                          on
                            ? 'border-primary/50 bg-primary/5'
                            : 'border-border hover:bg-secondary/50',
                        )}
                      >
                        <Icon
                          className={cn(
                            'mt-0.5 size-4 shrink-0',
                            on ? 'text-primary' : 'text-muted-foreground',
                          )}
                        />
                        <div className="min-w-0 flex-1">
                          <span
                            className={cn(
                              'block text-sm',
                              on ? 'font-medium text-ink' : 'text-ink',
                            )}
                          >
                            {m.title}
                          </span>
                          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                            {m.hint}
                          </span>
                          {/* The generate action lives inside its card, so the
                              step stays one clean list instead of a stray
                              button floating under it. */}
                          {m.id === 'generate' && on && (
                            <div className="mt-2.5 animate-in fade-in-0 duration-200">
                              {!genPublicKey ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="secondary"
                                  onClick={generate}
                                  disabled={generating}
                                >
                                  <Sparkles className="h-3.5 w-3.5" />
                                  {generating ? 'Generating…' : 'Generate the key'}
                                </Button>
                              ) : (
                                <div className="space-y-2 rounded-md bg-secondary/60 p-2.5">
                                  <div className="flex items-center justify-between">
                                    <Label className="text-xs">
                                      Your public key — paste it into {prov.label}
                                    </Label>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void copyKey();
                                      }}
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
                                    {prov.keyHint} The private key stays
                                    encrypted on this Mac — you never handle it.
                                  </p>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {method === 'paste' && (
                <div className="space-y-2">
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
                    Pick the <code>.pem</code> key AWS gave you when you created
                    the instance — or paste it below.
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
                </div>
              )}

              {method === 'password' && (
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
              )}
            </>
          )}

          {step === 3 && (
            <>
              <div className="surface-panel grid gap-1.5 rounded-md p-3 text-sm">
                {[
                  ['Provider', prov.label],
                  ['Server', `${host.trim()}:${port || '22'}`],
                  ['Login', username.trim()],
                  [
                    'Auth',
                    method === 'password'
                      ? 'Password'
                      : usingGenerated
                        ? 'Generated SSH key'
                        : keyFileName
                          ? `Key file (${keyFileName})`
                          : 'Pasted SSH key',
                  ],
                  ['Name', name.trim() || host.trim()],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-baseline gap-3">
                    <span className="w-16 shrink-0 text-xs text-muted-foreground">
                      {k}
                    </span>
                    <span className="min-w-0 truncate text-ink">{v}</span>
                  </div>
                ))}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {usingGenerated
                  ? `Make sure the public key from the previous step is added to ${prov.label}, then test the connection before saving.`
                  : 'Run a quick test to confirm the details work, then save.'}
              </p>
            </>
          )}
          </div>

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
            variant="ghost"
            onClick={() => go(step - 1)}
            className={step === 1 ? 'invisible' : undefined}
          >
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          {step < 3 ? (
            <Button onClick={goNext} disabled={!stepValid}>
              Continue <ArrowRight className="h-4 w-4" />
            </Button>
          ) : (
            <div className="flex gap-2">
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
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
