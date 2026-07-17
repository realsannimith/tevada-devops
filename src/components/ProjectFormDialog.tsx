import { useEffect, useState } from 'react';
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
import { CheckIcon, ServerIcon } from '@/lib/icons';
import { cn } from '@/lib/utils';
import type { Project } from '@/shared/ipc-types';
import { useProjects } from '@/hooks/useProjects';
import { useServers } from '@/hooks/useServers';

/** A small on-brand palette for the project's accent tag. */
const COLORS = [
  '#6366f1',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#ec4899',
  '#8b5cf6',
  '#64748b',
];

export function ProjectFormDialog({
  open,
  onOpenChange,
  project,
  onAddServer,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  project?: Project | null;
  /** Lets the empty "no servers" state jump straight into the Add server flow. */
  onAddServer?: () => void;
}) {
  const { add, update } = useProjects();
  const { servers, refresh: refreshServers } = useServers();
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(COLORS[0]);
  const [memory, setMemory] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const isEditing = Boolean(project);

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? '');
    setColor(project?.color ?? COLORS[0]);
    setMemory(project?.memory ?? '');
    // Seed the membership from whichever servers already point at this project.
    setSelected(
      new Set(
        project
          ? servers
              .filter((s) => s.projectIds?.includes(project.id))
              .map((s) => s.id)
          : [],
      ),
    );
    setSaving(false);
  }, [open, project, servers]);

  function toggleServer(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Reconcile each server's projectIds against the current selection. Only
   *  servers whose membership changed are written. */
  async function syncMembership(projectId: string) {
    await Promise.all(
      servers.map((s) => {
        const wasMember = s.projectIds?.includes(projectId) ?? false;
        const isMember = selected.has(s.id);
        if (wasMember === isMember) return Promise.resolve();
        const projectIds = isMember
          ? [...(s.projectIds ?? []), projectId]
          : (s.projectIds ?? []).filter((id) => id !== projectId);
        return window.easyhost.servers.update(s.id, { projectIds });
      }),
    );
    await refreshServers();
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    const payload = { name: trimmed, color, memory: memory.trim() || undefined };
    const id = project
      ? (await update(project.id, payload), project.id)
      : (await add(payload)).id;
    await syncMembership(id);
    setSaving(false);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit project' : 'New project'}</DialogTitle>
          <DialogDescription>
            Group servers and give the agent project memory. A chat tagged to
            this project can only reach the servers you add here.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Storefront"
            />
          </div>

          <div className="grid gap-2">
            <Label>Colour</Label>
            <div className="flex flex-wrap gap-2">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Use colour ${c}`}
                  onClick={() => setColor(c)}
                  className={cn(
                    'size-6 rounded-full border transition',
                    color === c
                      ? 'ring-2 ring-offset-2 ring-offset-background'
                      : 'border-border/60',
                  )}
                  style={{ backgroundColor: c, borderColor: c }}
                />
              ))}
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="project-memory">Project memory</Label>
            <Textarea
              id="project-memory"
              value={memory}
              onChange={(e) => setMemory(e.target.value)}
              placeholder={
                'Notes the agent should always know for this project — e.g. the stack (Next.js + Postgres), the domain, deploy conventions, or where credentials live.'
              }
              className="h-28 text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Injected into the agent&apos;s context on every chat tagged to this
              project.
            </p>
          </div>

          <div className="grid gap-2">
            <Label>Servers</Label>
            <p className="-mt-1 text-xs text-muted-foreground">
              Tick the servers this project&apos;s chats are allowed to use. You
              can change this any time.
            </p>
            {servers.length === 0 ? (
              <div className="surface-panel grid justify-items-start gap-2 rounded-md p-3">
                <p className="text-xs text-muted-foreground">
                  You haven&apos;t added any servers yet. A project without
                  servers still works — it just groups chats.
                </p>
                {onAddServer && (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      onOpenChange(false);
                      onAddServer();
                    }}
                  >
                    <ServerIcon className="size-3.5" /> Add a server
                  </Button>
                )}
              </div>
            ) : (
              <div className="surface-panel grid gap-1 rounded-md p-1">
                {servers.map((s) => {
                  const on = selected.has(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => toggleServer(s.id)}
                      className={cn(
                        'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition',
                        on
                          ? 'bg-secondary text-ink'
                          : 'text-muted-foreground hover:bg-secondary/50',
                      )}
                    >
                      <span
                        className={cn(
                          'flex size-4 shrink-0 items-center justify-center rounded border',
                          on
                            ? 'border-transparent bg-primary text-primary-foreground'
                            : 'border-border',
                        )}
                      >
                        {on && <CheckIcon className="size-3" />}
                      </span>
                      <ServerIcon className="size-3.5 shrink-0" />
                      <span className="truncate">{s.name}</span>
                      <span className="ml-auto truncate text-xs text-muted-foreground">
                        {s.host}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button onClick={save} disabled={!name.trim() || saving}>
            {saving ? 'Saving…' : isEditing ? 'Save project' : 'Create project'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
