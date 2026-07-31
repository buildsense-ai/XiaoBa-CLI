import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import { withBotSkillWorkspaceLock } from '../src/bot-skills/lock';
import { BotSkillWorkspaceService } from '../src/bot-skills/workspace';
import { bootstrapDefaultSkillHubSkills } from '../src/skillhub/default-skill-bootstrap';
import { SkillHubTool } from '../src/tools/skillhub-tool';
import type { ToolExecutionContext } from '../src/types/tool';

describe('Bot Skill workspace writer lock', () => {
  let runtimeRoot: string;
  let previousRuntimeRoot: string | undefined;
  let previousSkillsRoot: string | undefined;

  beforeEach(() => {
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-bot-skill-writer-lock-'));
    previousRuntimeRoot = process.env.XIAOBA_USER_DATA_DIR;
    previousSkillsRoot = process.env.XIAOBA_SKILLS_DIR;
    process.env.XIAOBA_USER_DATA_DIR = runtimeRoot;
    process.env.XIAOBA_SKILLS_DIR = path.join(runtimeRoot, 'skills');
    fs.mkdirSync(process.env.XIAOBA_SKILLS_DIR, { recursive: true });
  });

  afterEach(async () => {
    await delay(25);
    restoreEnv('XIAOBA_USER_DATA_DIR', previousRuntimeRoot);
    restoreEnv('XIAOBA_SKILLS_DIR', previousSkillsRoot);
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  test('serializes Tool subscribe and unsubscribe writes behind activation and sync operations', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let mutationStarted = false;
    const held = withBotSkillWorkspaceLock(runtimeRoot, () => gate);
    await delay(20);

    const target = path.join(runtimeRoot, 'skills', 'locked-install');
    const tool = new SkillHubTool(
      { search: async () => ({ skills: [] }) },
      {
        list: async () => ({ scope: 'runtime', subscriptions: [] }),
        subscribe: async skillId => {
          mutationStarted = true;
          fs.mkdirSync(target, { recursive: true });
          fs.writeFileSync(path.join(target, 'SKILL.md'), skillId);
          return {
            scope: 'runtime',
            action: 'installed',
            subscription: {
              skillId,
              name: 'locked-install',
              installName: 'locked-install',
              versionPolicy: 'latest',
              resolvedVersion: '1.0.0',
              subscribedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          } as const;
        },
        unsubscribe: async skillId => {
          mutationStarted = true;
          fs.rmSync(target, { recursive: true, force: true });
          return {
            scope: 'runtime',
            skillId,
            removed: true,
            subscriptionFound: true,
          };
        },
      },
    );

    const mutation = tool.execute(
      { action: 'subscribe', skillId: 'example/locked-install' },
      toolContext(),
    );
    await delay(30);
    assert.equal(mutationStarted, false);
    assert.equal(fs.existsSync(target), false);

    release();
    const result = await mutation;
    await held;
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), 'example/locked-install');

    let releaseUnsubscribe!: () => void;
    const unsubscribeGate = new Promise<void>(resolve => { releaseUnsubscribe = resolve; });
    mutationStarted = false;
    const unsubscribeHeld = withBotSkillWorkspaceLock(runtimeRoot, () => unsubscribeGate);
    await delay(20);
    const unsubscribe = tool.execute(
      { action: 'unsubscribe', skillId: 'example/locked-install' },
      toolContext(),
    );
    await delay(30);
    assert.equal(mutationStarted, false);
    assert.equal(fs.existsSync(target), true);

    releaseUnsubscribe();
    const unsubscribeResult = await unsubscribe;
    await unsubscribeHeld;
    assert.equal(unsubscribeResult.ok, true);
    assert.equal(fs.existsSync(target), false);
  });

  test('serializes default Skill bootstrap state and package writes through the same lock', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let installStarted = false;
    const held = withBotSkillWorkspaceLock(runtimeRoot, () => gate);
    await delay(20);

    const bootstrap = bootstrapDefaultSkillHubSkills({
      skills: [{
        key: 'example/default',
        skillId: 'example/default',
        version: '1.0.0',
        installName: 'default',
      }],
      service: {
        install: async (skillId, version) => {
          installStarted = true;
          const target = path.join(runtimeRoot, 'skills', 'default');
          fs.mkdirSync(target, { recursive: true });
          fs.writeFileSync(path.join(target, 'SKILL.md'), `${skillId}@${version}`);
          return {
            ok: true as const,
            skill: {
              skillId,
              name: 'default',
              version: String(version),
              path: target,
              installName: 'default',
              action: 'installed' as const,
            },
            signingKeyId: 'test',
            rootKeyId: 'test',
          };
        },
      },
    });
    await delay(30);
    assert.equal(installStarted, false);

    release();
    const result = await bootstrap;
    await held;
    assert.equal(result[0]?.action, 'installed');
    assert.equal(
      fs.readFileSync(path.join(runtimeRoot, 'skills', 'default', 'SKILL.md'), 'utf8'),
      'example/default@1.0.0',
    );
  });

  test('rejects a writer while the bound Bot and active workspace ownership disagree', async () => {
    new BotSkillWorkspaceService(runtimeRoot).activate('bot-a');
    createCatsCoLocalConfigService({ runtimeRoot }).save({
      version: 1,
      currentBot: { uid: 'bot-b', apiKey: 'bot-b-key' },
    });
    let called = false;
    const tool = new SkillHubTool(
      { search: async () => ({ skills: [] }) },
      {
        list: async () => ({ scope: 'runtime', subscriptions: [] }),
        subscribe: async skillId => {
          called = true;
          return {
            scope: 'runtime',
            action: 'installed',
            subscription: {
              skillId,
              name: skillId,
              installName: skillId,
              versionPolicy: 'latest',
              resolvedVersion: '1',
              subscribedAt: '',
              updatedAt: '',
            },
          } as const;
        },
        unsubscribe: async skillId => ({
          scope: 'runtime',
          skillId,
          removed: false,
          subscriptionFound: false,
        }),
      },
    );

    const result = await tool.execute(
      { action: 'subscribe', skillId: 'example/rejected' },
      toolContext(),
    );
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.message, /ownership is changing/i);
    assert.equal(called, false);
  });

  test('supports a bounded custom wait for callers that cannot wait for a network writer', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = withBotSkillWorkspaceLock(runtimeRoot, () => gate);
    await delay(20);

    await assert.rejects(
      withBotSkillWorkspaceLock(runtimeRoot, () => undefined, { waitMs: 25, retryMs: 5 }),
      /timed out/i,
    );
    release();
    await held;
  });
});

function toolContext(): ToolExecutionContext {
  return { workingDirectory: process.cwd(), conversationHistory: [] };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
