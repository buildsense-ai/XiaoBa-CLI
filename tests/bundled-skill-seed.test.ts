import { afterEach, beforeEach, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SkillManager } from '../src/skills/skill-manager';

const projectRoot = path.resolve(__dirname, '..');
let runtimeRoot = '';
let previousAppRoot: string | undefined;
let previousRuntimeRoot: string | undefined;
let previousUserDataRoot: string | undefined;
let previousSkillsRoot: string | undefined;
let previousIsPackaged: string | undefined;
let previousCwd = '';

beforeEach(() => {
  runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-bundled-skill-seed-'));
  previousAppRoot = process.env.XIAOBA_APP_ROOT;
  previousRuntimeRoot = process.env.XIAOBA_RUNTIME_ROOT;
  previousUserDataRoot = process.env.XIAOBA_USER_DATA_DIR;
  previousSkillsRoot = process.env.XIAOBA_SKILLS_DIR;
  previousIsPackaged = process.env.XIAOBA_IS_PACKAGED;
  previousCwd = process.cwd();
  const appRoot = path.join(runtimeRoot, 'packaged-app');
  fs.mkdirSync(path.join(appRoot, 'skills', 'mails'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'skills', 'mails', 'SKILL.md'), [
    '---',
    'name: mails',
    'description: Bundled mail Skill used by an offline packaged runtime.',
    '---',
    '',
    '# Mails',
  ].join('\n'));
  fs.mkdirSync(path.join(runtimeRoot, 'unrelated-cwd'), { recursive: true });
  process.chdir(path.join(runtimeRoot, 'unrelated-cwd'));
  process.env.XIAOBA_APP_ROOT = appRoot;
  process.env.XIAOBA_IS_PACKAGED = '1';
  process.env.XIAOBA_RUNTIME_ROOT = runtimeRoot;
  process.env.XIAOBA_USER_DATA_DIR = runtimeRoot;
  process.env.XIAOBA_SKILLS_DIR = path.join(runtimeRoot, 'skills');
});

afterEach(() => {
  restoreEnv('XIAOBA_APP_ROOT', previousAppRoot);
  restoreEnv('XIAOBA_RUNTIME_ROOT', previousRuntimeRoot);
  restoreEnv('XIAOBA_USER_DATA_DIR', previousUserDataRoot);
  restoreEnv('XIAOBA_SKILLS_DIR', previousSkillsRoot);
  restoreEnv('XIAOBA_IS_PACKAGED', previousIsPackaged);
  process.chdir(previousCwd);
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
});

test('cold-start discovery seeds mails from the packaged source but excludes generated snapshots', async () => {
  const manager = new SkillManager();
  await manager.loadSkills();

  assert.equal(
    manager.getSkill('mails')?.metadata.description,
    'Bundled mail Skill used by an offline packaged runtime.',
  );
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'skills', 'mails', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'skills', 'generated-distilled')), false);
});

test('does not overwrite an existing user-owned mails directory', async () => {
  const targetFile = path.join(runtimeRoot, 'skills', 'mails', 'SKILL.md');
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, [
    '---',
    'name: mails',
    'description: User-owned mail Skill.',
    '---',
    '',
    '# My Mails',
  ].join('\n'));

  const manager = new SkillManager();
  await manager.loadSkills();

  assert.equal(manager.getSkill('mails')?.metadata.description, 'User-owned mail Skill.');
  assert.match(fs.readFileSync(targetFile, 'utf8'), /User-owned mail Skill/);
});

test('the desktop package excludes unregistered generated Skill snapshots', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.ok(packageJson.build.files.includes('!skills/generated-distilled/**'));
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
