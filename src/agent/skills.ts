/**
 * Agent Skills — vetted, on-demand procedures for the DevOps agent, following the
 * standard Agent Skills pattern (progressive disclosure): every skill is a
 * SKILL.md with frontmatter (name + description). Only the one-line descriptions
 * ride along in the system prompt; the agent pulls a skill's full instructions
 * through the `skill` tool right before doing that kind of work. A large skill
 * library therefore costs almost nothing in context until a skill is needed.
 *
 * Skills come from two places, merged by name (user wins, so users can override
 * a bundled procedure they disagree with):
 *  - bundled:  src/agent/skills/<name>/SKILL.md, compiled in via Vite `?raw`
 *  - user:     <EASYHOST_HOME>/skills/<name>/SKILL.md or <name>.md, read from
 *              disk at the start of every run so edits apply without a restart
 */
import * as FS from 'node:fs';
import * as Path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { AgentEvent } from '../shared/ipc-types';
import { resolveRuntimeHome } from '../main/runtimePaths';
import { nextToolCallId } from './tools';

import dockerDeploy from './skills/docker-deploy/SKILL.md?raw';
import dockerComposeStack from './skills/docker-compose-stack/SKILL.md?raw';
import reverseProxyTls from './skills/reverse-proxy-tls/SKILL.md?raw';
import dockerMaintenance from './skills/docker-maintenance/SKILL.md?raw';
import serverHardening from './skills/server-hardening/SKILL.md?raw';
import troubleshootServer from './skills/troubleshoot-server/SKILL.md?raw';
import monitoringUptime from './skills/monitoring-uptime/SKILL.md?raw';
import githubAutoDeploy from './skills/github-auto-deploy/SKILL.md?raw';
import deployPython from './skills/deploy-python/SKILL.md?raw';
import deployNodejs from './skills/deploy-nodejs/SKILL.md?raw';
import deploySsrFrontend from './skills/deploy-ssr-frontend/SKILL.md?raw';
import deployStaticFrontend from './skills/deploy-static-frontend/SKILL.md?raw';
import deployGo from './skills/deploy-go/SKILL.md?raw';
import deployJvm from './skills/deploy-jvm/SKILL.md?raw';
import deployPhp from './skills/deploy-php/SKILL.md?raw';
import deployRuby from './skills/deploy-ruby/SKILL.md?raw';
import deployRust from './skills/deploy-rust/SKILL.md?raw';
import deployDotnet from './skills/deploy-dotnet/SKILL.md?raw';
import deployElixir from './skills/deploy-elixir/SKILL.md?raw';
import deployAnyStack from './skills/deploy-any-stack/SKILL.md?raw';

export type Skill = {
  name: string;
  description: string;
  body: string;
  source: 'bundled' | 'user';
};

/** A skill body larger than this is truncated — it has to fit in model context. */
const MAX_SKILL_BODY = 24 * 1024;

const BUNDLED_RAW = [
  dockerDeploy,
  dockerComposeStack,
  reverseProxyTls,
  dockerMaintenance,
  serverHardening,
  troubleshootServer,
  monitoringUptime,
  githubAutoDeploy,
  deployPython,
  deployNodejs,
  deploySsrFrontend,
  deployStaticFrontend,
  deployGo,
  deployJvm,
  deployPhp,
  deployRuby,
  deployRust,
  deployDotnet,
  deployElixir,
  deployAnyStack,
];

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Parse a SKILL.md: `---` frontmatter with simple `key: value` lines (name and
 * description required), followed by the markdown body. Deliberately not a full
 * YAML parser — a flat key/value header is all the format needs, and it keeps
 * user-authored skills from failing on YAML edge cases.
 */
export function parseSkill(
  raw: string,
  source: Skill['source'],
): Skill | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw.trim());
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
  }
  const name = meta.name ?? '';
  const description = meta.description ?? '';
  if (!SKILL_NAME_RE.test(name) || !description) return null;
  let body = m[2].trim();
  if (body.length > MAX_SKILL_BODY) {
    body =
      body.slice(0, MAX_SKILL_BODY) +
      `\n…[truncated ${body.length - MAX_SKILL_BODY} bytes]`;
  }
  if (!body) return null;
  return { name, description, body, source };
}

export function bundledSkills(): Skill[] {
  const skills: Skill[] = [];
  for (const raw of BUNDLED_RAW) {
    const s = parseSkill(raw, 'bundled');
    if (s) skills.push(s);
  }
  return skills;
}

