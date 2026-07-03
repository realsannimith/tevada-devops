import { useEffect, useState } from 'react';
import { Wand2, ArrowLeft, Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AgentFeed } from '@/components/AgentFeed';
import { useAgentRun } from '@/hooks/useAgentRun';
import { useServers } from '@/hooks/useServers';
import type { PlaybookInput, PlaybookMeta } from '@/shared/ipc-types';

export function WizardsView() {
  const { servers } = useServers();
  const [playbooks, setPlaybooks] = useState<PlaybookMeta[]>([]);
  const [selected, setSelected] = useState<PlaybookMeta | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [serverId, setServerId] = useState<string>('');
  const {
    feed,
    running,
    error,
    approval,
    start,
    cancel,
    respondApproval,
    clear,
  } = useAgentRun();

  useEffect(() => {
    window.easyhost.playbooks.list().then(setPlaybooks).catch(() => {});
  }, []);

  function choose(pb: PlaybookMeta) {
    setSelected(pb);
    setValues({});
    clear();
    if (servers[0]) setServerId(servers[0].id);
  }

  const requiredMissing =
    selected?.inputs.some((i) => i.required && !values[i.key]?.trim()) ?? false;

  async function run() {
    if (!selected || !serverId || running) return;
    await start({
      messages: [],
      serverIds: [serverId],
      playbookId: selected.id,
      playbookValues: values,
    });
  }

  if (!selected) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <header className="mb-6">
          <h1 className="text-lg font-semibold tracking-tight">Wizards</h1>
          <p className="text-sm text-muted-foreground">
            Guided, AI-driven setups. Fill in a few fields and the agent does the
            rest.
          </p>
        </header>
        <div className="grid gap-4 sm:grid-cols-2">
          {playbooks.map((pb) => (
            <button
              key={pb.id}
              onClick={() => choose(pb)}
              className="rounded-lg border bg-card p-5 text-left transition-colors hover:border-primary"
            >
              <Wand2 className="mb-3 h-5 w-5 text-primary" />
              <h3 className="font-medium">{pb.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {pb.description}
              </p>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b px-6 py-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setSelected(null)}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            {selected.title}
          </h1>
          <p className="text-xs text-muted-foreground">{selected.description}</p>
        </div>
      </header>

      <div className="grid flex-1 grid-cols-[340px_1fr] overflow-hidden">
        <div className="space-y-4 overflow-y-auto border-r p-5">
          <div className="grid gap-2">
            <Label>Target server</Label>
            <Select value={serverId} onValueChange={setServerId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a server" />
              </SelectTrigger>
              <SelectContent>
                {servers.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selected.inputs.map((field) => (
            <Field
              key={field.key}
              field={field}
              value={values[field.key] ?? ''}
              onChange={(v) =>
                setValues((prev) => ({ ...prev, [field.key]: v }))
              }
            />
          ))}

          {running ? (
            <Button variant="destructive" className="w-full" onClick={cancel}>
              <Square className="h-4 w-4" /> Stop
            </Button>
          ) : (
            <Button
              className="w-full"
              onClick={run}
              disabled={!serverId || requiredMissing}
            >
              <Play className="h-4 w-4" /> Run wizard
            </Button>
          )}
        </div>

        <div className="flex flex-col overflow-hidden">
          <AgentFeed
            feed={feed}
            error={error}
            approval={approval}
            onApprove={respondApproval}
          />
        </div>
      </div>
    </div>
  );
}

function Field({
  field,
  value,
  onChange,
}: {
  field: PlaybookInput;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <Label>
        {field.label}
        {field.required && <span className="text-destructive"> *</span>}
      </Label>
      {field.type === 'select' && field.options ? (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger>
            <SelectValue placeholder="Choose…" />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
        />
      )}
    </div>
  );
}
