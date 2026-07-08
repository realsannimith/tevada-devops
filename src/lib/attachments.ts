/**
 * Renderer-side helpers for turning picked/pasted/dropped files into
 * ChatAttachments the composer can carry and the agent can consume.
 */
import { ATTACHMENT_LIMITS, type ChatAttachment } from '@/shared/ipc-types';

/** Extensions we treat as text even when the browser reports no/`application` MIME
 *  (config & code files the agent can read and deploy). */
const TEXT_EXTENSIONS = new Set([
  'txt', 'log', 'env', 'yml', 'yaml', 'json', 'toml', 'ini', 'conf', 'cfg',
  'md', 'sh', 'bash', 'zsh', 'dockerfile', 'nginx', 'service', 'properties',
  'py', 'js', 'ts', 'tsx', 'jsx', 'go', 'rs', 'rb', 'php', 'java', 'sql',
  'html', 'css', 'xml', 'csv', 'gitignore', 'lock',
]);

export type AttachmentKind = 'image' | 'text' | 'unsupported';

/** Classify a file by MIME type then extension. */
export function classifyFile(name: string, mimeType: string): AttachmentKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('text/')) return 'text';
  const ext = name.includes('.')
    ? name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    : name.toLowerCase(); // e.g. "Dockerfile" with no dot
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'unsupported';
}

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

const readAsText = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });

export type ReadResult =
  | { ok: true; attachment: ChatAttachment }
  | { ok: false; error: string };

let attachmentSeq = 0;

/** Read one file into a ChatAttachment, enforcing the size caps. */
export async function readFileAttachment(file: File): Promise<ReadResult> {
  const kind = classifyFile(file.name, file.type);
  const id = `att_${Date.now()}_${attachmentSeq++}`;
  if (kind === 'image') {
    if (file.size > ATTACHMENT_LIMITS.maxImageBytes) {
      return {
        ok: false,
        error: `${file.name} is too large (max ${Math.round(
          ATTACHMENT_LIMITS.maxImageBytes / (1024 * 1024),
        )} MB for images).`,
      };
    }
    const dataUrl = await readAsDataUrl(file);
    return {
      ok: true,
      attachment: {
        id,
        name: file.name,
        mediaType: file.type || 'image/png',
        kind: 'image',
        size: file.size,
        dataUrl,
      },
    };
  }
  if (kind === 'text') {
    if (file.size > ATTACHMENT_LIMITS.maxTextBytes) {
      return {
        ok: false,
        error: `${file.name} is too large (max ${Math.round(
          ATTACHMENT_LIMITS.maxTextBytes / 1024,
        )} KB for text files).`,
      };
    }
    const text = await readAsText(file);
    return {
      ok: true,
      attachment: {
        id,
        name: file.name,
        mediaType: file.type || 'text/plain',
        kind: 'text',
        size: file.size,
        text,
      },
    };
  }
  return {
    ok: false,
    error: `${file.name}: unsupported file type. Attach an image or a text/config file.`,
  };
}

/** Human-readable size, e.g. "12 KB", "1.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
