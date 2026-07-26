import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  bootstrapDefaultSkillHubSkills,
  getDefaultSkillBootstrapStatePath,
} from '../src/skillhub/default-skill-bootstrap';
import {
  DEFAULT_SKILLHUB_SKILLS,
  type DefaultSkillHubSkill,
} from '../src/skillhub/default-skills';

const ATRIDAISUKI_DEFAULTS = [
  'atridaisuki/web-search@1.0.2',
  'atridaisuki/read-pdf@1.0.15',
  'atridaisuki/pdf-author-editor@1.2.5',
  'atridaisuki/image-asset-generator@1.0.13',
];

describe('default SkillHub bootstrap', () => {
  let testRoot: string;
  let originalCwd: string;
  let originalSkillsEnv: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalSkillsEnv = process.env.XIAOBA_SKILLS_DIR;
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-default-skills-'));
    process.chdir(testRoot);
    process.env.XIAOBA_SKILLS_DIR = path.join(testRoot, 'skills');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalSkillsEnv === undefined) delete process.env.XIAOBA_SKILLS_DIR;
    else process.env.XIAOBA_SKILLS_DIR = originalSkillsEnv;
    if (fs.existsSync(testRoot)) fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('ships the selected atridaisuki defaults without cloud HTML artifact', () => {
    const configured = DEFAULT_SKILLHUB_SKILLS
      .filter(skill => skill.skillId.startsWith('atridaisuki/'))
      .map(skill => `${skill.skillId}@${skill.version}`);

    assert.deepEqual(configured, ATRIDAISUKI_DEFAULTS);
    assert.equal(configured.some(skill => skill.includes('artifact')), false);
  });

  test('keeps default identifiers and install directories unique', () => {
    assertUnique(DEFAULT_SKILLHUB_SKILLS.map(skill => skill.key), 'key');
    assertUnique(DEFAULT_SKILLHUB_SKILLS.map(skill => skill.skillId), 'skillId');
    assertUnique(DEFAULT_SKILLHUB_SKILLS.map(skill => skill.installName), 'installName');
  });

  test('installs a missing default skill once and records central state', async () => {
    const calls: string[] = [];
    const skill = defaultSkill('agent-browser');
    const service = fakeInstallService(calls);

    const first = await bootstrapDefaultSkillHubSkills({ skills: [skill], service });
    const second = await bootstrapDefaultSkillHubSkills({ skills: [skill], service });

    assert.deepEqual(first.map(item => item.action), ['installed']);
    assert.deepEqual(second.map(item => item.reason), ['already_installed']);
    assert.deepEqual(calls, ['catsco/agent-browser@1.0.0']);
    const state = readState();
    assert.equal(state.items[skill.key].state, 'installed');
    assert.equal(state.items[skill.key].relativePath, 'agent-browser');
    assert.equal(fs.existsSync(path.join(testRoot, 'skills', 'agent-browser', 'SKILL.md')), true);
  });

  test('does not reinstall a default skill after the user removes it', async () => {
    const calls: string[] = [];
    const skill = defaultSkill('officecli');
    const service = fakeInstallService(calls);

    await bootstrapDefaultSkillHubSkills({ skills: [skill], service });
    fs.rmSync(path.join(testRoot, 'skills', 'officecli'), { recursive: true, force: true });
    const removed = await bootstrapDefaultSkillHubSkills({ skills: [skill], service });
    const later = await bootstrapDefaultSkillHubSkills({ skills: [skill], service });

    assert.equal(removed[0].state, 'user_removed');
    assert.equal(later[0].state, 'user_removed');
    assert.deepEqual(calls, ['catsco/officecli@1.0.0']);
  });

  test('does not overwrite an existing user skill with the same install name', async () => {
    const calls: string[] = [];
    const skill = defaultSkill('self-evolution');
    const existingDir = path.join(testRoot, 'skills', 'self-evolution');
    fs.mkdirSync(existingDir, { recursive: true });
    fs.writeFileSync(path.join(existingDir, 'SKILL.md'), '---\nname: self-evolution\ndescription: user copy\n---\n');

    const result = await bootstrapDefaultSkillHubSkills({
      skills: [skill],
      service: fakeInstallService(calls),
    });

    assert.equal(result[0].state, 'name_conflict');
    assert.deepEqual(calls, []);
    assert.equal(readState().items[skill.key].state, 'name_conflict');
  });

  test('installs newly added defaults without reviving removed defaults', async () => {
    const calls: string[] = [];
    const firstSkill = defaultSkill('agent-browser');
    const secondSkill = defaultSkill('officecli');
    const service = fakeInstallService(calls);

    await bootstrapDefaultSkillHubSkills({ skills: [firstSkill], service });
    fs.rmSync(path.join(testRoot, 'skills', 'agent-browser'), { recursive: true, force: true });
    await bootstrapDefaultSkillHubSkills({ skills: [firstSkill], service });

    const result = await bootstrapDefaultSkillHubSkills({
      skills: [firstSkill, secondSkill],
      service,
    });

    assert.equal(result.find(item => item.key === firstSkill.key)?.state, 'user_removed');
    assert.equal(result.find(item => item.key === secondSkill.key)?.action, 'installed');
    assert.deepEqual(calls, ['catsco/agent-browser@1.0.0', 'catsco/officecli@1.0.0']);
  });
});

function defaultSkill(name: string): DefaultSkillHubSkill {
  return {
    key: `catsco/${name}`,
    skillId: `catsco/${name}`,
    version: '1.0.0',
    installName: name,
  };
}

function fakeInstallService(calls: string[]) {
  return {
    async install(skillId: string, version?: string) {
      calls.push(`${skillId}@${version}`);
      const name = skillId.split('/').pop() || skillId;
      const skillDir = path.join(process.env.XIAOBA_SKILLS_DIR || '', name);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: default skill\n---\n`);
      return {
        ok: true as const,
        skill: {
          skillId,
          name,
          version: String(version || ''),
          path: skillDir,
        },
        signingKeyId: 'test-signing',
        rootKeyId: 'test-root',
      };
    },
  };
}

function readState(): any {
  return JSON.parse(fs.readFileSync(getDefaultSkillBootstrapStatePath(), 'utf-8'));
}

function assertUnique(values: string[], label: string): void {
  assert.equal(new Set(values).size, values.length, `Default SkillHub ${label} values must be unique.`);
}
