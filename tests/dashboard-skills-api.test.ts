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
  let server: Server | undefined;
  let baseUrl: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalSkillsDir = process.env.XIAOBA_SKILLS_DIR;
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dashboard-skills-api-'));
    process.chdir(testRoot);
    process.env.XIAOBA_SKILLS_DIR = path.join(testRoot, 'skills');

    writeSkill('skills/user-tool/SKILL.md', 'user-tool', 'User managed skill');
    writeSkill('skills/local-tool/SKILL.md', 'local-tool', 'Local skill');

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
    assert.equal(data.path, path.join(testRoot, 'skills'));
  });

  test('allows user skill removal', async () => {
    const deleteUser = await fetch(`${baseUrl}/api/skills/user-tool`, { method: 'DELETE' });
    assert.equal(deleteUser.status, 200);
    assert.equal(fs.existsSync(path.join(testRoot, 'skills/user-tool')), false);
  });

  test('local skills can be disabled and deleted', async () => {
    const disable = await fetch(`${baseUrl}/api/skills/local-tool/disable`, { method: 'POST' });
    assert.equal(disable.status, 200);
    assert.equal(fs.existsSync(path.join(testRoot, 'skills/local-tool/SKILL.md')), false);
    assert.equal(fs.existsSync(path.join(testRoot, 'skills/local-tool/SKILL.md.disabled')), true);

    const deleteDisabled = await fetch(`${baseUrl}/api/skills/local-tool`, { method: 'DELETE' });
    assert.equal(deleteDisabled.status, 200);
    assert.equal(fs.existsSync(path.join(testRoot, 'skills/local-tool')), false);
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
