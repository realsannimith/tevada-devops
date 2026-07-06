/**
 * Lean Shiki wrapper for read-only chat code blocks.
 *
 * Mirrors the shape of FCode's `syntaxHighlighting.ts` (a lazily-created
 * highlighter singleton + an HTML cache), but stands alone: it loads a curated
 * set of languages relevant to a DevOps/SSH agent and two bundled themes that
 * track Tevada DevOps's light/dark tokens. Shiki itself is dynamically imported so
 * it is code-split out of the main renderer bundle.
 */
import type { Highlighter } from 'shiki';

const LIGHT_THEME = 'github-light';
const DARK_THEME = 'github-dark';

// Curated language set — enough to cover what the agent streams (shell, config,
// infra, and the odd app snippet) without pulling Shiki's full grammar bundle.
// Anything outside this list falls back to unhighlighted plain text.
const LANGS = [
  'bash',
  'shellscript',
  'shellsession',
  'json',
  'jsonc',
  'yaml',
  'toml',
  'ini',
  'dockerfile',
  'nginx',
  'apache',
  'diff',
  'markdown',
  'html',
  'xml',
  'css',
  'javascript',
  'typescript',
  'jsx',
  'tsx',
  'python',
  'go',
  'rust',
  'sql',
  'properties',
  'systemd',
  'http',
  'powershell',
] as const;

// Common fence tokens mapped onto a loaded grammar. Unmapped tokens are looked
// up directly; if still unknown, `highlightToHtml` degrades to plain text.
const LANG_ALIASES: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'shellsession',
  'sh-session': 'shellsession',
  yml: 'yaml',
  dockerfile: 'dockerfile',
  docker: 'dockerfile',
  conf: 'ini',
  cfg: 'ini',
  env: 'properties',
  dotenv: 'properties',
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  golang: 'go',
  rs: 'rust',
  htm: 'html',
  ps1: 'powershell',
  service: 'systemd',
  text: 'text',
  txt: 'text',
  plaintext: 'text',
  '': 'text',
};

const PLAIN_LANGS = new Set(['text', 'txt', 'plaintext', 'plain', 'ansi']);

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki')
      .then(({ createHighlighter, createJavaScriptRegexEngine }) =>
        createHighlighter({
          themes: [LIGHT_THEME, DARK_THEME],
          langs: [...LANGS],
          // JS regex engine (not the WASM oniguruma default) so highlighting
          // works in the packaged Electron `file://` renderer, matching FCode.
          engine: createJavaScriptRegexEngine(),
        }),
      )
      .catch((error) => {
        // Reset so a later render can retry instead of caching the rejection.
        highlighterPromise = null;
        throw error;
      });
  }
  return highlighterPromise;
}

export function normalizeLanguage(raw: string | undefined): string {
  const value = (raw ?? '').trim().toLowerCase();
  return LANG_ALIASES[value] ?? value;
}

const MAX_CACHE_ENTRIES = 240;
const htmlCache = new Map<string, string>();

function cacheGet(key: string): string | undefined {
  const value = htmlCache.get(key);
  if (value !== undefined) {
    // Refresh recency (Map preserves insertion order → cheap LRU).
    htmlCache.delete(key);
    htmlCache.set(key, value);
  }
  return value;
}

function cacheSet(key: string, value: string): void {
  htmlCache.set(key, value);
  if (htmlCache.size > MAX_CACHE_ENTRIES) {
    const oldest = htmlCache.keys().next().value;
    if (oldest !== undefined) htmlCache.delete(oldest);
  }
}

/**
 * Highlights `code` to a `<pre class="shiki">…</pre>` HTML string. Resolves to
 * `null` when highlighting is unavailable or the language is plain text, so the
 * caller can render an unstyled `<pre>` fallback. `cache` is disabled while a
 * message is still streaming so we don't retain every intermediate token state.
 */
export async function highlightToHtml(
  code: string,
  rawLang: string | undefined,
  isDark: boolean,
  cache = true,
): Promise<string | null> {
  const lang = normalizeLanguage(rawLang);
  if (PLAIN_LANGS.has(lang) || code.length === 0) return null;

  const theme = isDark ? DARK_THEME : LIGHT_THEME;
  const key = `${theme}:${lang}:${code.length}:${code}`;
  if (cache) {
    const hit = cacheGet(key);
    if (hit !== undefined) return hit;
  }

  let highlighter: Highlighter;
  try {
    highlighter = await getHighlighter();
  } catch {
    return null;
  }

  const loaded = highlighter.getLoadedLanguages();
  const useLang = loaded.includes(lang) ? lang : 'text';
  if (useLang === 'text') return null;

  try {
    const html = highlighter.codeToHtml(code, { lang: useLang, theme });
    if (cache) cacheSet(key, html);
    return html;
  } catch {
    return null;
  }
}
