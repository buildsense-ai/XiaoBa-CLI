import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import type { Server } from 'http';
import { createApiRouter } from '../src/dashboard/routes/api';

describe('dashboard skills API', () => {
  let testRoot: string;
  let originalCwd: string;
  let originalSkillsDir: string | undefined;
  let originalAppRoot: string | undefined;
  let server: Server | undefined;
  let baseUrl: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalSkillsDir = process.env.XIAOBA_SKILLS_DIR;
    originalAppRoot = process.env.XIAOBA_APP_ROOT;
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dashboard-skills-api-'));
    process.chdir(testRoot);
    process.env.XIAOBA_APP_ROOT = path.join(testRoot, 'app');
    process.env.XIAOBA_SKILLS_DIR = path.join(testRoot, 'user-skills');

    writeSkill('user-skills/user-tool/SKILL.md', 'user-tool', 'User managed skill');
    writeSkill('user-skills/local-tool/SKILL.md', 'local-tool', 'Local skill');
    writeSkill('app/skills/catsco-prompt-editor/SKILL.md', 'catsco-prompt-editor', 'Prompt editor seed skill');

    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter({ getAll: () => [] } as any));
    server = await listen(app);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>(resolve => server!.close(() => resolve()));
      server = undefined;
    }
    process.chdir(originalCwd);
    if (originalSkillsDir === undefined) {
      delete process.env.XIAOBA_SKILLS_DIR;
    } else {
      process.env.XIAOBA_SKILLS_DIR = originalSkillsDir;
    }
    if (originalAppRoot === undefined) {
      delete process.env.XIAOBA_APP_ROOT;
    } else {
      process.env.XIAOBA_APP_ROOT = originalAppRoot;
    }
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('returns skill management capabilities by source', async () => {
    const response = await fetch(`${baseUrl}/api/skills-all`);
    const skills = await response.json() as any[];
    const byName = new Map(skills.map(skill => [skill.name, skill]));

    assert.equal(response.status, 200);
    assert.deepEqual(pickManagement(byName.get('user-tool')), {
      source: 'user',
      protected: false,
      canDisable: true,
      canDelete: true,
      canShare: true,
    });
    assert.deepEqual(pickManagement(byName.get('local-tool')), {
      source: 'user',
      protected: false,
      canDisable: true,
      canDelete: true,
      canShare: true,
    });
  });

  test('returns skills root without being captured by skill name route', async () => {
    const response = await fetch(`${baseUrl}/api/skills-root`);
    const data = await response.json() as any;

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.path, path.join(testRoot, 'user-skills'));
  });

  test('allows user skill removal', async () => {
    const deleteUser = await fetch(`${baseUrl}/api/skills/user-tool`, { method: 'DELETE' });
    assert.equal(deleteUser.status, 200);
    assert.equal(fs.existsSync(path.join(testRoot, 'user-skills/user-tool')), false);
  });

  test('local skills can be disabled and deleted', async () => {
    const disable = await fetch(`${baseUrl}/api/skills/local-tool/disable`, { method: 'POST' });
    assert.equal(disable.status, 200);
    assert.equal(fs.existsSync(path.join(testRoot, 'user-skills/local-tool/SKILL.md')), false);
    assert.equal(fs.existsSync(path.join(testRoot, 'user-skills/local-tool/SKILL.md.disabled')), true);

    const deleteDisabled = await fetch(`${baseUrl}/api/skills/local-tool`, { method: 'DELETE' });
    assert.equal(deleteDisabled.status, 200);
    assert.equal(fs.existsSync(path.join(testRoot, 'user-skills/local-tool')), false);
  });

  test('installs the prompt editor seed skill into the user skills directory', async () => {
    const targetFile = path.join(testRoot, 'user-skills/catsco-prompt-editor/SKILL.md');
    fs.rmSync(path.dirname(targetFile), { recursive: true, force: true });

    const install = await fetch(`${baseUrl}/api/prompts/editor-skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await install.json() as any;

    assert.equal(install.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.installed, true);
    assert.equal(fs.existsSync(targetFile), true);

    const secondInstall = await fetch(`${baseUrl}/api/prompts/editor-skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const secondData = await secondInstall.json() as any;
    assert.equal(secondInstall.status, 200);
    assert.equal(secondData.existing, true);
  });

  test('does not remove an existing prompt editor directory without overwrite', async () => {
    const targetDir = path.join(testRoot, 'user-skills/catsco-prompt-editor');
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'notes.txt'), 'keep me', 'utf8');

    const install = await fetch(`${baseUrl}/api/prompts/editor-skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await install.json() as any;

    assert.equal(install.status, 200);
    assert.equal(data.existing, true);
    assert.equal(data.installed, false);
    assert.equal(fs.readFileSync(path.join(targetDir, 'notes.txt'), 'utf8'), 'keep me');

    const overwrite = await fetch(`${baseUrl}/api/prompts/editor-skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overwrite: true }),
    });
    const overwriteData = await overwrite.json() as any;
    assert.equal(overwrite.status, 200);
    assert.equal(overwriteData.installed, true);
    assert.equal(fs.existsSync(path.join(targetDir, 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(targetDir, 'notes.txt')), false);
  });

  test('prompt write endpoints require JSON requests', async () => {
    const install = await fetch(`${baseUrl}/api/prompts/editor-skill/install`, {
      method: 'POST',
    });
    assert.equal(install.status, 415);

    const writePrompt = await fetch(`${baseUrl}/api/prompts/file`, {
      method: 'PUT',
      body: 'path=system-prompt.md&content=bad',
    });
    assert.equal(writePrompt.status, 415);

    const deletePrompt = await fetch(`${baseUrl}/api/prompts/file?path=system-prompt.md`, {
      method: 'DELETE',
    });
    assert.equal(deletePrompt.status, 415);

    const applyProposal = await fetch(`${baseUrl}/api/pet/prompt-proposal/apply`, {
      method: 'POST',
    });
    assert.equal(applyProposal.status, 415);
  });

  function writeSkill(relativePath: string, name: string, description: string): void {
    const filePath = path.join(testRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      '---',
      '',
      `# ${name}`,
      '',
    ].join('\n'));
  }
});

function pickManagement(skill: any): any {
  return {
    source: skill.source,
    protected: skill.protected,
    canDisable: skill.canDisable,
    canDelete: skill.canDelete,
    canShare: skill.canShare,
  };
}

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}