const USER_SKILLS_README = `# EASY-HOST custom skills

Drop skills here to teach the agent new procedures (or override a built-in one by
reusing its name). A skill is a folder with a SKILL.md, or a flat <name>.md file:

    ~/.easyhost/skills/
      my-skill/SKILL.md
      quick-note.md

Format — frontmatter with name + description, then markdown instructions:

    ---
    name: my-skill
    description: One line saying what it does AND when the agent should use it.
    ---

    # My skill

    Step-by-step instructions the agent follows...

The description is what makes the agent pick the skill, so state the trigger
("Use when...") explicitly. Skills are re-read at the start of every agent run,
so edits apply immediately — no restart needed.
`;

/** Read user skills from <home>/skills, creating the folder + README on first use. */
export function loadUserSkills(dir: string): Skill[] {
  const skills: Skill[] = [];
  try {
    FS.mkdirSync(dir, { recursive: true });
    const readme = Path.join(dir, 'README.md');
    if (!FS.existsSync(readme)) FS.writeFileSync(readme, USER_SKILLS_README);

    for (const entry of FS.readdirSync(dir, { withFileTypes: true })) {
      try {
        let file: string | null = null;
        if (entry.isDirectory()) {
          const candidate = Path.join(dir, entry.name, 'SKILL.md');
          if (FS.existsSync(candidate)) file = candidate;
        } else if (
          entry.isFile() &&
          entry.name.endsWith('.md') &&
          entry.name.toLowerCase() !== 'readme.md'
        ) {
          file = Path.join(dir, entry.name);
        }
        if (!file) continue;
        const s = parseSkill(FS.readFileSync(file, 'utf8'), 'user');
        if (s) skills.push(s);
      } catch {
        // One malformed user skill must never take down an agent run.
      }
    }
  } catch {
    // Home dir unwritable — run with bundled skills only.
  }
  return skills;
}

export function mergeSkills(bundled: Skill[], user: Skill[]): Skill[] {
  const byName = new Map<string, Skill>();
  for (const s of bundled) byName.set(s.name, s);
  for (const s of user) byName.set(s.name, s); // user overrides bundled
  return [...byName.values()];
}

/** Everything the agent can use this run: bundled + user skills, user wins. */
export function loadSkills(): Skill[] {
  const userDir = Path.join(resolveRuntimeHome(), 'skills');
  return mergeSkills(bundledSkills(), loadUserSkills(userDir));
}

/** System-prompt section: the how-to plus one line of metadata per skill. */
export function skillsPromptSection(skills: Skill[]): string {
  if (skills.length === 0) return '';
  const list = skills
    .map((s) => `- ${s.name}: ${s.description}`)
    .join('\n');
  return [
    'Skills:',
    'You have a library of skills — vetted step-by-step procedures for common DevOps jobs. Docker is the standard way EASY-HOST deploys and runs software; prefer a Docker-based skill over improvising a native install unless the user explicitly asks otherwise.',
    "- BEFORE starting any work that matches a skill's description below, call the `skill` tool with its name and follow the loaded instructions. They encode hard-won details (non-interactive flags, security defaults, verification steps, rollback paths) that keep servers safe.",
    '- Skills reference each other; load the referenced skill when you reach that part of the job. Do not load skills irrelevant to the task.',
    '',
    '<available_skills>',
    list,
    '</available_skills>',
  ].join('\n');
}

/**
 * The `skill` tool — merged into the agent's tool set alongside buildTools().
 * Kept here (not tools.ts) so everything skills-related lives in one module.
 */
export function buildSkillTool(
  skills: Skill[],
  emit: (event: AgentEvent) => void,
) {
  const names = skills.map((s) => s.name).join(', ');
  return {
    skill: tool({
      description: `Load the full step-by-step instructions for a skill before doing work it covers. Available skills: ${names}. Always call this before starting a task that matches a skill's description in the system prompt.`,
      inputSchema: z.object({
        name: z
          .string()
          .describe('The skill name, exactly as listed in the system prompt.'),
      }),
      execute: async ({ name }) => {
        const toolCallId = nextToolCallId('skill');
        const found = skills.find((s) => s.name === name.trim());
        ctxEmitStart(emit, toolCallId, name, found);
        if (!found) {
          const result = {
            error: `Unknown skill "${name}". Available skills: ${names}`,
          };
          emit({ type: 'tool-end', toolCallId, result });
          return result;
        }
        // Feed card gets a compact summary; the model gets the full instructions.
        emit({
          type: 'tool-end',
          toolCallId,
          result: { loaded: true, skill: found.name, source: found.source },
        });
        return { name: found.name, instructions: found.body };
      },
    }),
  };
}

function ctxEmitStart(
  emit: (event: AgentEvent) => void,
  toolCallId: string,
  name: string,
  found: Skill | undefined,
): void {
  emit({
    type: 'tool-start',
    toolCallId,
    tool: 'skill',
    args: { name },
    description: found
      ? `Using skill: ${found.name}`
      : `Loading skill: ${name}`,
  });
}
