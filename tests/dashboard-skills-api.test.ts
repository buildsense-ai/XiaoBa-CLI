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
  let server: Server | undefined;
  let baseUrl: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dashboard-skills-api-'));
    process.chdir(testRoot);

    writeSkill('skills/user-tool/SKILL.md', 'user-tool', 'User managed skill');
    writeSkill('skills/bundled-tool/SKILL.md', 'bundled-tool', 'Bundled skill');
    fs.writeFileSync(
      path.join(testRoot, 'skills/bundled-tool/.xiaoba-bundled-skill.json'),
      JSON.stringify({ name: 'bundled-tool', version: 'test' })
    );

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
    });
    assert.deepEqual(pickManagement(byName.get('bundled-tool')), {
      source: 'bundled',
      protected: false,
      canDisable: true,
      canDelete: false,
    });
  });

  test('allows user skill removal', async () => {
    const deleteUser = await fetch(`${baseUrl}/api/skills/user-tool`, { method: 'DELETE' });
    assert.equal(deleteUser.status, 200);
    assert.equal(fs.existsSync(path.join(testRoot, 'skills/user-tool')), false);
  });

  test('bundled skills can be disabled but not deleted', async () => {
    const deleteActive = await fetch(`${baseUrl}/api/skills/bundled-tool`, { method: 'DELETE' });
    assert.equal(deleteActive.status, 403);

    const disable = await fetch(`${baseUrl}/api/skills/bundled-tool/disable`, { method: 'POST' });
    assert.equal(disable.status, 200);
    assert.equal(fs.existsSync(path.join(testRoot, 'skills/bundled-tool/SKILL.md')), false);
    assert.equal(fs.existsSync(path.join(testRoot, 'skills/bundled-tool/SKILL.md.disabled')), true);

    const deleteDisabled = await fetch(`${baseUrl}/api/skills/bundled-tool`, { method: 'DELETE' });
    assert.equal(deleteDisabled.status, 403);
    assert.equal(fs.existsSync(path.join(testRoot, 'skills/bundled-tool')), true);
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
  };
}

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}
