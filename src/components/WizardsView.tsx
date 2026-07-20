import { useEffect, useMemo, useRef, useState } from 'react';
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
import { SidebarGlyph } from '@/components/sidebarGlyphs';
import { useAgentRun } from '@/hooks/useAgentRun';
import { useServers } from '@/hooks/useServers';
import {
  ArchiveIcon,
  DB_ENGINE_GLYPHS,
  DatabaseIcon,
  WorldIcon,
  optionGlyph,
} from '@/lib/brand-icons';
import {
  CHAT_HISTORY_UPDATED_EVENT,
  SESSION_STATUS_META,
  WIZARD_LAUNCH_EVENT,
  WIZARD_SESSION_SWITCH_EVENT,
  markInterruptedToolsDone,
  newChatSessionId,
  type WizardLaunchDetail,
} from '@/lib/chatHistory';
import { publishRunStatus } from '@/lib/runStatus';
import {
  ArrowLeftIcon,
  CheckIcon,
  CircleCheckFilledIcon,
  ChevronRightIcon,
  CopyIcon,
  DeviceLaptopIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  Loader2Icon,
  PackageIcon,
  PlayIcon,
  WifiIcon,
  WizardsIcon,
  XIcon,
  type AppIcon,
} from '@/lib/icons';
import { cn } from '@/lib/utils';
import {
  buildDeployTranscript,
  TEMPLATE_DEPLOY_STEPS,
} from '@/lib/templateDeployTranscript';
import type {
  ChatHistoryState,
  ChatSession,
  ChatSessionStatus,
  ChatTextHistoryItem,
  PlaybookInput,
  PlaybookMeta,
  TemplateDeployStepId,
  TemplateDeployStepStatus,
  TemplateDeploySummary,
  TemplateMeta,
} from '@/shared/ipc-types';

const FIELD_LABEL_CLASS =
  'text-[11px] font-medium tracking-[-0.015em] text-muted-foreground';
const SECTION_LABEL_CLASS =
  'mb-3 text-xs font-semibold tracking-[-0.015em] text-ink';
const FIELD_CONTROL_CLASS =
  'w-full border-border bg-secondary shadow-none hover:bg-accent focus-visible:border-foreground/30 dark:bg-secondary dark:hover:bg-accent';
const TEMPLATE_PAGE_SIZE = 15;

function paginationPages(page: number, totalPages: number): Array<number | string> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }
  const pages: Array<number | string> = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(totalPages - 1, page + 1);
  if (start > 2) pages.push('ellipsis-start');
  for (let item = start; item <= end; item += 1) pages.push(item);
  if (end < totalPages - 1) pages.push('ellipsis-end');
  pages.push(totalPages);
  return pages;
}

/** Per-wizard glyph so each card reads at a glance; falls back to the generic tool icon. */
const PLAYBOOK_GLYPHS: Record<string, AppIcon> = {
  'host-website': WorldIcon,
  'setup-database': DatabaseIcon,
  'enable-db-remote-access': WifiIcon,
  'setup-backups': ArchiveIcon,
};

function playbookGlyph(id: string): AppIcon {
  return PLAYBOOK_GLYPHS[id] ?? WizardsIcon;
}

/** History sessions for template deploys are keyed like playbooks, with this
 *  prefix so the two id spaces can't collide. */
const TEMPLATE_PLAYBOOK_PREFIX = 'template:';

/** A template deploy reuses the whole wizard run screen; this pseudo playbook
 *  is what stands in for it (no inputs — everything is auto-generated). */
function templateAsPlaybook(t: TemplateMeta): PlaybookMeta {
  return {
    id: `${TEMPLATE_PLAYBOOK_PREFIX}${t.id}`,
    title: t.name,
    description: t.description,
    inputs: [],
  };
}

/** Renderer-side mirror of one deterministic deploy (live or just finished). */
type ActiveDeploy = {
  deployId: string;
  sessionId: string;
  template: TemplateMeta;
  serverId: string;
  serverName: string;
  createdAt: number;
  steps: Partial<
    Record<TemplateDeployStepId, { status: TemplateDeployStepStatus; detail?: string }>
  >;
  log: string[];
  summary: TemplateDeploySummary | null;
  error: string | null;
  status: ChatSessionStatus;
};

function deployAsHistoryItems(deploy: ActiveDeploy): ChatTextHistoryItem[] {
  return [
    {
      kind: 'text',
      id: `${deploy.deployId}-echo`,
      role: 'user',
      content: `Deploy app template "${deploy.template.name}" (${deploy.template.version}) on ${deploy.serverName}.`,
    },
    {
      kind: 'text',
      id: `${deploy.deployId}-report`,
      role: 'assistant',
      content: buildDeployTranscript(deploy),
    },
  ];
}

/** Registry-hosted brand mark in a consistent neutral frame. A real package
 *  glyph replaces broken images without pretending to be the app's logo. */
function TemplateLogo({
  template,
  className,
}: {
  template: TemplateMeta;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-border/70 bg-white p-1.5 dark:border-white/10',
        className,
      )}
      aria-hidden="true"
    >
      {template.logoUrl && !failed ? (
        <img
          src={template.logoUrl}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className="size-full object-contain"
        />
      ) : (
        <PackageIcon className="size-[58%] text-muted-foreground/70" />
      )}
    </span>
  );
}

