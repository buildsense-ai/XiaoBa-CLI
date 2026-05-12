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
    writePackagedSkill('skills/example-tool-skill', 'example-tool-skill', 'Example packaged skill');
    writeSkill('skills/bundled-tool/SKILL.md', 'bundled-tool', 'Bundled skill');
    fs.writeFileSync(
      path.join(testRoot, 'skills/bundled-tool/.xiaoba-bundled-skill.json'),
      JSON.stringify({ name: 'bundled-tool', version: 'test' })
    );
    writeSkill('skills/_tool-skills/sub-agent/SKILL.md', 'sub-agent', 'System skill');

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
    assert.deepEqual(pickManagement(byName.get('sub-agent')), {
      source: 'system',
      protected: true,
      canDisable: false,
      canDelete: false,
    });
    assert.equal(byName.get('example-tool-skill').packageInfo.hasManifest, true);
    assert.equal(byName.get('example-tool-skill').packageInfo.readiness.status, 'not_configured');
    assert.deepEqual(byName.get('example-tool-skill').packageInfo.readiness.missingEnv, ['XIAOBA_TEST_TOOL_URL']);
    assert.deepEqual(byName.get('example-tool-skill').packageInfo.manifest.providerSafeToolNames, ['example_health']);
  });

  test('protects system skills and allows user skill removal', async () => {
    const disableSystem = await fetch(`${baseUrl}/api/skills/sub-agent/disable`, { method: 'POST' });
    assert.equal(disableSystem.status, 403);

    const deleteSystem = await fetch(`${baseUrl}/api/skills/sub-agent`, { method: 'DELETE' });
    assert.equal(deleteSystem.status, 403);

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

  test('keeps package info visible for disabled packaged skills', async () => {
    const disable = await fetch(`${baseUrl}/api/skills/example-tool-skill/disable`, { method: 'POST' });
    assert.equal(disable.status, 200);

    const response = await fetch(`${baseUrl}/api/skills-all`);
    const skills = await response.json() as any[];
    const disabledSkill = skills.find(skill => skill.name === 'example-tool-skill');

    assert.equal(disabledSkill.enabled, false);
    assert.equal(disabledSkill.packageInfo.hasManifest, true);
    assert.equal(disabledSkill.packageInfo.readiness.status, 'not_configured');
    assert.deepEqual(disabledSkill.packageInfo.readiness.missingEnv, ['XIAOBA_TEST_TOOL_URL']);
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

  function writePackagedSkill(relativeDir: string, name: string, description: string): void {
    const dir = path.join(testRoot, relativeDir);
    writeSkill(path.join(relativeDir, 'SKILL.md'), name, description);
    fs.writeFileSync(path.join(dir, 'README.md'), '# Packaged skill\n');
    fs.writeFileSync(path.join(dir, 'LICENSE'), 'Test license\n');
    fs.writeFileSync(path.join(dir, 'agent_tools.json'), JSON.stringify({
      schema_version: 'example.agent-tools.v1',
      package_version: '0.2.0',
      name,
      environment: {
        required: [{ name: 'XIAOBA_TEST_TOOL_URL' }],
      },
      tools: [{
        name: 'example.health',
        provider_safe_name: 'example_health',
        command: 'health',
        parameters_schema: { type: 'object', additionalProperties: false, properties: {} },
        output_schema: { type: 'object', properties: {} },
        timeout_seconds: 60,
      }],
    }));
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
