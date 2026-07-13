/**
 * Files tab — a user-facing SFTP file browser. Browse the remote filesystem,
 * create folders, rename, delete, upload from and download to the local
 * machine, and edit small text files inline.
 *
 * All work goes through window.easyhost.sftp (main/connection-manager.ts), the
 * same lazily-opened SFTP session the agent uses — nothing here touches the
 * network or the local filesystem directly; uploads/downloads pick their local
 * path through the OS-native dialog in main. Remote paths are POSIX.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmButton } from '@/components/ConfirmButton';
import { FileEditorDialog, type EditorTarget } from '@/components/FileEditorDialog';
import { useServers } from '@/hooks/useServers';
import {
  ArrowUpIcon,
  CloudDownloadIcon,
  CloudUploadIcon,
  FileTextIcon,
  FolderIcon,
  FolderPlusIcon,
  HomeIcon,
  Loader2Icon,
  PencilIcon,
  RefreshIcon,
  TrashIcon,
} from '@/lib/icons';
import { cn } from '@/lib/utils';
import type { SftpEntry } from '@/shared/ipc-types';

// Extensions we open in the built-in editor. Everything else downloads.
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'log', 'conf', 'cfg', 'ini', 'env', 'json', 'yaml',
  'yml', 'toml', 'xml', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'js',
  'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c',
  'h', 'cpp', 'hpp', 'cc', 'cs', 'php', 'sh', 'bash', 'zsh', 'fish', 'sql',
  'csv', 'tsv', 'properties', 'service', 'nginx', 'gitignore', 'dockerfile',
  'lock', 'text', 'diff', 'patch',
]);

/** A text-ish file opens in the editor; a dotfile (.bashrc) or extensionless
 *  file (Dockerfile, README) is assumed text too — the editor still guards on
 *  what it reads back. */
function isTextFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('.')) return true;
  if (!lower.includes('.')) return true;
  return TEXT_EXT.has(lower.split('.').pop() ?? '');
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx);
}

