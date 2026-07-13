/**
 * A minimal editor for a remote text file, opened from the Files tab. Reads the
 * file over SFTP (capped in main), lets the user edit and save it back. Files
 * larger than the read cap open read-only (truncated) so we never write back a
 * partial file and silently drop the rest.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Loader2Icon } from '@/lib/icons';

export type EditorTarget = {
  serverId: string;
  /** Absolute remote path. */
  path: string;
  /** Basename, for the dialog title. */
  name: string;
};

export function FileEditorDialog({
  target,
  onOpenChange,
}: {
  target: EditorTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-0 overflow-hidden p-0 sm:max-w-3xl">
        {target && (
          <Editor
            key={`${target.serverId}:${target.path}`}
            target={target}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Editor({
  target,
  onClose,
}: {
  target: EditorTarget;
  onClose: () => void;
}) {
  const { serverId, path, name } = target;
  const [original, setOriginal] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await window.easyhost.sftp.read(serverId, path);
      if (res.ok === false) {
        setLoadError(res.error);
      } else {
        setOriginal(res.content);
        setValue(res.content);
        setTruncated(res.truncated);
      }
    } catch {
      setLoadError('Could not read this file.');
    }
  }, [serverId, path]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = original !== null && value !== original;

  const save = useCallback(async () => {
    if (!dirty || truncated) return;
    setSaving(true);
    try {
      const res = await window.easyhost.sftp.write(serverId, path, value);
      if (res.ok === false) {
        toast.error("Couldn't save", { description: res.error });
      } else {
        setOriginal(value);
        toast.success(`Saved ${name}`);
        onClose();
      }
    } finally {
      setSaving(false);
    }
  }, [dirty, truncated, serverId, path, value, name, onClose]);

  return (
    <div className="flex max-h-[85vh] flex-col">
      <DialogHeader className="space-y-1 border-b border-border pb-4 pl-6 pr-14 pt-5 text-left">
        <DialogTitle className="text-[15px] font-semibold tracking-[-0.01em] text-ink">
          {name}
        </DialogTitle>
        <p className="truncate font-mono text-[11px] text-muted-foreground/70">
          {path}
        </p>
      </DialogHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {loadError ? (
          <p className="text-[12px] text-destructive">{loadError}</p>
        ) : original === null ? (
          <p className="flex items-center gap-2 py-6 text-[12px] text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" />
            Loading…
          </p>
        ) : (
          <>
            {truncated && (
              <p className="mb-2 rounded-md bg-warning/10 px-3 py-2 text-[11px] text-warning">
                This file is too large to edit safely — showing the first part,
                read-only. Download it to view the whole file.
              </p>
            )}
            <Textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              readOnly={truncated}
              spellCheck={false}
              autoComplete="off"
              className="h-[52vh] resize-none font-mono text-[12px] leading-relaxed"
            />
          </>
        )}
      </div>

      {original !== null && (
        <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-3">
          <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {truncated
              ? 'Read-only — file exceeds the edit size limit.'
              : dirty
                ? 'Unsaved changes.'
                : 'Up to date.'}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-3 text-[12px] text-muted-foreground"
              disabled={saving}
              onClick={onClose}
            >
              {dirty && !truncated ? 'Discard' : 'Close'}
            </Button>
            <Button
              size="sm"
              className="h-8 gap-1.5 px-3 text-[12px]"
              disabled={saving || !dirty || truncated}
              onClick={() => void save()}
            >
              {saving && <Loader2Icon className="size-3.5 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
