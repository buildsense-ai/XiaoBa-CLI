import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveRuntimeProfileFromConfig } from '../src/runtime/runtime-profile-config';
import { SkillManager } from '../src/skills/skill-manager';

describe('review runtime profile extensions', () => {
  let testRoot: string;
  let originalSkillsDir: string | undefined;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-review-profile-test-'));
    originalSkillsDir = process.env.XIAOBA_SKILLS_DIR;
  });

  afterEach(() => {
    if (originalSkillsDir === undefined) delete process.env.XIAOBA_SKILLS_DIR;
    else process.env.XIAOBA_SKILLS_DIR = originalSkillsDir;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('loads profile prompt files and allowed skills from config', () => {
    const configPath = path.join(testRoot, 'review-profile.json');
    fs.writeFileSync(configPath, JSON.stringify({
      schemaVersion: 1,
      profile: {
        id: 'review-investigation',
        prompt: { files: ['profiles/review-investigation.md'] },
        skills: { enabled: true, allowed: ['review-evidence-workspace'] },
      },
    }), 'utf8');

    const resolved = resolveRuntimeProfileFromConfig({
      configPath,
      runtimeRoot: testRoot,
      workingDirectory: testRoot,
      env: {},
    });

    assert.equal(resolved.config.loaded, true);
    assert.deepEqual(resolved.profile.prompt.files, ['profiles/review-investigation.md']);
    assert.deepEqual(resolved.profile.skills.allowed, ['review-evidence-workspace']);
  });

  test('SkillManager enforces its allowlist across loading and reload', async () => {
    const skillsDir = path.join(testRoot, 'skills');
    writeSkill(skillsDir, 'allowed-skill');
    writeSkill(skillsDir, 'blocked-skill');
    process.env.XIAOBA_SKILLS_DIR = skillsDir;

    const manager = new SkillManager({ allowedSkillNames: ['allowed-skill'] });
    await manager.loadSkills();
    assert.deepEqual(manager.getAllSkills().map(skill => skill.metadata.name), ['allowed-skill']);

    writeSkill(skillsDir, 'new-blocked-skill');
    await manager.reload();
    assert.deepEqual(manager.getAllSkills().map(skill => skill.metadata.name), ['allowed-skill']);
  });
});

function writeSkill(root: string, name: string): void {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${name} test skill`,
    '---',
    '',
    `# ${name}`,
    '',
    'Test content.',
  ].join('\n'), 'utf8');
}
