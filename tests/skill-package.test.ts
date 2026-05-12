import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SkillParser } from '../src/skills/skill-parser';
import { inspectSkillPackage, validateInstalledSkillPackage } from '../src/skills/skill-package';

describe('skill package inspection', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skill-package-'));
  });

  afterEach(() => {
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('attaches manifest readiness to parsed skills', () => {
    const skillDir = writePackagedSkill('example-tool-skill', {
      requiredEnv: ['XIAOBA_TEST_TOOL_URL'],
    });

    const skill = SkillParser.parse(path.join(skillDir, 'SKILL.md'));

    assert.equal(skill.metadata.name, 'example-tool-skill');
    assert.equal(skill.packageInfo?.hasManifest, true);
    assert.equal(skill.packageInfo?.manifest?.schemaVersion, 'example.agent-tools.v1');
    assert.equal(skill.packageInfo?.manifest?.toolCount, 1);
    assert.deepEqual(skill.packageInfo?.manifest?.providerSafeToolNames, ['example_health']);
    assert.equal(skill.packageInfo?.readiness.status, 'not_configured');
    assert.deepEqual(skill.packageInfo?.readiness.missingEnv, ['XIAOBA_TEST_TOOL_URL']);
  });

  test('reports ready when required manifest env is present', () => {
    const skillDir = writePackagedSkill('example-tool-skill', {
      requiredEnv: ['XIAOBA_TEST_TOOL_URL'],
    });

    const info = inspectSkillPackage(path.join(skillDir, 'SKILL.md'), {
      XIAOBA_TEST_TOOL_URL: 'https://example.test/tool',
    } as any);

    assert.equal(info.readiness.status, 'ready');
    assert.deepEqual(info.readiness.missingEnv, []);
  });

  test('invalid manifest is not install-ready', () => {
    const skillDir = writePromptOnlySkill('broken-skill');
    fs.writeFileSync(path.join(skillDir, 'agent_tools.json'), '{ not-json');

    const validation = validateInstalledSkillPackage(skillDir);

    assert.equal(validation.ok, false);
    assert.equal(validation.packageInfo.readiness.status, 'invalid');
    assert.ok(validation.packageInfo.readiness.invalidManifest);
  });

  test('manifest with incomplete tool declaration is invalid', () => {
    const skillDir = writePromptOnlySkill('incomplete-tool-skill');
    fs.writeFileSync(path.join(skillDir, 'agent_tools.json'), JSON.stringify({
      schema_version: 'example.agent-tools.v1',
      tools: [{}],
    }));

    const validation = validateInstalledSkillPackage(skillDir);

    assert.equal(validation.ok, false);
    assert.equal(validation.packageInfo.readiness.status, 'invalid');
    assert.match(validation.packageInfo.readiness.reasons.join('\n'), /missing provider_safe_name/);
    assert.match(validation.packageInfo.readiness.reasons.join('\n'), /missing parameters_schema/);
  });

  test('prompt-only skills remain ready and loadable', () => {
    const skillDir = writePromptOnlySkill('prompt-only');

    const skill = SkillParser.parse(path.join(skillDir, 'SKILL.md'));

    assert.equal(skill.packageInfo?.hasManifest, false);
    assert.equal(skill.packageInfo?.readiness.status, 'ready');
  });

  function writePackagedSkill(name: string, options: { requiredEnv: string[] }): string {
    const skillDir = writePromptOnlySkill(name);
    fs.writeFileSync(path.join(skillDir, 'README.md'), '# Skill\n');
    fs.writeFileSync(path.join(skillDir, 'LICENSE'), 'Test license\n');
    fs.writeFileSync(path.join(skillDir, 'agent_tools.json'), JSON.stringify({
      schema_version: 'example.agent-tools.v1',
      package_version: '0.2.0',
      name,
      environment: {
        required: options.requiredEnv.map(envName => ({ name: envName, secret: false })),
      },
      tools: [{
        name: 'example.health',
        provider_safe_name: 'example_health',
        command: 'health',
        parameters_schema: { type: 'object', additionalProperties: false, properties: {} },
        output_schema: { type: 'object', properties: {} },
        timeout_seconds: 60,
      }],
    }, null, 2));
    return skillDir;
  }

  function writePromptOnlySkill(name: string): string {
    const skillDir = path.join(testRoot, name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
      '---',
      `name: ${name}`,
      `description: ${name} description`,
      '---',
      '',
      `Use ${name}.`,
      '',
    ].join('\n'));
    return skillDir;
  }
});
