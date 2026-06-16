import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentSession } from '../src/core/agent-session';
import { SkillManager } from '../src/skills/skill-manager';
import { ToolManager } from '../src/tools/tool-manager';
import { AIService } from '../src/utils/ai-service';
import { RuntimeFactory } from '../src/runtime/runtime-factory';
import { resolveDefaultRuntimeProfile } from '../src/runtime/runtime-profile';

describe('RuntimeFactory', () => {
  let testRoot: string;
  let originalCwd: string;
  let originalSkillsEnv: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalSkillsEnv = process.env.XIAOBA_SKILLS_DIR;
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-runtime-factory-'));
    process.chdir(testRoot);
    process.env.XIAOBA_SKILLS_DIR = path.join(testRoot, 'skills');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalSkillsEnv === undefined) delete process.env.XIAOBA_SKILLS_DIR;
    else process.env.XIAOBA_SKILLS_DIR = originalSkillsEnv;
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('creates current CLI service graph and session without loading skills when disabled', async () => {
    writeTestSkill('factory-demo');
    const profile = resolveDefaultRuntimeProfile({
      surface: 'cli',
      workingDirectory: testRoot,
    });

    const runtime = await RuntimeFactory.createSession({
      profile,
      sessionKey: 'cli',
      sessionType: 'cli',
      loadSkills: false,
    });

    assert.equal(runtime.profile, profile);
    assert.ok(runtime.session instanceof AgentSession);
    assert.equal(runtime.session.key, 'cli');
    assert.ok(runtime.services.aiService instanceof AIService);
    assert.ok(runtime.services.toolManager instanceof ToolManager);
    assert.ok(runtime.services.skillManager instanceof SkillManager);
    assert.equal(runtime.services.toolManager.getToolCount(), profile.tools.enabled.length);
    assert.equal((runtime.services.toolManager as any).workingDirectory, path.resolve(testRoot));
    assert.deepStrictEqual(runtime.services.skillManager.getAllSkills(), []);

    const sessionLogPath = (runtime.session as any).sessionTurnLogger.getLogFilePath();
    assert.match(sessionLogPath.replace(/\\/g, '/'), /logs\/sessions\/cli\/\d{4}-\d{2}-\d{2}\/cli_cli\.jsonl$/);
  });

  test('loads skills through the factory helper when enabled', async () => {
    writeTestSkill('factory-demo');
    const profile = resolveDefaultRuntimeProfile({
      surface: 'cli',
      workingDirectory: testRoot,
    });

    const runtime = await RuntimeFactory.createSession({
      profile,
      sessionKey: 'cli',
      sessionType: 'cli',
    });

    assert.deepStrictEqual(
      runtime.services.skillManager.getAllSkills().map(skill => skill.metadata.name),
      ['factory-demo'],
    );
  });

  test('factory-created sessions keep concrete workingDirectory out of the system prompt', async () => {
    const profile = resolveDefaultRuntimeProfile({
      surface: 'cli',
      workingDirectory: testRoot,
      env: {
        CURRENT_AGENT_DISPLAY_NAME: 'Factory Bot',
        CURRENT_PLATFORM: 'cli',
      },
    });

    const runtime = await RuntimeFactory.createSession({
      profile,
      sessionKey: 'cli',
      sessionType: 'cli',
      loadSkills: false,
    });

    await runtime.session.init();
    const messages = (runtime.session as any).messages;

    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'system');
    assert.match(messages[0].content, /你在这个平台上的名字是：Factory Bot/);
    assert.match(messages[0].content, /当前平台：cli/);
    assert.match(messages[0].content, /Current directory is provided in a transient message/);
    assert.doesNotMatch(
      messages[0].content.replace(/\\/g, '/'),
      new RegExp(escapeRegExp(path.resolve(testRoot).replace(/\\/g, '/'))),
    );
  });

  test('factory services snapshot profile workingDirectory without putting it in the system prompt', async () => {
    const originalWorkingDirectory = path.join(testRoot, 'workspace-a');
    const mutatedWorkingDirectory = path.join(testRoot, 'workspace-b');
    fs.mkdirSync(originalWorkingDirectory);
    fs.mkdirSync(mutatedWorkingDirectory);

    const profile = resolveDefaultRuntimeProfile({
      surface: 'cli',
      workingDirectory: originalWorkingDirectory,
    });

    const runtime = await RuntimeFactory.createSession({
      profile,
      sessionKey: 'cli',
      sessionType: 'cli',
      loadSkills: false,
    });
    profile.workingDirectory = mutatedWorkingDirectory;

    await runtime.session.init();
    const messages = (runtime.session as any).messages;

    assert.match(messages[0].content, /Current directory is provided in a transient message/);
    assert.doesNotMatch(
      messages[0].content.replace(/\\/g, '/'),
      new RegExp(escapeRegExp(path.resolve(originalWorkingDirectory).replace(/\\/g, '/'))),
    );
    assert.doesNotMatch(
      messages[0].content.replace(/\\/g, '/'),
      new RegExp(escapeRegExp(path.resolve(mutatedWorkingDirectory).replace(/\\/g, '/'))),
    );
    assert.equal(
      (runtime.services.toolManager as any).workingDirectory,
      path.resolve(originalWorkingDirectory),
    );
  });

  test('uses profile model overrides when creating AIService', async () => {
    const profile = resolveDefaultRuntimeProfile({
      surface: 'cli',
      model: {
        provider: 'openai',
        apiUrl: 'https://example.com/v1',
        apiKey: 'test-key' as any,
        model: 'test-model',
        temperature: 0.1,
        maxTokens: 1024,
      } as any,
    });

    const services = await RuntimeFactory.createServices(profile, { loadSkills: false });

    assert.deepStrictEqual((services.aiService as any).config.provider, 'openai');
    assert.deepStrictEqual((services.aiService as any).config.apiUrl, 'https://example.com/v1');
    assert.deepStrictEqual((services.aiService as any).config.model, 'test-model');
    assert.deepStrictEqual((services.aiService as any).config.temperature, 0.1);
    assert.deepStrictEqual((services.aiService as any).config.maxTokens, 1024);
  });

  test('AIService ignores historical backup model env', async () => {
    const envKeys = [
      'GAUZ_LLM_BACKUP_API_BASE',
      'GAUZ_LLM_BACKUP_API_KEY',
      'GAUZ_LLM_BACKUP_MODEL',
      'GAUZ_LLM_BACKUP_PROVIDER',
      'GAUZ_LLM_BACKUP_1_API_BASE',
      'GAUZ_LLM_BACKUP_1_API_KEY',
      'GAUZ_LLM_BACKUP_1_MODEL',
      'GAUZ_LLM_BACKUP_1_PROVIDER',
      'GAUZ_LLM_FAILOVER_ON_ANY_ERROR',
      'GAUZ_STREAM_FAILOVER_ON_PARTIAL',
    ];
    const originalEnv = new Map(envKeys.map(key => [key, process.env[key]]));

    process.env.GAUZ_LLM_BACKUP_API_BASE = 'https://backup.example.test/v1';
    process.env.GAUZ_LLM_BACKUP_API_KEY = 'backup-key';
    process.env.GAUZ_LLM_BACKUP_MODEL = 'backup-model';
    process.env.GAUZ_LLM_BACKUP_PROVIDER = 'anthropic';
    process.env.GAUZ_LLM_BACKUP_1_API_BASE = 'https://numbered-backup.example.test/v1';
    process.env.GAUZ_LLM_BACKUP_1_API_KEY = 'numbered-backup-key';
    process.env.GAUZ_LLM_BACKUP_1_MODEL = 'numbered-backup-model';
    process.env.GAUZ_LLM_BACKUP_1_PROVIDER = 'openai';
    process.env.GAUZ_LLM_FAILOVER_ON_ANY_ERROR = 'true';
    process.env.GAUZ_STREAM_FAILOVER_ON_PARTIAL = 'true';

    try {
      const profile = resolveDefaultRuntimeProfile({
        surface: 'cli',
        model: {
          provider: 'openai',
          apiUrl: 'https://primary.example.test/v1',
          apiKey: 'primary-key' as any,
          model: 'primary-model',
        } as any,
      });

      const services = await RuntimeFactory.createServices(profile, { loadSkills: false });
      const aiService = services.aiService as any;

      assert.equal(aiService.providerChain, undefined);
      assert.equal(aiService.config.apiUrl, 'https://primary.example.test/v1');
      assert.equal(aiService.config.apiKey, 'primary-key');
      assert.equal(aiService.config.model, 'primary-model');
      assert.equal(aiService.provider.apiUrl, 'https://primary.example.test/v1');
      assert.equal(aiService.provider.model, 'primary-model');
    } finally {
      for (const key of envKeys) {
        const value = originalEnv.get(key);
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  test('creates ToolManager from profile enabled tools', async () => {
    const profile = resolveDefaultRuntimeProfile({
      surface: 'cli',
      workingDirectory: testRoot,
      tools: ['read_file', 'execute_shell'],
    });

    const services = await RuntimeFactory.createServices(profile, { loadSkills: false });

    assert.deepStrictEqual(
      services.toolManager.getToolDefinitions().map(definition => definition.name),
      ['read_file', 'execute_shell'],
    );
    assert.equal(services.toolManager.getTool('write_file'), undefined);
  });

  test('rejects invalid profile tool names before creating services', () => {
    const profile = resolveDefaultRuntimeProfile({
      surface: 'cli',
      workingDirectory: testRoot,
      tools: ['read_file', 'missing_tool'],
    });

    assert.throws(
      () => RuntimeFactory.createServicesSync(profile),
      /Invalid runtime profile "xiaoba-cli": tools\.enabled\[1\]: Unknown runtime tool: missing_tool/,
    );
  });

  test('creates services synchronously without loading skills for adapter constructors', () => {
    writeTestSkill('factory-demo');
    const profile = resolveDefaultRuntimeProfile({
      surface: 'feishu',
      workingDirectory: testRoot,
    });

    const services = RuntimeFactory.createServicesSync(profile);

    assert.ok(services.aiService instanceof AIService);
    assert.ok(services.toolManager instanceof ToolManager);
    assert.ok(services.skillManager instanceof SkillManager);
    assert.equal((services.toolManager as any).workingDirectory, path.resolve(testRoot));
    assert.deepStrictEqual(services.skillManager.getAllSkills(), []);
  });

  test('creates reusable system prompt providers from a profile snapshot', async () => {
    const originalWorkingDirectory = path.join(testRoot, 'adapter-workspace');
    const mutatedWorkingDirectory = path.join(testRoot, 'mutated-workspace');
    fs.mkdirSync(originalWorkingDirectory);
    fs.mkdirSync(mutatedWorkingDirectory);
    const profile = resolveDefaultRuntimeProfile({
      surface: 'feishu',
      workingDirectory: originalWorkingDirectory,
      env: {
        CURRENT_AGENT_DISPLAY_NAME: 'Feishu Bot',
        CURRENT_PLATFORM: 'feishu',
      },
    });

    const provider = RuntimeFactory.createSystemPromptProvider(profile);
    profile.workingDirectory = mutatedWorkingDirectory;

    const prompt = await provider();

    assert.match(prompt, /Feishu Bot/);
    assert.match(prompt, /当前平台：feishu/);
    assert.match(prompt, /Current directory is provided in a transient message/);
    assert.doesNotMatch(
      prompt.replace(/\\/g, '/'),
      new RegExp(escapeRegExp(path.resolve(originalWorkingDirectory).replace(/\\/g, '/'))),
    );
    assert.doesNotMatch(
      prompt.replace(/\\/g, '/'),
      new RegExp(escapeRegExp(path.resolve(mutatedWorkingDirectory).replace(/\\/g, '/'))),
    );
  });

  test('rejects system prompt provider changes after session initialization', async () => {
    const profile = resolveDefaultRuntimeProfile({
      surface: 'cli',
      workingDirectory: testRoot,
    });

    const runtime = await RuntimeFactory.createSession({
      profile,
      sessionKey: 'cli',
      sessionType: 'cli',
      loadSkills: false,
    });

    await runtime.session.init();

    assert.throws(
      () => runtime.session.setSystemPromptProvider(() => 'late prompt'),
      /Cannot set system prompt provider after session initialization/,
    );
  });
});

function writeTestSkill(name: string): void {
  const skillDir = path.join(process.cwd(), 'skills', name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      'description: Factory test skill',
      '---',
      '',
      'Use this skill for factory tests.',
    ].join('\n'),
    'utf-8',
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
