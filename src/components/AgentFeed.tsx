import { useEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import ChatMarkdown from '@/components/chat/ChatMarkdown';
import { BrailleSpinner } from '@/components/chat/RunningStatus';
import {
  CHAT_TRANSCRIPT_TEXT_CLASS_NAME,
  USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
  USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
} from '@/components/chat/chatTypography';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  CheckIcon,
  ChecklistIcon,
  ChevronRightIcon,
  ComposerSendArrowIcon,
  FileTextIcon,
  Loader2Icon,
  SparklesIcon,
  SquareIcon,
  TerminalIcon,
  XIcon,
} from '@/lib/icons';
import { WorldIcon } from '@/lib/brand-icons';
import { formatBytes } from '@/lib/attachments';
import { computeDnsRecordName } from '@/lib/dns';
import { cn, formatCount } from '@/lib/utils';
import type {
  FeedItem,
  PendingApproval,
  ToolFeedItem,
} from '@/hooks/useAgentRun';
import type {
  ChatAttachment,
  ChatFormHistoryItem,
  ChatReasoningHistoryItem,
  ChatTodoHistoryItem,
  DnsGuideConfig,
  FormField,
  TodoItem,
} from '@/shared/ipc-types';

export function AgentFeed({
  feed,
  error,
  approval,
  onApprove,
  onSubmitForm,
  running = false,
  tokens = 0,
  emptyMessage = "The agent's actions and replies will appear here.",
}: {
  feed: FeedItem[];
  error: string | null;
  approval: PendingApproval | null;
  onApprove: (approved: boolean) => void;
  /** Submit (values) or cancel (null) an in-chat form the agent requested. */
  onSubmitForm?: (formId: string, values: Record<string, string> | null) => void;
  running?: boolean;
  /** Token tally for the last run — rendered at the transcript's tail once the
   *  stream has ended (never while generating). */
  tokens?: number;
  emptyMessage?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // The indicator only belongs at the tail once the agent has started
  // replying with fresh text — a bare tool call already shows its own
  // "running" spinner, and a live thinking card shows one too, so doubling
  // up here would just be noise.
  const lastItem = feed[feed.length - 1];
  const showRunningRow =
    running &&
    (feed.length === 0 ||
      (lastItem?.kind !== 'reasoning' &&
        (lastItem?.kind !== 'tool' || lastItem.status !== 'running')));
  // The agent's live task list (there's only ever one). Pinned as an
  // always-visible summary above the transcript so its progress stays in view
  // while text and tool cards stream past below it — RooCode's "task header"
  // pattern, the fix for a checklist that would otherwise scroll off-screen.
  // Once every task is done the plan is finished, so the bar closes itself
  // rather than lingering as a "complete" banner.
  const todos = feed.find(
    (it): it is ChatTodoHistoryItem => it.kind === 'todos',
  )?.todos;
  const showTodoBar =
    !!todos && todos.length > 0 && !todos.every((t) => t.status === 'completed');
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [feed, error, showRunningRow]);

  return (
    <>
      {showTodoBar && <TodoStatusBar todos={todos} />}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto bg-background p-4"
      >
        {/* Same centered column width as the composer below, so message text
            and the input share one horizontal edge instead of the messages
            running full-width while the composer sits in a narrow column. */}
        <div className="mx-auto w-full max-w-[46rem] space-y-3">
        {feed.length === 0 && !running && (
          <p className="mx-auto max-w-sm pt-16 text-center text-xs leading-relaxed text-muted-foreground/70">
            {emptyMessage}
          </p>
        )}
        {feed.map((item, index) =>
          item.kind === 'text' ? (
            item.role === 'user' ? (
              <div key={item.id} className="flex w-full justify-end">
                <div className="group flex max-w-[80%] flex-col items-end gap-1.5">
                  {item.dispatchMode === 'steer' && (
                    <span className="flex items-center gap-1 text-[10px] font-medium text-skill">
                      <ComposerSendArrowIcon
                        aria-hidden
                        className="size-3 rotate-90"
                      />
                      Steering
                    </span>
                  )}
                  {item.attachments && item.attachments.length > 0 && (
                    <MessageAttachments attachments={item.attachments} />
                  )}
                  {item.content.trim() && (
                    <div
                      className={cn(
                        'w-max max-w-full min-w-0 self-end border border-border bg-[var(--app-user-message-background)]',
                        USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
                        USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
                      )}
                    >
                      <p className={cn('whitespace-pre-wrap', CHAT_TRANSCRIPT_TEXT_CLASS_NAME)}>
                        {item.content}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div key={item.id} className="flex w-full justify-start">
                <div className="min-w-0 max-w-[85%] py-0.5">
                  <ChatMarkdown
                    text={item.content}
                    isStreaming={running && index === feed.length - 1}
                  />
                </div>
              </div>
            )
          ) : item.kind === 'reasoning' ? (
            <ThinkingCard
              key={item.id}
              item={item}
              live={running && index === feed.length - 1}
            />
          ) : item.kind === 'todos' ? (
            // The task list renders once, in the pinned TodoStatusBar above —
            // no redundant inline card (RooCode dropped the repeated block too).
            null
          ) : item.kind === 'form' ? (
            <FormCard
              key={item.formId}
              item={item}
              onSubmit={onSubmitForm}
            />
          ) : (
            <ToolCard key={item.toolCallId} item={item} />
          ),
        )}
        {showRunningRow && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 py-0.5 text-xs"
          >
            <BrailleSpinner className="text-success" />
            <span className="font-medium text-ink">Running</span>
          </div>
        )}
        {/* Token tally appears only once the stream has ended (product
            decision: no live counter while generating) and stays at the tail
            of the transcript. */}
        {!running && tokens > 0 && feed.length > 0 && (
          <p
            className="pt-0.5 text-[11px] tabular-nums text-muted-foreground/60"
            title={`${tokens.toLocaleString()} tokens`}
          >
            {formatCount(tokens)} tokens
          </p>
        )}
        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
        </div>
      </div>

      <AlertDialog open={!!approval}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve command?</AlertDialogTitle>
            <AlertDialogDescription>{approval?.reason}</AlertDialogDescription>
          </AlertDialogHeader>
          <pre className="max-h-40 overflow-auto rounded-md bg-secondary p-3 font-mono text-xs text-ink">
            {approval?.command}
          </pre>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => onApprove(false)}>
              Reject
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => onApprove(true)}>
              Run it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

type TodoProgress = {
  done: number;
  total: number;
  active: TodoItem | undefined;
  allDone: boolean;
  pct: number;
};

function todoProgress(todos: TodoItem[]): TodoProgress {
  const done = todos.filter((t) => t.status === 'completed').length;
  const total = todos.length;
  return {
    done,
    total,
    active: todos.find((t) => t.status === 'in_progress'),
    allDone: total > 0 && done === total,
    pct: total > 0 ? Math.round((done / total) * 100) : 0,
  };
}

/** One checklist row: a status marker + the task text, Claude-Code style —
 *  completed is a green check with the text struck through, in-progress a
 *  spinner in bold, pending a hollow square (checkbox affordance; no bare
 *  status dots, per the product rule). The list carries a thin left rail so it
 *  reads as one grouped plan. */
function TodoRows({ todos }: { todos: TodoItem[] }) {
  return (
    <ol className="space-y-1 border-l border-border/60 pl-3">
      {todos.map((todo, i) => (
        <li key={i} className="flex items-start gap-2">
          <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
            {todo.status === 'completed' ? (
              <CheckIcon className="size-3.5 text-success" />
            ) : todo.status === 'in_progress' ? (
              <Loader2Icon className="size-3.5 animate-spin text-skill" />
            ) : (
              <SquareIcon className="size-3.5 text-muted-foreground/40" />
            )}
          </span>
          <span
            className={cn(
              'min-w-0 flex-1 text-xs leading-5',
              todo.status === 'completed'
                ? 'text-muted-foreground/50 line-through'
                : todo.status === 'in_progress'
                  ? 'font-medium text-ink'
                  : 'text-muted-foreground',
            )}
          >
            {todo.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Pinned task summary above the transcript (RooCode's "task header" pattern).
 * Stays visible while the conversation streams past below, so the user always
 * sees current progress + the task in flight without scrolling to find the
 * checklist. Click to expand the full list inline.
 */
function TodoStatusBar({ todos }: { todos: TodoItem[] }) {
  const [open, setOpen] = useState(false);
  const { done, total, active, allDone, pct } = todoProgress(todos);

  return (
    <div className="chat-surface-divider shrink-0 bg-background px-4 py-2">
      {/* Centered to the same column as the messages + composer. */}
      <div className="mx-auto w-full max-w-[46rem]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
        aria-expanded={open}
        title={open ? 'Hide task list' : 'Show task list'}
      >
        <ChecklistIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-xs font-medium text-ink">Tasks</span>
        <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground/70">
          {done}/{total}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {allDone ? (
            <span className="truncate text-[11px] font-medium text-success">
              All tasks complete
            </span>
          ) : active ? (
            <>
              <Loader2Icon
                aria-hidden
                className="size-3 shrink-0 animate-spin text-skill"
              />
              <span className="truncate text-[11px] text-muted-foreground">
                {active.text}
              </span>
            </>
          ) : (
            <span className="truncate text-[11px] text-muted-foreground/70">
              {total === 0 ? 'No tasks yet' : 'Planning…'}
            </span>
          )}
        </span>
        <ChevronRightIcon
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-200',
            open && 'rotate-90',
          )}
        />
      </button>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-300',
            allDone ? 'bg-success' : 'bg-skill',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      {open && (
        <div className="mt-2.5">
          <TodoRows todos={todos} />
        </div>
      )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attachments the user sent with a message (image thumbnails + file chips).
// ---------------------------------------------------------------------------

function MessageAttachments({ attachments }: { attachments: ChatAttachment[] }) {
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {attachments.map((att) =>
        att.kind === 'image' && att.dataUrl ? (
          <a
            key={att.id}
            href={att.dataUrl}
            target="_blank"
            rel="noreferrer"
            title={att.name}
            className="block overflow-hidden rounded-lg border border-border"
          >
            <img
              src={att.dataUrl}
              alt={att.name}
              className="max-h-40 max-w-[12rem] object-cover"
            />
          </a>
        ) : (
          <span
            key={att.id}
            title={`${att.name} · ${formatBytes(att.size)}`}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-secondary/50 px-2 py-1"
          >
            <FileTextIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="max-w-[11rem] truncate text-[11px] font-medium text-ink">
              {att.name}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {formatBytes(att.size)}
            </span>
          </span>
        ),
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent-requested form (generative UI) — the agent renders a form in the chat
// and the run pauses until the user submits or cancels it.
// ---------------------------------------------------------------------------

function fieldInitial(field: FormField): string {
  if (field.defaultValue != null) return field.defaultValue;
  return field.type === 'toggle' ? 'false' : '';
}

function FormCard({
  item,
  onSubmit,
}: {
  item: ChatFormHistoryItem;
  onSubmit?: (formId: string, values: Record<string, string> | null) => void;
}) {
  const pending = item.status === 'pending';
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(item.fields.map((f) => [f.key, fieldInitial(f)])),
  );
  const set = (key: string, v: string) =>
    setValues((prev) => ({ ...prev, [key]: v }));

  const missingRequired = item.fields
    .filter((f) => f.required)
    .some((f) => !String(values[f.key] ?? '').trim());

  // Once settled, show what the user entered (or that they cancelled) rather
  // than the live inputs — a read-only record in the transcript.
  const shown = pending ? values : item.values ?? values;

  return (
    <div className="surface-panel min-w-0 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border/60 px-3.5 py-2.5">
        <span className="skill-chip flex size-6 shrink-0 items-center justify-center rounded-full">
          <WorldIcon aria-hidden className="size-3.5 text-skill" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-ink">{item.title}</p>
          {item.description && (
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
              {item.description}
            </p>
          )}
        </div>
        {item.status === 'submitted' && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">
            <CheckIcon aria-hidden className="size-3" /> Submitted
          </span>
        )}
        {item.status === 'cancelled' && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            <XIcon aria-hidden className="size-3" /> Cancelled
          </span>
        )}
      </div>

      <div className="space-y-3 px-3.5 py-3">
        {item.fields.map((field) => (
          <FormFieldRow
            key={field.key}
            field={field}
            value={String(shown[field.key] ?? '')}
            disabled={!pending}
            onChange={(v) => set(field.key, v)}
          />
        ))}
      </div>

      {item.dnsGuide && (
        <DnsGuidePanel
          guide={item.dnsGuide}
          domain={String(shown[item.dnsGuide.domainField ?? 'domain'] ?? '')}
          www={String(shown[item.dnsGuide.wwwField ?? 'www'] ?? '') === 'true'}
        />
      )}

      {pending && (
        <div className="flex items-center justify-end gap-2 border-t border-border/60 px-3.5 py-2.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => onSubmit?.(item.formId, null)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={missingRequired || !onSubmit}
            onClick={() => onSubmit?.(item.formId, values)}
          >
            {item.submitLabel ?? 'Submit'}
          </Button>
        </div>
      )}
    </div>
  );
}

function FormFieldRow({
  field,
  value,
  disabled,
  onChange,
}: {
  field: FormField;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  if (field.type === 'toggle') {
    return (
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Label className="text-xs font-medium text-ink">{field.label}</Label>
          {field.help && (
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
              {field.help}
            </p>
          )}
        </div>
        <Switch
          checked={value === 'true'}
          disabled={disabled}
          onCheckedChange={(c) => onChange(c ? 'true' : 'false')}
          className="mt-0.5 shrink-0"
        />
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Label className="text-xs font-medium text-ink">
        {field.label}
        {field.required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      {field.type === 'select' ? (
        <Select value={value} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger size="sm" className="w-full">
            <SelectValue placeholder={field.placeholder ?? 'Choose…'} />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          type={
            field.type === 'number'
              ? 'number'
              : field.type === 'password'
                ? 'password'
                : 'text'
          }
          inputMode={field.type === 'number' ? 'numeric' : undefined}
          autoComplete={field.type === 'password' ? 'off' : undefined}
          value={value}
          disabled={disabled}
          placeholder={field.placeholder}
          spellCheck={false}
          className="h-8 text-xs"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.help && (
        <p className="text-[11px] leading-snug text-muted-foreground">
          {field.help}
        </p>
      )}
    </div>
  );
}

/**
 * In-form DNS setup guide: shows the exact A-record to add at the user's domain
 * registrar, updating live as they type the domain (record NAME) — plus the
 * follow-the-dots steps. This is the "how do I point my domain here" help,
 * right where they set it up.
 */
function DnsGuidePanel({
  guide,
  domain,
  www,
}: {
  guide: DnsGuideConfig;
  domain: string;
  www: boolean;
}) {
  const ip = guide.serverIp?.trim() || 'your server’s public IP';
  const { name } = computeDnsRecordName(domain);
  const rows: { name: string }[] = [{ name }];
  if (www) rows.push({ name: name === '@' ? 'www' : `www.${name}` });

  return (
    <div className="mx-3.5 mb-3 rounded-lg border border-border bg-secondary/30 p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <WorldIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <p className="text-[11px] font-semibold tracking-[-0.01em] text-ink">
          Point your domain here — add this DNS record
        </p>
      </div>
      <p className="mb-2 text-[11px] leading-snug text-muted-foreground">
        At your domain provider (GoDaddy, Namecheap, Cloudflare, Google
        Domains…), open the DNS settings and add:
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[24rem] border-collapse text-[11px]">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="px-2 py-1 font-medium">Type</th>
              <th className="px-2 py-1 font-medium">Name / Host</th>
              <th className="px-2 py-1 font-medium">Value / Points to</th>
              <th className="px-2 py-1 font-medium">TTL</th>
            </tr>
          </thead>
          <tbody className="font-mono text-ink">
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-border/60">
                <td className="px-2 py-1">A</td>
                <td className="px-2 py-1">{r.name}</td>
                <td className="px-2 py-1 text-skill">{ip}</td>
                <td className="px-2 py-1">3600</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ol className="mt-2.5 list-decimal space-y-0.5 pl-4 text-[11px] leading-snug text-muted-foreground">
        <li>Log in to your domain provider and open its DNS settings.</li>
        <li>
          Add the <span className="font-medium text-ink">A record</span> above,
          then save.
        </li>
        <li>
          Changes usually apply within a few minutes (occasionally up to an
          hour). On Cloudflare, set the record to <b>DNS only</b> (grey cloud)
          first.
        </li>
      </ol>
    </div>
  );
}

/**
 * The model's thinking stream, Codex / Claude Code style: a quiet muted
 * "Thinking" row (same borderless language as ToolCard) that stays expanded
 * while the reasoning streams in and folds itself away once the model starts
 * answering — the user can reopen it any time, including from a saved
 * transcript. The body renders dimmed markdown behind a thin left rail so it
 * reads as an aside, never competing with the real reply.
 */
function ThinkingCard({
  item,
  live,
}: {
  item: ChatReasoningHistoryItem;
  live: boolean;
}) {
  const [open, setOpen] = useState(live);
  const userToggledRef = useRef(false);
  // Follow the stream (open while thinking, collapse when done) only until the
  // user takes over the disclosure themselves.
  useEffect(() => {
    if (!userToggledRef.current) setOpen(live);
  }, [live]);

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => {
          userToggledRef.current = true;
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-secondary"
        title={open ? 'Hide thinking' : 'Show thinking'}
      >
        <span
          className={cn(
            'flex size-5 shrink-0 items-center justify-center',
            live ? 'text-skill' : 'text-muted-foreground/50',
          )}
        >
          {live ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <SparklesIcon className="size-4" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs leading-6 text-muted-foreground/80">
          {live ? 'Thinking…' : 'Thought process'}
        </span>
        <ChevronRightIcon
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground/40 transition-transform duration-200',
            open && 'rotate-90',
          )}
        />
      </button>
      {open && (
        <div className="mt-1.5 ml-7 border-l border-border/60 pl-3">
          <ChatMarkdown
            text={item.content}
            isStreaming={live}
            className="font-sans text-xs leading-relaxed text-muted-foreground/80 [&_a]:text-muted-foreground [&_code]:text-muted-foreground [&_h1]:text-muted-foreground [&_h2]:text-muted-foreground [&_h3]:text-muted-foreground [&_h4]:text-muted-foreground [&_li]:text-muted-foreground/80 [&_p]:text-muted-foreground/80 [&_strong]:text-muted-foreground"
          />
        </div>
      )}
    </div>
  );
}

function ToolCard({ item }: { item: ToolFeedItem }) {
  const failed =
    item.status === 'done' &&
    item.exitCode !== null &&
    item.exitCode !== undefined &&
    item.exitCode !== 0;
  const label = item.description || item.command || item.tool;
  const hasDetails = Boolean(item.command || item.output);

  // Mirrors FCode's borderless tool row (SimpleWorkEntryRow / ToolDetailsDisclosure):
  // a quiet, muted line that highlights on hover and expands inline + indented,
  // rather than a heavy bordered card.
  return (
    <details className="group/tool min-w-0">
      <summary
        className={cn(
          'flex w-full list-none items-center gap-2 rounded-md px-2 py-1.5 text-left [&::-webkit-details-marker]:hidden',
          hasDetails
            ? 'cursor-pointer transition-colors hover:bg-secondary'
            : 'cursor-default',
        )}
        title={item.command || label}
      >
        <span
          className={cn(
            'flex size-5 shrink-0 items-center justify-center',
            item.status === 'running'
              ? 'text-skill'
              : failed
                ? 'text-destructive'
                : 'text-muted-foreground/50',
          )}
        >
          {item.status === 'running' ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <TerminalIcon className="size-4" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs leading-6 text-muted-foreground/80">
          {label}
        </span>
        {failed && (
          <span className="shrink-0 rounded-full bg-destructive/12 px-1.5 py-0.5 text-[10px] tabular-nums text-destructive">
            exit {item.exitCode}
          </span>
        )}
        {hasDetails && (
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground/40 transition-transform duration-200 group-open/tool:rotate-90"
          />
        )}
      </summary>
      {hasDetails && (
        <div className="mt-1.5 ml-7 space-y-2">
          {item.command && (
            <pre className="overflow-x-auto rounded-md bg-secondary px-2 py-1.5 font-mono text-xs text-ink">
              $ {item.command}
            </pre>
          )}
          {item.output && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-secondary/60 px-2 py-1.5 font-mono text-xs text-muted-foreground">
              {item.output}
            </pre>
          )}
        </div>
      )}
    </details>
  );
}