function crumbsOf(path: string): { name: string; path: string }[] {
  const parts = path.split('/').filter(Boolean);
  const acc = [{ name: '/', path: '/' }];
  let cur = '';
  for (const part of parts) {
    cur += `/${part}`;
    acc.push({ name: part, path: cur });
  }
  return acc;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function formatMtime(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** Lower 9 mode bits as an rwxr-xr-x string — a familiar at-a-glance summary. */
function modeString(mode: number): string {
  const bits = ['r', 'w', 'x'];
  let out = '';
  for (let shift = 8; shift >= 0; shift--) {
    out += mode & (1 << shift) ? bits[2 - (shift % 3)] : '-';
  }
  return out;
}

/** Directories (and symlinks, which usually point at dirs) sort first, then by
 *  name, case-insensitive — the ordering every file manager uses. */
function sortEntries(entries: SftpEntry[]): SftpEntry[] {
  const rank = (e: SftpEntry) =>
    e.type === 'directory' ? 0 : e.type === 'symlink' ? 1 : 2;
  return [...entries].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
}

export function FilesView({ serverId }: { serverId: string }) {
  const { statusOf } = useServers();
  const connected = statusOf(serverId) === 'connected';

  const [cwd, setCwd] = useState<string | null>(null);
  const [homePath, setHomePath] = useState<string | null>(null);
  const [entries, setEntries] = useState<SftpEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Inline editors — one active at a time.
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const listSeq = useRef(0);

  // A fresh server means a fresh browse — go back to its home directory.
  useEffect(() => {
    setCwd(null);
    setHomePath(null);
    setEntries(null);
    setError(null);
    setCreatingFolder(false);
    setRenaming(null);
  }, [serverId]);

  // Resolve the login home once connected, then list from there.
  useEffect(() => {
    if (!connected || cwd !== null) return;
    let cancelled = false;
    void window.easyhost.sftp.home(serverId).then((res) => {
      if (cancelled) return;
      if (res.ok === false) {
        setError(res.error);
      } else {
        setHomePath(res.path);
        setCwd(res.path);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [connected, cwd, serverId]);

  const list = useCallback(
    async (path: string, silent = false) => {
      const seq = ++listSeq.current;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const res = await window.easyhost.sftp.list(serverId, path);
        if (seq !== listSeq.current) return; // stale (navigated away / switched server)
        if (res.ok === false) {
          if (!silent) setError(res.error);
        } else {
          setEntries(sortEntries(res.entries));
          // realpath may differ from what we asked for (symlinks, '..') — trust it.
          if (res.path !== path) setCwd(res.path);
          setError(null);
        }
      } catch {
        if (seq === listSeq.current && !silent) setError('Could not read this folder.');
      } finally {
        if (seq === listSeq.current && !silent) setLoading(false);
      }
    },
    [serverId],
  );

  useEffect(() => {
    if (cwd !== null && connected) void list(cwd);
  }, [cwd, connected, serverId, list]);

  const refresh = useCallback(() => {
    if (cwd !== null) void list(cwd);
  }, [cwd, list]);

  const navigate = useCallback((path: string) => {
    setCreatingFolder(false);
    setRenaming(null);
    setEntries(null);
    setCwd(path);
  }, []);

  const download = useCallback(
    async (e: SftpEntry) => {
      const res = await window.easyhost.sftp.download(serverId, e.path, e.name);
      if (res.ok === false) toast.error(`Couldn't download ${e.name}`, { description: res.error });
      else if (!res.canceled) toast.success(`Downloaded ${e.name}`);
    },
    [serverId],
  );

  // Directory → descend. Symlink → try to descend; if it isn't a directory,
  // leave the user where they are with a hint. File → edit (text) or download.
  const openEntry = useCallback(
    async (e: SftpEntry) => {
      if (e.type === 'directory') {
        navigate(e.path);
        return;
      }
      if (e.type === 'symlink') {
        const res = await window.easyhost.sftp.list(serverId, e.path);
        if (res.ok === false) toast.message(`${e.name} isn't a folder`);
        else navigate(res.path);
        return;
      }
      if (isTextFile(e.name)) setEditorTarget({ serverId, path: e.path, name: e.name });
      else void download(e);
    },
    [serverId, navigate, download],
  );

  const upload = useCallback(async () => {
    if (cwd === null) return;
    setBusy(true);
    try {
      const res = await window.easyhost.sftp.upload(serverId, cwd);
      if (res.ok === false) {
        toast.error('Upload failed', { description: res.error });
      } else if (!res.canceled) {
        toast.success(`Uploaded ${res.count} file${res.count === 1 ? '' : 's'}`);
        void list(cwd, true);
      }
    } finally {
      setBusy(false);
    }
  }, [cwd, serverId, list]);

  const createFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (cwd === null || !name || name.includes('/')) return;
    setBusy(true);
    try {
      const res = await window.easyhost.sftp.mkdir(serverId, joinPath(cwd, name));
      if (res.ok === false) {
        toast.error("Couldn't create folder", { description: res.error });
      } else {
        setCreatingFolder(false);
        setNewFolderName('');
        void list(cwd, true);
      }
    } finally {
      setBusy(false);
    }
  }, [cwd, newFolderName, serverId, list]);

  const commitRename = useCallback(
    async (entry: SftpEntry) => {
      const name = renameValue.trim();
      if (cwd === null || !name || name.includes('/') || name === entry.name) {
        setRenaming(null);
        return;
      }
      setBusy(true);
      try {
        const res = await window.easyhost.sftp.rename(serverId, entry.path, joinPath(cwd, name));
        if (res.ok === false) toast.error("Couldn't rename", { description: res.error });
        else void list(cwd, true);
      } finally {
        setBusy(false);
        setRenaming(null);
      }
    },
    [cwd, renameValue, serverId, list],
  );

  const remove = useCallback(
    async (entry: SftpEntry) => {
      if (cwd === null) return;
      setBusy(true);
      try {
        const res = await window.easyhost.sftp.remove(
          serverId,
          entry.path,
          entry.type === 'directory',
        );
        if (res.ok === false) toast.error(`Couldn't delete ${entry.name}`, { description: res.error });
        else void list(cwd, true);
      } finally {
        setBusy(false);
      }
    },
    [cwd, serverId, list],
  );

  if (!connected) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Connect this server to browse its files.
      </div>
    );
  }

  const crumbs = cwd ? crumbsOf(cwd) : [];
  const atRoot = cwd === '/' || cwd === null;

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Toolbar: breadcrumbs + actions */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7 shrink-0 text-muted-foreground"
          title="Home"
          disabled={homePath === null || cwd === homePath}
          onClick={() => homePath && navigate(homePath)}
        >
          <HomeIcon className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7 shrink-0 text-muted-foreground"
          title="Up one level"
          disabled={atRoot}
          onClick={() => cwd && navigate(parentOf(cwd))}
        >
          <ArrowUpIcon className="size-4" />
        </Button>
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
          <div className="flex items-center whitespace-nowrap font-mono text-[12px]">
            {crumbs.map((c, i) => (
              <span key={c.path} className="flex items-center">
                {i > 0 && <span className="px-0.5 text-muted-foreground/40">/</span>}
                <button
                  className={cn(
                    'rounded px-1 py-0.5 hover:bg-secondary',
                    i === crumbs.length - 1
                      ? 'text-ink'
                      : 'text-muted-foreground',
                  )}
                  onClick={() => navigate(c.path)}
                >
                  {c.name === '/' ? '/' : c.name}
                </button>
              </span>
            ))}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1.5 px-2.5 text-[11px] text-muted-foreground"
          disabled={busy || cwd === null}
          onClick={() => {
            setRenaming(null);
            setNewFolderName('');
            setCreatingFolder(true);
          }}
        >
          <FolderPlusIcon className="size-3.5" />
          New folder
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1.5 px-2.5 text-[11px] text-muted-foreground"
          disabled={busy || cwd === null}
          onClick={() => void upload()}
        >
          <CloudUploadIcon className="size-3.5" />
          Upload
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7 shrink-0 text-muted-foreground"
          title="Refresh"
          disabled={loading}
          onClick={refresh}
        >
          {loading ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <RefreshIcon className="size-4" />
          )}
        </Button>
      </div>

      {/* Listing */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && entries === null ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={refresh}>
              Retry
            </Button>
          </div>
        ) : entries === null ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            Loading…
          </div>
        ) : (
          <div className="mx-auto max-w-3xl px-4 py-3">
            {error && (
              <p className="mb-2 text-[11px] text-destructive">{error}</p>
            )}
            {/* Inline "new folder" row */}
            {creatingFolder && (
              <div className="mb-1 flex items-center gap-3 rounded-lg border border-dashed border-border px-3 py-2">
                <FolderIcon className="size-[18px] shrink-0 text-muted-foreground" />
                <Input
                  autoFocus
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void createFolder();
                    if (e.key === 'Escape') {
                      setCreatingFolder(false);
                      setNewFolderName('');
                    }
                  }}
                  placeholder="Folder name"
                  spellCheck={false}
                  autoComplete="off"
                  className="h-7 flex-1 text-[13px]"
                />
                <Button
                  size="sm"
                  className="h-7 px-3 text-[11px]"
                  disabled={busy || !newFolderName.trim()}
                  onClick={() => void createFolder()}
                >
                  Create
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px] text-muted-foreground"
                  onClick={() => {
                    setCreatingFolder(false);
                    setNewFolderName('');
                  }}
                >
                  Cancel
                </Button>
              </div>
            )}

            {entries.length === 0 && !creatingFolder ? (
              <div className="flex h-40 items-center justify-center text-[13px] text-muted-foreground">
                This folder is empty.
              </div>
            ) : (
              <div className="surface-panel divide-y divide-border">
                {entries.map((e) => (
                  <FileRow
                    key={e.path}
                    entry={e}
                    renaming={renaming === e.path}
                    renameValue={renameValue}
                    onRenameChange={setRenameValue}
                    onRenameStart={() => {
                      setCreatingFolder(false);
                      setRenameValue(e.name);
                      setRenaming(e.path);
                    }}
                    onRenameCommit={() => void commitRename(e)}
                    onRenameCancel={() => setRenaming(null)}
                    onOpen={() => void openEntry(e)}
                    onEdit={() => setEditorTarget({ serverId, path: e.path, name: e.name })}
                    onDownload={() => void download(e)}
                    onDelete={() => void remove(e)}
                    busy={busy}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <FileEditorDialog
        target={editorTarget}
        onOpenChange={(open) => {
          if (!open) setEditorTarget(null);
        }}
      />
    </div>
  );
}

function FileRow({
  entry,
  renaming,
  renameValue,
  onRenameChange,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
  onOpen,
  onEdit,
  onDownload,
  onDelete,
  busy,
}: {
  entry: SftpEntry;
  renaming: boolean;
  renameValue: string;
  onRenameChange: (v: string) => void;
  onRenameStart: () => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onOpen: () => void;
  onEdit: () => void;
  onDownload: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const isDir = entry.type === 'directory' || entry.type === 'symlink';
  const Icon = isDir ? FolderIcon : FileTextIcon;
  const editable = entry.type === 'file' && isTextFile(entry.name);

  return (
    <div className="group flex items-center gap-3 px-4 py-2">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary">
        <Icon
          aria-hidden
          className={cn(
            'size-[15px] shrink-0',
            isDir ? 'text-primary' : 'text-muted-foreground',
          )}
        />
      </span>

      {renaming ? (
        <Input
          autoFocus
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRenameCommit();
            if (e.key === 'Escape') onRenameCancel();
          }}
          onBlur={onRenameCommit}
          spellCheck={false}
          autoComplete="off"
          className="h-7 flex-1 text-[13px]"
        />
      ) : (
        <button
          className="min-w-0 flex-1 text-left"
          onClick={onOpen}
          title={entry.type === 'symlink' ? `${entry.name} (symlink)` : entry.name}
        >
          <span
            className={cn(
              'truncate text-[13px] tracking-[-0.015em]',
              isDir ? 'font-medium text-ink' : 'text-ink',
            )}
          >
            {entry.name}
          </span>
          {entry.type === 'symlink' && (
            <span className="ml-1.5 text-[10px] text-muted-foreground/60">↳ link</span>
          )}
        </button>
      )}

      {!renaming && (
        <>
          <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground/50 sm:inline">
            {modeString(entry.mode)}
          </span>
          <span className="hidden w-16 shrink-0 text-right font-mono text-[11px] text-muted-foreground/70 sm:inline">
            {entry.type === 'file' ? formatSize(entry.size) : ''}
          </span>
          <span className="hidden w-16 shrink-0 text-right text-[11px] text-muted-foreground/70 md:inline">
            {formatMtime(entry.mtime)}
          </span>

          {/* Row actions — appear on hover, mirroring the Artifacts tab. */}
          <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            {editable && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7 text-muted-foreground"
                title={`Edit ${entry.name}`}
                onClick={onEdit}
              >
                <PencilIcon className="size-3.5" />
              </Button>
            )}
            {entry.type === 'file' && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7 text-muted-foreground"
                title={`Download ${entry.name}`}
                onClick={onDownload}
              >
                <CloudDownloadIcon className="size-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7 text-muted-foreground"
              title={`Rename ${entry.name}`}
              disabled={busy}
              onClick={onRenameStart}
            >
              <RenameGlyph />
            </Button>
            <ConfirmButton
              variant="ghost"
              size="icon-sm"
              className="size-7 text-muted-foreground hover:text-destructive"
              title={`Delete ${entry.name}`}
              disabled={busy}
              confirmTitle={`Delete ${entry.name}?`}
              confirmDescription={
                entry.type === 'directory'
                  ? 'This permanently deletes the folder and everything inside it on the server. This cannot be undone.'
                  : 'This permanently deletes the file on the server. This cannot be undone.'
              }
              confirmLabel="Delete"
              onConfirm={onDelete}
            >
              <TrashIcon className="size-3.5" />
            </ConfirmButton>
          </div>
        </>
      )}
    </div>
  );
}

/** A rename affordance distinct from the pencil "edit contents" icon — a small
 *  cursor/text glyph so the two file actions don't read as the same button. */
function RenameGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5"
      aria-hidden
    >
      <path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" />
      <path d="M12 4v16" />
      <path d="M9 20h6" />
    </svg>
  );
}
