import { useState } from 'react';
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
import type { AuthType, ServerSecret } from '@/shared/ipc-types';
import { useServers } from '@/hooks/useServers';

export function ServerFormDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { refresh } = useServers();
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('root');
  const [authType, setAuthType] = useState<AuthType>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function reset() {
    setName('');
    setHost('');
    setPort('22');
    setUsername('root');
    setAuthType('password');
    setPassword('');
    setPrivateKey('');
    setPassphrase('');
    setMsg(null);
  }

  function buildPayload() {
    const profile = {
      name: name.trim() || host.trim(),
      host: host.trim(),
      port: Number(port) || 22,
      username: username.trim(),
      authType,
    };
    const secret: ServerSecret = {
      password: authType === 'password' ? password : undefined,
      privateKey: authType === 'key' ? privateKey : undefined,
      passphrase: passphrase || undefined,
    };
    return { profile, secret };
  }

  const valid =
    host.trim() &&
    username.trim() &&
    (authType === 'password' ? password : privateKey);

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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add server</DialogTitle>
          <DialogDescription>
            Credentials are encrypted with your OS keychain and never leave this
            machine.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
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
              <Label htmlFor="host">Host</Label>
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
              <TabsTrigger value="password">Password</TabsTrigger>
              <TabsTrigger value="key">Private key</TabsTrigger>
            </TabsList>
            <TabsContent value="password" className="pt-2">
              <div className="grid gap-2">
                <Label htmlFor="pw">Password</Label>
                <Input
                  id="pw"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </TabsContent>
            <TabsContent value="key" className="pt-2">
              <div className="grid gap-2">
                <Label htmlFor="key">Private key (PEM)</Label>
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
              </div>
            </TabsContent>
          </Tabs>

          {msg && (
            <p
              className={
                msg.ok
                  ? 'text-sm text-green-500'
                  : 'text-sm text-destructive'
              }
            >
              {msg.text}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={test} disabled={!valid || testing}>
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
