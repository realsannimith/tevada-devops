import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { getPath: () => path.join(os.tmpdir(), 'easyhost-templates-test') },
}));

import { parse as parseToml } from 'smol-toml';
import {
  buildTemplatePrompt,
  generateRandomDomain,
  paginateTemplates,
  processTemplate,
  processValue,
  TemplateConfig,
} from './templates';
import { FALLBACK_TEMPLATES } from './templates-fallback';

const schema = { serverIp: '203.0.113.7', projectName: 'uptime-kuma' };

describe('template catalog pagination', () => {
  const templates = Array.from({ length: 38 }, (_, index) => ({
    id: `app-${index + 1}`,
    name: index === 20 ? 'Special Analytics' : `App ${index + 1}`,
    version: 'latest',
    description: index === 20 ? 'Private web analytics' : 'A useful app',
    links: {},
    tags: index % 2 === 0 ? ['database'] : ['monitoring'],
  }));

  it('returns only the requested page with accurate totals', () => {
    const result = paginateTemplates(templates, { page: 2, pageSize: 15 });
    expect(result.items).toHaveLength(15);
    expect(result.items[0].id).toBe('app-16');
    expect(result.total).toBe(38);
    expect(result.totalPages).toBe(3);
  });

  it('searches metadata before slicing and returns common tags', () => {
    const result = paginateTemplates(templates, {
      query: 'analytics',
      pageSize: 15,
    });
    expect(result.items.map((item) => item.id)).toEqual(['app-21']);
    expect(result.total).toBe(1);
    expect(result.tags).toEqual(['database', 'monitoring']);
  });

  it('can resolve one exact template for saved deploy history', () => {
    const result = paginateTemplates(templates, {
      templateId: 'app-31',
      pageSize: 1,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('app-31');
  });
});

describe('template variable processing', () => {
  it('expands ${domain} into an sslip.io hostname carrying the server ip', () => {
    const domain = generateRandomDomain(schema);
    expect(domain).toMatch(/^uptime-kuma-[0-9a-f]{6}-203-0-113-7\.sslip\.io$/);
  });

  it('omits the ip section when no server ip is known', () => {
    const domain = generateRandomDomain({ serverIp: '', projectName: 'app' });
    expect(domain).toMatch(/^app-[0-9a-f]{6}\.sslip\.io$/);
  });

  it('expands generators with length arguments', () => {
    const vars = {};
    expect(processValue('${password:32}', vars, schema)).toHaveLength(32);
    expect(processValue('${hash:12}', vars, schema)).toHaveLength(12);
    // 16 random bytes → 24 base64 chars
    expect(processValue('${base64:16}', vars, schema)).toHaveLength(24);
    expect(processValue('${uuid}', vars, schema)).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it('resolves variable references, leaving unknown ones untouched', () => {
    const vars = { main_domain: 'x.sslip.io' };
    expect(processValue('https://${main_domain}/api', vars, schema)).toBe(
      'https://x.sslip.io/api',
    );
    expect(processValue('${nope}', vars, schema)).toBe('${nope}');
  });

  it('processes a dokploy-style template end to end (env as table)', () => {
    const config = parseToml(`
[variables]
main_domain = "\${domain}"
admin_password = "\${password:20}"

[config]
mounts = []

[[config.domains]]
serviceName = "web"
port = 3000
host = "\${main_domain}"

[config.env]
APP_URL = "http://\${main_domain}"
ADMIN_PASSWORD = "\${admin_password}"
STATIC = "yes"
`) as TemplateConfig;

    const out = processTemplate(config, schema);
    expect(out.domains).toHaveLength(1);
    expect(out.domains[0].serviceName).toBe('web');
    expect(out.domains[0].host).toMatch(/\.sslip\.io$/);
    const env = Object.fromEntries(out.envs.map((e) => e.split(/=(.*)/s).slice(0, 2)));
    expect(env.APP_URL).toBe(`http://${out.domains[0].host}`);
    expect(env.ADMIN_PASSWORD).toHaveLength(20);
    expect(env.STATIC).toBe('yes');
  });

  it('processes env declared as an array and mounts with variables', () => {
    const config = parseToml(`
[variables]
db_password = "\${password:32}"

[config]
env = [
  "DB_PASSWORD=\${db_password}",
  "DEBUG=0"
]

[[config.mounts]]
filePath = "app.ini"
content = "password = \${db_password}"
`) as TemplateConfig;

    const out = processTemplate(config, schema);
    const dbLine = out.envs.find((e) => e.startsWith('DB_PASSWORD='));
    expect(dbLine).toBeDefined();
    const password = dbLine!.split('=')[1];
    expect(password).toHaveLength(32);
    expect(out.envs).toContain('DEBUG=0');
    expect(out.mounts[0].content).toBe(`password = ${password}`);
  });

  it('parses every bundled fallback blueprint', () => {
    for (const t of FALLBACK_TEMPLATES) {
      const config = parseToml(t.toml) as TemplateConfig;
      const out = processTemplate(config, schema);
      expect(Array.isArray(out.envs)).toBe(true);
      expect(Array.isArray(out.domains)).toBe(true);
      expect(t.compose).toContain('services:');
    }
  });
});

describe('buildTemplatePrompt', () => {
  it('embeds compose, env, mounts and domain instructions verbatim', () => {
    const wordpress = FALLBACK_TEMPLATES.find((t) => t.meta.id === 'wordpress')!;
    const config = parseToml(wordpress.toml) as TemplateConfig;
    const processed = processTemplate(config, {
      serverIp: '203.0.113.7',
      projectName: 'wordpress',
    });
    const prompt = buildTemplatePrompt({
      meta: {
        id: 'wordpress',
        name: 'WordPress',
        version: 'latest',
        description: '',
        links: {},
        tags: [],
      },
      files: { config, dockerCompose: wordpress.compose },
      processed,
      appName: 'wordpress-abc123',
      serverName: 'my server',
    });
    expect(prompt).toContain('/opt/easyhost/apps/wordpress-abc123/code/docker-compose.yml');
    expect(prompt).toContain(wordpress.compose.trimEnd());
    // Generated DB password lands in the .env block.
    const dbLine = processed.envs.find((e) => e.startsWith('DB_PASSWORD='));
    expect(prompt).toContain(dbLine!);
    // The uploads.ini mount is written under files/.
    expect(prompt).toContain('/opt/easyhost/apps/wordpress-abc123/files/uploads.ini');
    // Domain exposure instructions are present.
    expect(prompt).toContain('docker-compose.override.yml');
  });
});
