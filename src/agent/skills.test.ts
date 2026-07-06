import { describe, expect, it, afterEach } from 'vitest';
import * as FS from 'node:fs';
import * as OS from 'node:os';
import * as Path from 'node:path';
import {
  bundledSkills,
  loadUserSkills,
  mergeSkills,
  parseSkill,
  skillsPromptSection,
} from './skills';

const VALID = `---
name: my-skill
description: Does a thing. Use when the user asks for the thing.
---

# My skill

Step one.
`;

describe('parseSkill', () => {
  it('parses frontmatter and body', () => {
    const s = parseSkill(VALID, 'user');
    expect(s).not.toBeNull();
    expect(s?.name).toBe('my-skill');
    expect(s?.description).toContain('Use when');
    expect(s?.body).toContain('Step one.');
    expect(s?.source).toBe('user');
  });

  it('rejects missing frontmatter, name, description, or body', () => {
    expect(parseSkill('# no frontmatter', 'user')).toBeNull();
    expect(
      parseSkill('---\ndescription: x\n---\nbody', 'user'),
    ).toBeNull();
    expect(parseSkill('---\nname: a-skill\n---\nbody', 'user')).toBeNull();
    expect(
      parseSkill('---\nname: a-skill\ndescription: x\n---\n', 'user'),
    ).toBeNull();
  });

  it('rejects invalid names (spaces, uppercase, leading dash)', () => {
    for (const bad of ['My Skill', 'MYSKILL', '-lead', 'a_b']) {
      expect(
        parseSkill(`---\nname: ${bad}\ndescription: x\n---\nbody`, 'user'),
      ).toBeNull();
    }
  });

  it('handles CRLF line endings', () => {
    const crlf = VALID.replace(/\n/g, '\r\n');
    expect(parseSkill(crlf, 'bundled')?.name).toBe('my-skill');
  });

  it('truncates oversized bodies instead of failing', () => {
    const big = `---\nname: big\ndescription: x\n---\n${'a'.repeat(50_000)}`;
    const s = parseSkill(big, 'user');
    expect(s?.body.length).toBeLessThan(30_000);
    expect(s?.body).toContain('[truncated');
  });
});

describe('bundledSkills', () => {
  it('every bundled skill parses with a unique name', () => {
    const skills = bundledSkills();
    expect(skills.length).toBe(21);
    const names = skills.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of skills) {
      expect(s.description.length).toBeGreaterThan(20);
      expect(s.body.length).toBeGreaterThan(200);
    }
    expect(names).toContain('docker-deploy');
    expect(names).toContain('security-audit');
  });
});

describe('mergeSkills', () => {
  it('user skill overrides a bundled skill of the same name', () => {
    const bundled = bundledSkills();
    const override = parseSkill(
      '---\nname: docker-deploy\ndescription: custom\n---\ncustom body',
      'user',
    )!;
    const merged = mergeSkills(bundled, [override]);
    expect(merged.length).toBe(bundled.length);
    expect(merged.find((s) => s.name === 'docker-deploy')?.source).toBe(
      'user',
    );
  });
});

describe('loadUserSkills', () => {
  let tmp: string | null = null;
  afterEach(() => {
    if (tmp) FS.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('creates the dir with a README and reads folder + flat skills', () => {
    tmp = FS.mkdtempSync(Path.join(OS.tmpdir(), 'easyhost-skills-'));
    const dir = Path.join(tmp, 'skills');

    expect(loadUserSkills(dir)).toEqual([]);
    expect(FS.existsSync(Path.join(dir, 'README.md'))).toBe(true);

    FS.mkdirSync(Path.join(dir, 'folder-skill'));
    FS.writeFileSync(
      Path.join(dir, 'folder-skill', 'SKILL.md'),
      '---\nname: folder-skill\ndescription: x\n---\nbody',
    );
    FS.writeFileSync(
      Path.join(dir, 'flat-skill.md'),
      '---\nname: flat-skill\ndescription: x\n---\nbody',
    );
    FS.writeFileSync(Path.join(dir, 'broken.md'), 'not a skill');

    const names = loadUserSkills(dir)
      .map((s) => s.name)
      .sort();
    expect(names).toEqual(['flat-skill', 'folder-skill']);
  });
});

describe('skillsPromptSection', () => {
  it('lists every skill name and description', () => {
    const section = skillsPromptSection(bundledSkills());
    expect(section).toContain('<available_skills>');
    for (const s of bundledSkills()) {
      expect(section).toContain(`- ${s.name}:`);
    }
  });

  it('is empty when there are no skills', () => {
    expect(skillsPromptSection([])).toBe('');
  });
});