/** Brand-mark strip shown on the database wizard card. */
function EngineIconRow() {
  return (
    <span className="flex items-center gap-2.5">
      {Object.entries(DB_ENGINE_GLYPHS).map(([name, glyph]) => (
        <glyph.icon
          key={name}
          className="size-[15px] shrink-0 opacity-90"
          style={{ color: glyph.color }}
          aria-label={name}
        />
      ))}
    </span>
  );
}

/** Metadata of the wizard run the live feed currently belongs to, frozen at
 *  start time so late events and saves always land in the right session. */
type ActiveWizardRun = {
  sessionId: string;
  playbook: PlaybookMeta;
  serverId: string;
  createdAt: number;
};

export function WizardsView() {
  const { servers } = useServers();
  const [playbooks, setPlaybooks] = useState<PlaybookMeta[]>([]);
  const [selected, setSelected] = useState<PlaybookMeta | null>(null);
  // Set when `selected` is a template deploy (drives the info panel + logo).
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateMeta | null>(
    null,
  );
  const [templates, setTemplates] = useState<TemplateMeta[]>([]);
  const [templateQuery, setTemplateQuery] = useState('');
  const [templateSearch, setTemplateSearch] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [templatePage, setTemplatePage] = useState(1);
  const [templateTotal, setTemplateTotal] = useState(0);
  const [templateTotalPages, setTemplateTotalPages] = useState(1);
  const [topTags, setTopTags] = useState<string[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [templateRefresh, setTemplateRefresh] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [serverId, setServerId] = useState<string>('');
  // The run whose transcript is (or was) streaming into the feed. Stays set
  // after the run finishes so the final status can be shown and persisted.
  const [activeRun, setActiveRun] = useState<ActiveWizardRun | null>(null);
  // Status of a *saved* run loaded from History (read-only view).
  const [loadedStatus, setLoadedStatus] = useState<ChatSessionStatus | null>(null);
  // All persisted wizard runs — drives the status badge on each picker card.
  const [wizardSessions, setWizardSessions] = useState<ChatSession[]>([]);
  // Which saved session the feed is showing (the active run's, or a loaded one).
  const sessionIdRef = useRef<string | null>(null);
  const pendingSessionRef = useRef<ChatSession | null>(null);
  const firstPendingAtRef = useRef<number | null>(null);
  const {
    feed,
    running,
    tokens,
    error,
    outcome,
    approval,
    start,
    cancel,
    respondApproval,
    respondForm,
    clear,
    replaceFeed,
  } = useAgentRun();
  const feedRef = useRef(feed);
  feedRef.current = feed;
  const activeRunRef = useRef(activeRun);
  activeRunRef.current = activeRun;
  // Deterministic template deploy (Dokploy-style; no agent run involved).
  const [deploy, setDeploy] = useState<ActiveDeploy | null>(null);
  const deployRef = useRef(deploy);
  deployRef.current = deploy;
  const deploying = deploy?.status === 'running';

  useEffect(() => {
    window.easyhost.playbooks.list().then(setPlaybooks).catch(() => {});
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setTemplateSearch(templateQuery.trim()),
      220,
    );
    return () => window.clearTimeout(timeout);
  }, [templateQuery]);

  useEffect(() => {
    let disposed = false;
    setTemplatesLoading(true);
    setTemplatesError(null);
    window.easyhost.templates
      .list({
        page: templatePage,
        pageSize: TEMPLATE_PAGE_SIZE,
        query: templateSearch || undefined,
        tag: activeTag ?? undefined,
      })
      .then((result) => {
        if (disposed) return;
        setTemplates(result.items);
        setTemplatePage(result.page);
        setTemplateTotal(result.total);
        setTemplateTotalPages(result.totalPages);
        setTopTags(result.tags);
      })
      .catch((err: unknown) => {
        if (disposed) return;
        setTemplatesError(
          err instanceof Error ? err.message : 'Could not load templates.',
        );
      })
      .finally(() => {
        if (!disposed) setTemplatesLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [templatePage, templateSearch, activeTag, templateRefresh]);

  // Keep the sidebar's "Wizards" running indicator in sync from any screen.
  useEffect(() => {
    publishRunStatus('wizard', running || deploying);
  }, [running, deploying]);

  // Stream of deterministic-deploy progress from main. Every state change is
  // also persisted so History always has the run, even after a crash.
  useEffect(() => {
    const unsubscribe = window.easyhost.templates.onDeployEvent((event) => {
      const current = deployRef.current;
      if (!current || event.deployId !== current.deployId) return;
      setDeploy((prev) => {
        if (!prev || event.deployId !== prev.deployId) return prev;
        let next: ActiveDeploy = prev;
        if (event.type === 'step') {
          next = {
            ...prev,
            steps: {
              ...prev.steps,
              [event.step]: { status: event.status, detail: event.detail },
            },
          };
        } else if (event.type === 'log') {
          next = { ...prev, log: [...prev.log, event.text].slice(-500) };
        } else if (event.type === 'done') {
          next = { ...prev, summary: event.summary, status: 'done' };
        } else if (event.type === 'error') {
          next = { ...prev, error: event.error, status: 'error' };
        } else if (event.type === 'cancelled') {
          next = { ...prev, status: 'cancelled' };
        }
        if (event.type !== 'log') persistDeploy(next);
        return next;
      });
    });
    return unsubscribe;
  }, []);

  function persistDeploy(d: ActiveDeploy) {
    void window.easyhost.chatHistory
      .upsert({
        id: d.sessionId,
        kind: 'wizard',
        title: d.template.name,
        playbookId: `${TEMPLATE_PLAYBOOK_PREFIX}${d.template.id}`,
        status: d.status,
        items: deployAsHistoryItems(d),
        targetServerId: d.serverId,
        createdAt: d.createdAt,
        updatedAt: Date.now(),
      })
      .then(broadcastHistory)
      .catch(() => {});
  }

  // Mirror the persisted wizard runs (this window's saves included) so cards
  // and the header can show last-run outcomes, surviving app restarts.
  useEffect(() => {
    let disposed = false;
    const apply = (state: ChatHistoryState) => {
      if (disposed) return;
      setWizardSessions(state.sessions.filter((s) => s.kind === 'wizard'));
    };
    window.easyhost.chatHistory.list().then(apply).catch(() => {});
    const unsubscribe = window.easyhost.chatHistory.onChanged(apply);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const latestRunByPlaybook = useMemo(() => {
    const map = new Map<string, ChatSession>();
    for (const session of wizardSessions) {
      if (!session.playbookId) continue;
      const prev = map.get(session.playbookId);
      if (!prev || session.updatedAt > prev.updatedAt) {
        map.set(session.playbookId, session);
      }
    }
    return map;
  }, [wizardSessions]);

  const buildRunSession = (
    run: ActiveWizardRun,
    status: ChatSessionStatus,
    items: typeof feed,
  ): ChatSession => ({
    id: run.sessionId,
    kind: 'wizard',
    title: run.playbook.title,
    playbookId: run.playbook.id,
    status,
    items,
    targetServerId: run.serverId,
    createdAt: run.createdAt,
    updatedAt: Date.now(),
  });

  const broadcastHistory = (saved: ChatHistoryState) => {
    window.dispatchEvent(
      new CustomEvent(CHAT_HISTORY_UPDATED_EVENT, { detail: saved }),
    );
  };

  /** Immediate save for the moment a run is abandoned (switch/cancel paths). */
  const persistRunNow = (status: ChatSessionStatus) => {
    const run = activeRunRef.current;
    const items = feedRef.current;
    if (!run || items.length === 0) return;
    firstPendingAtRef.current = null;
    pendingSessionRef.current = null;
    void window.easyhost.chatHistory
      .upsert(buildRunSession(run, status, items))
      .then(broadcastHistory);
  };

  // Persist the live run's transcript + status as it streams. Debounced like
  // the chat panel, with a 1s max-wait so a busy stream can't starve saves,
  // and an immediate flush once the run settles.
  useEffect(() => {
    if (!activeRun || sessionIdRef.current !== activeRun.sessionId) return;
    if (feed.length === 0) return;
    const status: ChatSessionStatus = running ? 'running' : outcome ?? 'running';
    const session = buildRunSession(activeRun, status, feed);
    pendingSessionRef.current = session;
    if (firstPendingAtRef.current === null) {
      firstPendingAtRef.current = Date.now();
    }
    const overdue = Date.now() - firstPendingAtRef.current >= 1000;
    const timeout = window.setTimeout(
      () => {
        firstPendingAtRef.current = null;
        pendingSessionRef.current = null;
        void window.easyhost.chatHistory.upsert(session).then(broadcastHistory);
      },
      overdue || !running ? 0 : 250,
    );
    return () => window.clearTimeout(timeout);
  }, [feed, running, outcome, activeRun]);

  // Flush any pending save on app quit / unmount so a run's tail end and its
  // final status are never lost.
  useEffect(() => {
    const flush = () => {
      const pending = pendingSessionRef.current;
      if (pending) {
        pendingSessionRef.current = null;
        firstPendingAtRef.current = null;
        void window.easyhost.chatHistory.upsert(pending);
      }
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  /** Open a saved wizard run's transcript (read-only; nothing is re-run). */
  async function loadSavedRun(session: ChatSession) {
    const templateId = session.playbookId?.startsWith(TEMPLATE_PLAYBOOK_PREFIX)
      ? session.playbookId.slice(TEMPLATE_PLAYBOOK_PREFIX.length)
      : null;
    let template = templateId
      ? templates.find((item) => item.id === templateId) ?? null
      : null;
    if (templateId && !template) {
      template = await window.easyhost.templates
        .list({ templateId, pageSize: 1 })
        .then((result) => result.items[0] ?? null)
        .catch((): null => null);
    }
    const playbook =
      (template && templateAsPlaybook(template)) ??
      playbooks.find((p) => p.id === session.playbookId) ??
      ({
        id: session.playbookId ?? 'unknown',
        title: session.title ?? 'Wizard run',
        description: 'Saved wizard run',
        inputs: [],
      } satisfies PlaybookMeta);
    setSelectedTemplate(template);
    setSelected(playbook);
    setValues({});
    setActiveRun(null);
    setLoadedStatus(
      session.status === 'running' ? 'interrupted' : session.status ?? null,
    );
    sessionIdRef.current = session.id;
    if (session.targetServerId) setServerId(session.targetServerId);
    replaceFeed(markInterruptedToolsDone(session.items));
  }

  // The sidebar dispatches this when a saved wizard run is picked in History.
  useEffect(() => {
    const handleSwitch = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (!id) return;
      if (id === sessionIdRef.current) {
        // Already showing this run (it may still be streaming) — just make
        // sure its playbook screen is open.
        const run = activeRunRef.current;
        if (run) setSelected(run.playbook);
        return;
      }
      if (running) {
        void cancel();
        persistRunNow('cancelled');
      }
      clear();
      setActiveRun(null);
      void window.easyhost.chatHistory.list().then((state) => {
        const session = state.sessions.find(
          (s) => s.id === id && s.kind === 'wizard',
        );
        if (session) void loadSavedRun(session);
      });
    };
    window.addEventListener(WIZARD_SESSION_SWITCH_EVENT, handleSwitch);
    return () =>
      window.removeEventListener(WIZARD_SESSION_SWITCH_EVENT, handleSwitch);
  }, [running, playbooks]);

  // The Artifacts tab dispatches this to jump straight into a wizard with a
  // specific server + fields already filled in (e.g. "Allow remote access"
  // for one particular database), skipping the picker.
  useEffect(() => {
    const handleLaunch = (event: Event) => {
      const detail = (event as CustomEvent<WizardLaunchDetail>).detail;
      if (!detail) return;
      const pb = playbooks.find((p) => p.id === detail.playbookId);
      if (!pb) return;
      if (running) {
        void cancel();
        persistRunNow('cancelled');
      }
      setSelected(pb);
      setSelectedTemplate(null);
      setValues(detail.values);
      setServerId(detail.serverId);
      setActiveRun(null);
      clear();
      sessionIdRef.current = null;
      setLoadedStatus(null);
    };
    window.addEventListener(WIZARD_LAUNCH_EVENT, handleLaunch);
    return () => window.removeEventListener(WIZARD_LAUNCH_EVENT, handleLaunch);
  }, [running, playbooks]);

  function choose(pb: PlaybookMeta, template: TemplateMeta | null = null) {
    // Re-opening the playbook whose run is still streaming: reattach to the
    // live feed instead of resetting anything.
    if (running && activeRun?.playbook.id === pb.id) {
      setSelected(pb);
      setSelectedTemplate(template);
      return;
    }
    if (running) {
      // A different wizard was picked mid-run: stop the old run and keep its
      // transcript in History marked as stopped.
      void cancel();
      persistRunNow('cancelled');
    }
    setSelected(pb);
    setSelectedTemplate(template);
    setValues({});
    setActiveRun(null);
    clear();
    // Show the playbook's most recent saved run so "what happened last time"
    // is one click away; otherwise start with an empty feed.
    const last = latestRunByPlaybook.get(pb.id);
    if (last) {
      sessionIdRef.current = last.id;
      setLoadedStatus(
        last.status === 'running' ? 'interrupted' : last.status ?? null,
      );
      replaceFeed(markInterruptedToolsDone(last.items));
      if (last.targetServerId) {
        setServerId(last.targetServerId);
        return;
      }
    } else {
      sessionIdRef.current = null;
      setLoadedStatus(null);
    }
    if (servers[0]) setServerId(servers[0].id);
  }

  const requiredMissing =
    selected?.inputs.some((i) => i.required && !values[i.key]?.trim()) ?? false;

  async function run() {
    if (
      !selected ||
      !serverId ||
      running ||
      deployRef.current?.status === 'running'
    ) {
      return;
    }
    const serverName =
      servers.find((s) => s.id === serverId)?.name ?? 'the target server';
    if (selectedTemplate) {
      // Dokploy-style deterministic deploy — main drives the whole pipeline;
      // no agent run is started.
      const sessionId = newChatSessionId();
      sessionIdRef.current = sessionId;
      setActiveRun(null);
      setLoadedStatus(null);
      replaceFeed([]);
      const deployId = `template_${crypto.randomUUID()}`;
      const fresh: ActiveDeploy = {
        deployId,
        sessionId,
        template: selectedTemplate,
        serverId,
        serverName,
        createdAt: Date.now(),
        steps: {},
        log: [],
        summary: null,
        error: null,
        status: 'running',
      };
      // Set the ref before invoking main: the deploy emits its first progress
      // event synchronously, before React could commit a state update.
      deployRef.current = fresh;
      setDeploy(fresh);
      persistDeploy(fresh);
      try {
        await window.easyhost.templates.deploy(
          deployId,
          serverId,
          selectedTemplate.id,
        );
      } catch (err) {
        const failed: ActiveDeploy = {
          ...fresh,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        };
        deployRef.current = failed;
        setDeploy(failed);
        persistDeploy(failed);
      }
      return;
    }
    const runMeta: ActiveWizardRun = {
      sessionId: newChatSessionId(),
      playbook: selected,
      serverId,
      createdAt: Date.now(),
    };
    sessionIdRef.current = runMeta.sessionId;
    setActiveRun(runMeta);
    setLoadedStatus(null);
    replaceFeed([]);
    await start(
      {
        messages: [],
        serverIds: [serverId],
        playbookId: selected.id,
        playbookValues: values,
      },
      buildRunEcho(selected, values, serverName),
    );
  }

  /** The deterministic deploy the open template screen should show live: the
   *  session on screen is the deploy's own. A deploy keeps running in main
   *  even when the user navigates away; this only controls what's rendered. */
  const activeTemplateDeploy =
    selectedTemplate &&
    deploy &&
    deploy.template.id === selectedTemplate.id &&
    sessionIdRef.current === deploy.sessionId
      ? deploy
      : null;

  /** Live status of what the feed is showing (running run, finished run, or a
   *  transcript loaded from History). */
  const feedStatus: ChatSessionStatus | null = activeTemplateDeploy
    ? activeTemplateDeploy.status
    : running
      ? 'running'
      : activeRun
        ? outcome ?? null
        : loadedStatus;

  if (!selected) {
    return (
      <div className="h-full overflow-y-auto bg-background p-6">
        <div className="mx-auto max-w-5xl">
          <header className="mb-6">
            <div className="flex items-center gap-2.5">
              <span className="skill-chip flex size-6 items-center justify-center rounded-full">
                <SidebarGlyph icon={WizardsIcon} variant="chrome" />
              </span>
              <div>
                <h1 className="text-sm font-semibold tracking-[-0.015em] text-ink">
                  Wizards
                </h1>
                <p className="text-[11px] text-muted-foreground">
                  Guided setups — fill in a few fields and the agent handles the
                  rest.
                </p>
              </div>
            </div>
          </header>

          <h2 className={SECTION_LABEL_CLASS}>Server tasks</h2>
          <div className="mb-8 grid gap-3 sm:grid-cols-2">
            {playbooks.map((pb) => {
              const cardStatus: ChatSessionStatus | undefined =
                running && activeRun?.playbook.id === pb.id
                  ? 'running'
                  : latestRunByPlaybook.get(pb.id)?.status;
              return (
                <button
                  key={pb.id}
                  onClick={() => choose(pb)}
                  className="surface-panel group p-4 text-left transition-colors hover:border-skill/35"
                >
                  <div className="mb-3 flex items-center justify-between">
                    <span className="skill-chip flex size-7 items-center justify-center rounded-lg">
                      <SidebarGlyph icon={playbookGlyph(pb.id)} variant="leading" />
                    </span>
                    {pb.id === 'setup-database' && <EngineIconRow />}
                  </div>
                  <h3 className="text-[13px] font-semibold tracking-[-0.015em] text-ink">
                    {pb.title}
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {pb.description}
                  </p>
                  {cardStatus && (
                    <p className="mt-2">
                      <SessionStatusChip
                        status={cardStatus}
                        prefix={cardStatus === 'running' ? undefined : 'Last run: '}
                      />
                    </p>
                  )}
                </button>
              );
            })}
          </div>

          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className={cn(SECTION_LABEL_CLASS, 'mb-0')}>
                Deploy an open-source app
              </h2>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                One-click Docker Compose deploys, run directly by the app —
                passwords and hostnames are generated for you.
              </p>
            </div>
            <Input
              value={templateQuery}
              onChange={(e) => {
                setTemplateQuery(e.target.value);
                setTemplatePage(1);
              }}
              placeholder="Search templates…"
              aria-label="Search app templates"
              className={cn(FIELD_CONTROL_CLASS, 'h-8 w-full max-w-60 sm:w-60')}
            />
          </div>

          {topTags.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-1.5">
              {topTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => {
                    setActiveTag(activeTag === tag ? null : tag);
                    setTemplatePage(1);
                  }}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                    activeTag === tag
                      ? 'border-skill/45 bg-skill/10 text-ink'
                      : 'border-border bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}

          {templatesError ? (
            <div className="surface-panel flex items-center justify-between gap-4 p-4">
              <div>
                <p className="text-xs font-medium text-ink">
                  The template catalog could not be loaded.
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {templatesError}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTemplateRefresh((value) => value + 1)}
              >
                Try again
              </Button>
            </div>
          ) : templatesLoading && templates.length === 0 ? (
            <div
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              aria-label="Loading template catalog"
            >
              {Array.from({ length: 6 }, (_, index) => (
                <div
                  key={index}
                  className="surface-panel min-h-[8.5rem] animate-pulse p-4"
                >
                  <div className="mb-3 flex items-center gap-3">
                    <span className="size-10 rounded-[10px] bg-secondary" />
                    <div className="flex-1 space-y-2">
                      <span className="block h-3 w-2/3 rounded bg-secondary" />
                      <span className="block h-2.5 w-1/3 rounded bg-secondary" />
                    </div>
                  </div>
                  <span className="block h-2.5 w-full rounded bg-secondary" />
                  <span className="mt-2 block h-2.5 w-4/5 rounded bg-secondary" />
                </div>
              ))}
            </div>
          ) : templates.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted-foreground">
              No templates match your search.
            </p>
          ) : (
            <>
              <div
                className={cn(
                  'grid gap-3 transition-opacity sm:grid-cols-2 lg:grid-cols-3',
                  templatesLoading && 'pointer-events-none opacity-55',
                )}
                aria-busy={templatesLoading}
              >
                {templates.map((t) => {
                  const pseudoId = `${TEMPLATE_PLAYBOOK_PREFIX}${t.id}`;
                  const cardStatus: ChatSessionStatus | undefined =
                    running && activeRun?.playbook.id === pseudoId
                      ? 'running'
                      : latestRunByPlaybook.get(pseudoId)?.status;
                  return (
                    <button
                      key={t.id}
                      onClick={() => choose(templateAsPlaybook(t), t)}
                      className="surface-panel gallery-card group flex min-h-[8.5rem] flex-col p-4 text-left transition-[transform,border-color] hover:-translate-y-px hover:border-skill/35"
                    >
                      <div className="mb-3 flex items-center gap-3">
                        <TemplateLogo template={t} className="size-10" />
                        <div className="min-w-0 flex-1">
                          <h3 className="truncate text-[13px] font-semibold tracking-[-0.015em] text-ink">
                            {t.name}
                          </h3>
                          <p className="truncate font-mono text-[10px] text-muted-foreground/70">
                            v{t.version.replace(/^v/i, '')}
                          </p>
                        </div>
                        <PlayIcon className="size-3.5 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
                      </div>
                      <p
                        className="line-clamp-2 text-xs leading-relaxed text-muted-foreground"
                        title={t.description}
                      >
                        {t.description}
                      </p>
                      <div className="mt-auto flex items-center gap-1.5 pt-2.5">
                        {t.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag}
                            className="max-w-24 truncate rounded-full border border-border/60 bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground"
                          >
                            {tag}
                          </span>
                        ))}
                        {t.tags.length > 3 && (
                          <span className="text-[10px] text-muted-foreground/60">
                            +{t.tags.length - 3}
                          </span>
                        )}
                        {cardStatus && (
                          <span className="ml-auto shrink-0">
                            <SessionStatusChip status={cardStatus} />
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>

              <nav
                className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4"
                aria-label="Template catalog pages"
              >
                <p className="text-[11px] tabular-nums text-muted-foreground">
                  Showing {(templatePage - 1) * TEMPLATE_PAGE_SIZE + 1}-
                  {Math.min(templatePage * TEMPLATE_PAGE_SIZE, templateTotal)} of{' '}
                  {templateTotal}
                </p>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={templatePage <= 1 || templatesLoading}
                    onClick={() => setTemplatePage((page) => page - 1)}
                    aria-label="Previous template page"
                  >
                    <ArrowLeftIcon className="size-3.5" />
                  </Button>
                  {paginationPages(templatePage, templateTotalPages).map((item) =>
                    typeof item === 'number' ? (
                      <Button
                        key={item}
                        type="button"
                        variant={item === templatePage ? 'secondary' : 'ghost'}
                        size="icon-sm"
                        disabled={templatesLoading}
                        onClick={() => setTemplatePage(item)}
                        aria-label={`Template page ${item}`}
                        aria-current={item === templatePage ? 'page' : undefined}
                        className="tabular-nums"
                      >
                        {item}
                      </Button>
                    ) : (
                      <span
                        key={item}
                        className="flex size-7 items-center justify-center text-[11px] text-muted-foreground/60"
                        aria-hidden="true"
                      >
                        …
                      </span>
                    ),
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={templatePage >= templateTotalPages || templatesLoading}
                    onClick={() => setTemplatePage((page) => page + 1)}
                    aria-label="Next template page"
                  >
                    <ChevronRightIcon className="size-3.5" />
                  </Button>
                </div>
              </nav>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="chat-surface-divider flex shrink-0 items-center gap-2.5 px-4 py-3 sm:px-5">
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => {
            setSelected(null);
            setSelectedTemplate(null);
          }}
          aria-label="Back to wizards"
        >
          <ArrowLeftIcon className="size-4" />
        </Button>
        {selectedTemplate ? (
          <TemplateLogo
            key={selectedTemplate.id}
            template={selectedTemplate}
            className="size-7"
          />
        ) : (
          <span className="skill-chip flex size-6 shrink-0 items-center justify-center rounded-full">
            <SidebarGlyph icon={playbookGlyph(selected.id)} variant="chrome" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold tracking-[-0.015em] text-ink">
              {selected.title}
            </h1>
            {feedStatus && <SessionStatusChip status={feedStatus} />}
          </div>
          <p className="truncate text-[11px] text-muted-foreground">
            {selected.description}
          </p>
        </div>
        {running || activeTemplateDeploy?.status === 'running' ? (
          <Button
            variant="prominent"
            size="icon-xs"
            className="size-7 shrink-0 rounded-full sm:size-[26px]"
            onClick={() => {
              if (activeTemplateDeploy?.status === 'running') {
                void window.easyhost.templates.cancelDeploy(
                  activeTemplateDeploy.deployId,
                );
              } else {
                void cancel();
              }
            }}
            aria-label={selectedTemplate ? 'Stop deploy' : 'Stop wizard'}
          >
            <span
              aria-hidden="true"
              className="block size-2 rounded-[2px] bg-current"
            />
          </Button>
        ) : (
          <Button
            variant="prominent"
            size="sm"
            className="hidden shrink-0 rounded-full px-4 sm:inline-flex"
            onClick={run}
            disabled={!serverId || requiredMissing || deploying}
          >
            <PlayIcon className="size-3.5" />
            {selectedTemplate ? 'Deploy' : 'Run wizard'}
          </Button>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="chat-surface-divider-vertical flex w-[min(100%,320px)] shrink-0 flex-col bg-background">
          <div className="flex-1 overflow-y-auto p-4">
            <div className="surface-panel divide-y divide-border">
              <div className="space-y-2 p-4">
                <Label className={FIELD_LABEL_CLASS}>Target server</Label>
                <Select value={serverId} onValueChange={setServerId}>
                  <SelectTrigger className={FIELD_CONTROL_CLASS}>
                    <SelectValue placeholder="Choose a server" />
                  </SelectTrigger>
                  <SelectContent>
                    {servers.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        <DeviceLaptopIcon className="size-4 text-muted-foreground" />
                        <span className="truncate">{s.name}</span>
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

              {selectedTemplate && (
                <div className="space-y-3 p-4">
                  <div className="flex items-center justify-between">
                    <Label className={FIELD_LABEL_CLASS}>Template</Label>
                    <span className="text-[10px] text-muted-foreground">
                      {selectedTemplate.version}
                    </span>
                  </div>
                  {selectedTemplate.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {selectedTemplate.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    No configuration needed — passwords and hostnames are
                    generated automatically. The app deploys directly with
                    Docker Compose (installing Docker first if missing), the
                    same fixed steps every time, and shows the URL and
                    credentials when done.
                  </p>
                  <div className="flex flex-wrap gap-3">
                    {(
                      [
                        ['GitHub', selectedTemplate.links.github],
                        ['Website', selectedTemplate.links.website],
                        ['Docs', selectedTemplate.links.docs],
                      ] as const
                    ).map(
                      ([label, href]) =>
                        href && (
                          <a
                            key={label}
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          >
                            {label}
                          </a>
                        ),
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="chat-surface-divider shrink-0 p-4 sm:hidden">
            {running || activeTemplateDeploy?.status === 'running' ? (
              <Button
                variant="prominent"
                className="h-9 w-full rounded-full"
                onClick={() => {
                  if (activeTemplateDeploy?.status === 'running') {
                    void window.easyhost.templates.cancelDeploy(
                      activeTemplateDeploy.deployId,
                    );
                  } else {
                    void cancel();
                  }
                }}
              >
                <span
                  aria-hidden="true"
                  className="mr-2 inline-block size-2 rounded-[2px] bg-current"
                />
                {selectedTemplate ? 'Stop deploy' : 'Stop wizard'}
              </Button>
            ) : (
              <Button
                variant="prominent"
                className="h-9 w-full rounded-full"
                onClick={run}
                disabled={!serverId || requiredMissing || deploying}
              >
                <PlayIcon className="size-3.5" />
                {selectedTemplate ? 'Deploy' : 'Run wizard'}
              </Button>
            )}
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {activeTemplateDeploy ? (
            <TemplateDeployPanel deploy={activeTemplateDeploy} />
          ) : (
            <AgentFeed
              feed={feed}
              error={error}
              approval={approval}
              onApprove={respondApproval}
              onSubmitForm={respondForm}
              running={running}
              tokens={tokens}
              emptyMessage={
                selectedTemplate
                  ? 'Pick a server on the left, then Deploy. Progress streams here — no AI involved, the app runs the same steps every time.'
                  : 'Configure the wizard on the left, then run it. Output streams here.'
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deterministic deploy panel (Dokploy-style progress, log, and summary)
// ---------------------------------------------------------------------------

function TemplateDeployPanel({ deploy }: { deploy: ActiveDeploy }) {
  const logRef = useRef<HTMLPreElement | null>(null);
  // Follow the log tail while the deploy streams.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [deploy.log.length]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-4 p-4 sm:p-6">
        {/* Step checklist */}
        <div className="surface-panel divide-y divide-border">
          {TEMPLATE_DEPLOY_STEPS.map((s) => {
            const st = deploy.steps[s.id];
            return (
              <div key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                <DeployStepIcon status={st?.status} />
                <span
                  className={cn(
                    'text-[13px] tracking-[-0.015em]',
                    st ? 'text-ink' : 'text-muted-foreground/60',
                  )}
                >
                  {s.label}
                </span>
                {st?.detail && (
                  <span className="ml-auto min-w-0 truncate text-[11px] text-muted-foreground">
                    {st.detail}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {deploy.error && (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
            {deploy.error}
          </p>
        )}
        {deploy.status === 'cancelled' && (
          <p className="rounded-lg border border-border bg-secondary px-3 py-2 text-xs text-muted-foreground">
            Deploy stopped. Files already written stay on the server under the
            app directory; deploying again starts a fresh copy.
          </p>
        )}

        {/* Summary — the payoff card */}
        {deploy.summary && (
          <DeploySummaryCard summary={deploy.summary} />
        )}

        {/* Live log */}
        {deploy.log.length > 0 && (
          <div className="surface-panel overflow-hidden">
            <div className="flex items-center justify-between border-b border-border bg-secondary/40 px-4 py-1.5">
              <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                Deploy log
              </span>
              {deploy.status === 'running' && (
                <Loader2Icon className="size-3 animate-spin text-muted-foreground" />
              )}
            </div>
            <pre
              ref={logRef}
              className="max-h-72 overflow-y-auto px-4 py-3 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground"
            >
              {deploy.log.join('\n')}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function DeployStepIcon({ status }: { status?: TemplateDeployStepStatus }) {
  if (status === 'running') {
    return <Loader2Icon className="size-4 shrink-0 animate-spin text-primary" />;
  }
  if (status === 'done') {
    return (
      <CircleCheckFilledIcon className="pop-in size-4 shrink-0 text-[var(--success)]" />
    );
  }
  if (status === 'failed') {
    return <XIcon className="pop-in size-4 shrink-0 text-destructive" />;
  }
  if (status === 'skipped') {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/60">
        –
      </span>
    );
  }
  return (
    <span className="size-4 shrink-0 p-0.5">
      <span className="block size-3 rounded-full border-[1.5px] border-border" />
    </span>
  );
}

function DeploySummaryCard({ summary }: { summary: TemplateDeploySummary }) {
  return (
    <div className="surface-panel rise-in p-4">
      <div className="flex items-center gap-2">
        <CircleCheckFilledIcon className="size-4 shrink-0 text-[var(--success)]" />
        <h3 className="text-[13px] font-semibold tracking-[-0.015em] text-ink">
          App deployed
        </h3>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {summary.appDir}
        </span>
      </div>

      {summary.urls.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {summary.urls.map((u) => (
            <a
              key={`${u.serviceName}-${u.url}`}
              href={u.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded-lg border border-border bg-secondary px-3 py-2 transition-colors hover:bg-accent"
            >
              <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">
                {u.url}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {u.serviceName}
              </span>
            </a>
          ))}
        </div>
      )}

      {summary.credentials.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            Generated credentials — stored only in the protected server .env;
            copy them now because History keeps only the variable names
          </p>
          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {summary.credentials.map((c) => (
              <CredentialRow key={c.key} name={c.key} value={c.value} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Values that look secret start masked; anything can be revealed and copied. */
function CredentialRow({ name, value }: { name: string; value: string }) {
  const secret = /pass|secret|key|token|jwt/i.test(name);
  const [revealed, setRevealed] = useState(!secret);
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
        {name}
      </span>
      <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-ink">
        {revealed ? value : '••••••••'}
      </span>
      {secret && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-6 shrink-0 text-muted-foreground"
          onClick={() => setRevealed((r) => !r)}
          aria-label={revealed ? `Hide ${name}` : `Show ${name}`}
        >
          {revealed ? (
            <EyeOffIcon className="size-3.5" />
          ) : (
            <EyeIcon className="size-3.5" />
          )}
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-6 shrink-0 text-muted-foreground"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
        aria-label={`Copy ${name}`}
      >
        {copied ? (
          <CheckIcon className="size-3.5 text-[var(--success)]" />
        ) : (
          <CopyIcon className="size-3.5" />
        )}
      </Button>
    </div>
  );
}

/** Quiet status chip: tinted glyph + word (spinner while running), used on
 *  cards and the run header. No bare dots — product decision. */
function SessionStatusChip({
  status,
  prefix,
}: {
  status: ChatSessionStatus;
  prefix?: string;
}) {
  const meta = SESSION_STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
      <Icon aria-hidden className={cn('size-3 shrink-0', meta.iconClass)} />
      {prefix}
      {meta.label}
    </span>
  );
}

/**
 * The playbook prompt itself is assembled in the main process; this echo is
 * the visible "user message" so the saved transcript records what was asked
 * for (wizard, target server, filled-in fields).
 */
function buildRunEcho(
  playbook: PlaybookMeta,
  values: Record<string, string>,
  serverName: string,
): string {
  const lines = [`Run wizard "${playbook.title}" on ${serverName}.`];
  for (const input of playbook.inputs) {
    const value = values[input.key]?.trim();
    if (value) lines.push(`${input.label}: ${value}`);
  }
  return lines.join('\n');
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
  const options = field.type === 'select' ? field.options ?? [] : [];
  const glyphs = options.map((o) => optionGlyph(o));
  // When every option is a brand mark (the database engines), show them all
  // at once as a grid of tiles instead of hiding them behind a dropdown —
  // no cap on option count, so the grid grows as engines are added.
  const asTiles = options.length > 0 && glyphs.every((g) => g?.color);

  return (
    <div className="space-y-2 p-4">
      <Label className={FIELD_LABEL_CLASS}>
        {field.label}
        {field.required && (
          <span className="text-destructive/80"> *</span>
        )}
      </Label>
      {asTiles ? (
        <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label={field.label}>
          {options.map((o, i) => {
            const glyph = glyphs[i]!;
            const active = value === o;
            return (
              <button
                key={o}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onChange(o)}
                className={cn(
                  'flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs font-medium transition-colors',
                  active
                    ? 'border-skill/45 bg-skill/10 text-ink'
                    : 'border-border bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <glyph.icon
                  className="size-4 shrink-0"
                  style={{ color: glyph.color }}
                />
                <span className="truncate">{o}</span>
              </button>
            );
          })}
        </div>
      ) : field.type === 'select' && options.length > 0 ? (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger className={FIELD_CONTROL_CLASS}>
            <SelectValue placeholder="Choose…" />
          </SelectTrigger>
          <SelectContent>
            {options.map((o, i) => {
              const glyph = glyphs[i];
              return (
                <SelectItem key={o} value={o}>
                  {glyph && (
                    <glyph.icon
                      className={cn(
                        'size-4',
                        !glyph.color && 'text-muted-foreground',
                      )}
                      style={glyph.color ? { color: glyph.color } : undefined}
                    />
                  )}
                  <span className="truncate">{o}</span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      ) : (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className={cn(FIELD_CONTROL_CLASS, 'font-mono')}
        />
      )}
    </div>
  );
}
