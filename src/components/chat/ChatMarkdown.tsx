/**
 * Renders assistant chat text as GitHub-flavored markdown, matching FCode's
 * `ChatMarkdown` look: prose spacing, inline-code chips, styled links, and code
 * blocks with a language header, copy + soft-wrap controls, and Shiki syntax
 * highlighting (with a graceful plain-text fallback). Trimmed of FCode's
 * workspace-only features (KaTeX math, thread markers, file-mention chips) that
 * don't apply to an SSH DevOps agent.
 */
import {
  Children,
  isValidElement,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useTheme } from 'next-themes';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { CheckIcon, CopyIcon, TextWrapIcon } from '@/lib/icons';
import { cn } from '@/lib/utils';
import { highlightToHtml, normalizeLanguage } from '@/lib/syntaxHighlighting';

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const EXTERNAL_HTTP_HREF_PATTERN = /^https?:\/\//i;

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];

function useIsDark(): boolean {
  const { resolvedTheme } = useTheme();
  if (resolvedTheme === 'dark') return true;
  if (resolvedTheme === 'light') return false;
  // Pre-hydration or "system" before it resolves: read the class the design
  // tokens key off directly so the first highlight uses the right theme.
  if (typeof document !== 'undefined') {
    return document.documentElement.classList.contains('dark');
  }
  return false;
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeToPlainText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return '';
}

function extractRawFenceInfo(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  return match?.[1] ?? 'text';
}

// A markdown `pre` wraps exactly one fenced `code` element. Pull the language
// class and raw text out of it; return null for anything else (defensive).
function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) return null;
  const onlyChild = childNodes[0];
  if (!isValidElement<{ className?: string; children?: ReactNode }>(onlyChild)) {
    return null;
  }
  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

function ShikiCodeBlock({
  code,
  language,
  isStreaming,
  isDark,
}: {
  code: string;
  language: string;
  isStreaming: boolean;
  isDark: boolean;
}) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Don't cache streaming intermediates; final messages cache normally.
    highlightToHtml(code, language, isDark, !isStreaming)
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [code, language, isDark, isStreaming]);

  if (html) {
    return (
      <div
        className="chat-markdown-shiki"
        // Shiki output is a sanitized `<pre class="shiki">` string.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  // Fallback before Shiki resolves, for plain-text fences, or on any failure.
  return (
    <pre className="chat-markdown-plain-code">
      <code>{code}</code>
    </pre>
  );
}

function MarkdownCodeBlock({
  code,
  language,
  isStreaming,
  isDark,
}: {
  code: string;
  language: string;
  isStreaming: boolean;
  isDark: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(() => {
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current != null) clearTimeout(copiedTimerRef.current);
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch(() => {});
  }, [code]);

  const toggleWrap = useCallback(() => setWrap((previous) => !previous), []);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  return (
    <div className="chat-markdown-codeblock" data-wrap={wrap ? 'true' : 'false'}>
      <div className="chat-markdown-codeblock__header">
        <span className="chat-markdown-codeblock__lang">{language}</span>
        <div className="chat-markdown-codeblock__actions">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="chat-markdown-codeblock__action"
            onClick={toggleWrap}
            title={wrap ? 'Disable soft wrap' : 'Enable soft wrap'}
            aria-label={wrap ? 'Disable soft wrap' : 'Enable soft wrap'}
            aria-pressed={wrap}
            data-active={wrap ? 'true' : 'false'}
          >
            <TextWrapIcon className="size-3" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="chat-markdown-codeblock__action"
            onClick={handleCopy}
            title={copied ? 'Copied' : 'Copy code'}
            aria-label={copied ? 'Copied' : 'Copy code'}
          >
            {copied ? (
              <CheckIcon className="size-3" />
            ) : (
              <CopyIcon className="size-3" />
            )}
          </Button>
        </div>
      </div>
      <div className="chat-markdown-codeblock__body">
        <ShikiCodeBlock
          code={code}
          language={language}
          isStreaming={isStreaming}
          isDark={isDark}
        />
      </div>
    </div>
  );
}

interface ChatMarkdownProps {
  text: string;
  isStreaming?: boolean;
  className?: string;
  style?: CSSProperties;
}

function ChatMarkdown({
  text,
  isStreaming = false,
  className = 'font-sans text-xs leading-relaxed',
  style,
}: ChatMarkdownProps) {
  const isDark = useIsDark();
  // While streaming, let React deprioritize and coalesce the markdown re-parse
  // so a fast token stream doesn't re-render the whole tree on every flush.
  const deferredText = useDeferredValue(text);
  const renderedText = isStreaming ? deferredText : text;

  const components = useMemo<Components>(
    () => ({
      pre({ children }) {
        const codeBlock = extractCodeBlock(children);
        if (!codeBlock) return <pre>{children}</pre>;
        const language = normalizeLanguage(
          extractRawFenceInfo(codeBlock.className),
        );
        return (
          <MarkdownCodeBlock
            code={codeBlock.code.replace(/\n$/, '')}
            language={language}
            isStreaming={isStreaming}
            isDark={isDark}
          />
        );
      },
      a({ href, children }) {
        const isExternal =
          typeof href === 'string' && EXTERNAL_HTTP_HREF_PATTERN.test(href);
        return (
          <a
            href={href}
            {...(isExternal
              ? { target: '_blank', rel: 'noopener noreferrer' }
              : {})}
          >
            {children}
          </a>
        );
      },
    }),
    [isDark, isStreaming],
  );

  return (
    <div
      className={cn('chat-markdown w-full min-w-0 text-foreground', className)}
      style={style}
    >
      <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} components={components}>
        {renderedText}
      </ReactMarkdown>
    </div>
  );
}

export default memo(ChatMarkdown);
