import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillManager } from '../src/skills/skill-manager';
import { SkillParser } from '../src/skills/skill-parser';
import { PathResolver } from '../src/utils/path-resolver';

describe('SkillManager atomic loading', () => {
  let testRoot: string;
  let skillsPath: string;
  let originalSkillsEnv: string | undefined;

  beforeEach(() => {
    originalSkillsEnv = process.env.XIAOBA_SKILLS_DIR;
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skill-manager-'));
    skillsPath = path.join(testRoot, 'skills');
    process.env.XIAOBA_SKILLS_DIR = skillsPath;
  });

  afterEach(() => {
    if (originalSkillsEnv === undefined) delete process.env.XIAOBA_SKILLS_DIR;
    else process.env.XIAOBA_SKILLS_DIR = originalSkillsEnv;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('publishes the next complete Skill map in one assignment', async () => {
    writeSkill(skillsPath, 'old-skill', 'Old skill');
    const manager = new SkillManager();
    await manager.loadSkills();

    fs.rmSync(path.join(skillsPath, 'old-skill'), { recursive: true, force: true });
    writeSkill(skillsPath, 'new-a', 'New skill A');
    writeSkill(skillsPath, 'new-b', 'New skill B');

    const originalParse = SkillParser.parse;
    let parseCount = 0;
    let visibleDuringSecondParse: string[] | undefined;
    SkillParser.parse = ((filePath: string) => {
      parseCount += 1;
      if (parseCount === 2) {
        visibleDuringSecondParse = skillNames(manager);
      }
      return originalParse.call(SkillParser, filePath);
    }) as typeof SkillParser.parse;

    try {
      await manager.loadSkills();
    } finally {
      SkillParser.parse = originalParse;
    }

    assert.deepEqual(visibleDuringSecondParse, ['old-skill']);
    assert.deepEqual(skillNames(manager), ['new-a', 'new-b']);
  });

  test('skips an invalid Skill while atomically publishing the valid set', async () => {
    writeSkill(skillsPath, 'old-skill', 'Old skill');
    const manager = new SkillManager();
    await manager.loadSkills();

    fs.rmSync(path.join(skillsPath, 'old-skill'), { recursive: true, force: true });
    writeSkill(skillsPath, 'valid-skill', 'Valid skill');
    writeInvalidSkill(skillsPath, 'invalid-skill');

    await manager.loadSkills();

    assert.deepEqual(skillNames(manager), ['valid-skill']);
  });

  test('keeps the previous complete map when directory enumeration fails', async () => {
    writeSkill(skillsPath, 'stable-skill', 'Stable skill');
    const manager = new SkillManager();
    await manager.loadSkills();

    const originalFindSkillFiles = PathResolver.findSkillFiles;
    PathResolver.findSkillFiles = (() => {
      throw new Error('simulated directory read failure');
    }) as typeof PathResolver.findSkillFiles;

    try {
      await manager.loadSkills();
    } finally {
      PathResolver.findSkillFiles = originalFindSkillFiles;
    }

    assert.deepEqual(skillNames(manager), ['stable-skill']);
  });

  test('keeps the previous complete map when the Skill directory disappears', async () => {
    writeSkill(skillsPath, 'stable-skill', 'Stable skill');
    const manager = new SkillManager();
    await manager.loadSkills();

    fs.rmSync(skillsPath, { recursive: true, force: true });
    await manager.loadSkills();

    assert.equal(fs.existsSync(skillsPath), false);
    assert.deepEqual(skillNames(manager), ['stable-skill']);
  });

  test('publishes an empty map when the Skill directory is successfully empty', async () => {
    writeSkill(skillsPath, 'removed-skill', 'Removed skill');
    const manager = new SkillManager();
    await manager.loadSkills();

    fs.rmSync(skillsPath, { recursive: true, force: true });
    fs.mkdirSync(skillsPath, { recursive: true });
    await manager.loadSkills();

    assert.deepEqual(skillNames(manager), []);
  });
});

function writeSkill(skillsPath: string, name: string, description: string): void {
  const skillDir = path.join(skillsPath, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    ['---', `name: ${name}`, `description: ${description}`, '---', '', `Use ${name}.`].join('\n'),
    'utf-8',
  );
}

function writeInvalidSkill(skillsPath: string, name: string): void {
  const skillDir = path.join(skillsPath, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    ['---', `name: ${name}`, '---', '', `Use ${name}.`].join('\n'),
    'utf-8',
  );
}

function skillNames(manager: SkillManager): string[] {
  return manager.getAllSkills().map(skill => skill.metadata.name).sort();
}
