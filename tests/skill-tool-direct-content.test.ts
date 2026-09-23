import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillTool } from '../src/tools/skill-tool';
import { SkillManager } from '../src/skills/skill-manager';
import { TurnSkillSnapshotStore } from '../src/skills/turn-skill-snapshot';
import { FileBotDefinitionRepository } from '../src/bot-definition/repository';
import { writeBotSkillLocalMarker } from '../src/bot-skills/local-manifest';
import {
  isBotSkillReferenceActive,
  recordPendingBotSkillRevocation,
  reconcilePendingBotSkillRevocations,
} from '../src/bot-skills/revocation';

describe('skill tool direct content mode', () => {
  let testRoot: string;
  let originalCwd: string;
  let originalSkillsEnv: string | undefined;
  let originalRuntimeRootEnv: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalSkillsEnv = process.env.XIAOBA_SKILLS_DIR;
    originalRuntimeRootEnv = process.env.XIAOBA_USER_DATA_DIR;
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skill-tool-'));
    process.chdir(testRoot);
    process.env.XIAOBA_SKILLS_DIR = path.join(testRoot, 'skills');
    fs.mkdirSync(path.join(testRoot, 'skills', 'lin', 'demo'), { recursive: true });
    fs.writeFileSync(
      path.join(testRoot, 'skills', 'lin', 'demo', 'SKILL.md'),
      [
        '---',
        'name: demo',
        'description: Demo skill',
        '---',
        '',
        'Use $0 from <SKILL_DIR> with $ARGUMENTS / $1 / $2 / $3.',
      ].join('\n'),
      'utf-8',
    );
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalSkillsEnv === undefined) delete process.env.XIAOBA_SKILLS_DIR;
    else process.env.XIAOBA_SKILLS_DIR = originalSkillsEnv;
    if (originalRuntimeRootEnv === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = originalRuntimeRootEnv;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('returns rendered SKILL.md content instead of activation JSON', async () => {
    const tool = new SkillTool();

    const result = await tool.execute({ skill: 'demo', args: 'alpha beta' }, {} as any);

    assert.equal(result.ok, true);
    assert.equal(typeof result.content, 'string');
    assert.match(String(result.content), /\[skill:demo\]/);
    assert.match(String(result.content), new RegExp(`Skill file: ${escapeRegExp(path.join(testRoot, 'skills', 'lin', 'demo', 'SKILL.md'))}`));
    assert.match(String(result.content), new RegExp(`Skill directory: ${escapeRegExp(path.join(testRoot, 'skills', 'lin', 'demo'))}`));
    assert.match(String(result.content), /Resolve relative paths mentioned in this skill relative to Skill directory\./);
    assert.match(String(result.content), /--- SKILL\.md ---/);
    assert.match(String(result.content), /Use demo from /);
    assert.match(String(result.content), /with alpha beta \/ alpha \/ beta \//);
    assert.doesNotMatch(String(result.content), /skill_activation/);
    assert.doesNotMatch(String(result.content), /\$ARGUMENTS|\$1|\$2|\$3|<SKILL_DIR>/);
  });

  test('reload returns a plain status message', async () => {
    const tool = new SkillTool();

    const result = await tool.execute({ skill: 'reload' }, {} as any);

    assert.equal(result.ok, true);
    assert.match(String(result.content), /已重新加载 3 个 skills/);
    assert.doesNotMatch(String(result.content), /__reload_skills__/);
  });

  test('uses one immutable Skill revision within a turn and observes edits on the next turn', async () => {
    const skillsRoot = path.join(testRoot, 'skills');
    const skillFile = path.join(skillsRoot, 'lin', 'demo', 'SKILL.md');
    const store = new TurnSkillSnapshotStore({ runtimeRoot: testRoot, skillsRoot });
    const firstLease = await store.acquire();
    const firstManager = new SkillManager(firstLease.snapshot.rootPath);
    await firstManager.loadSkills();
    fs.writeFileSync(skillFile, fs.readFileSync(skillFile, 'utf8').replace('Use $0', 'Changed $0'), 'utf8');

    const tool = new SkillTool();
    const firstContext = {
      workingDirectory: testRoot,
      conversationHistory: [],
      runtimeServices: { aiService: {} as any, skillManager: firstManager },
      turnSkillSnapshot: firstLease,
    };
    const first = await tool.execute({ skill: 'demo' }, firstContext);
    const reloaded = await tool.execute({ skill: 'reload' }, firstContext);
    const stillFirst = await tool.execute({ skill: 'demo' }, firstContext);

    assert.equal(first.ok, true);
    assert.equal(reloaded.ok, true);
    assert.match(String(first.content), /Use demo/);
    assert.match(String(stillFirst.content), /Use demo/);
    assert.doesNotMatch(String(stillFirst.content), /Changed demo/);
    await firstLease.release();

    const secondLease = await store.acquire();
    const secondManager = new SkillManager(secondLease.snapshot.rootPath);
    await secondManager.loadSkills();
    const second = await tool.execute({ skill: 'demo' }, {
      ...firstContext,
      runtimeServices: { aiService: {} as any, skillManager: secondManager },
      turnSkillSnapshot: secondLease,
    });
    assert.equal(second.ok, true);
    assert.match(String(second.content), /Changed demo/);
    await secondLease.release();
  });

  test('rejects a revoked Skill from an old turn snapshot without blocking unrelated local skills', async () => {
    const runtimeRoot = path.join(testRoot, 'runtime');
    const skillsRoot = path.join(testRoot, 'skills');
    process.env.XIAOBA_USER_DATA_DIR = runtimeRoot;
    fs.mkdirSync(runtimeRoot, { recursive: true });
    const revokedReference = {
      source: 'skillhub' as const,
      skillId: 'artifact-legacy',
      version: '1.0.0',
      contentHash: 'a'.repeat(64),
    };
    const revokedDir = path.join(skillsRoot, 'lin', 'demo');
    writeBotSkillLocalMarker(revokedDir, {
      schema: 'xiaoba.bot-skill-local.v1',
      localSkillId: 'local-demo',
      reference: revokedReference,
    });
    const store = new TurnSkillSnapshotStore({ runtimeRoot, skillsRoot });
    const oldTurn = await store.acquire();
    const oldManager = new SkillManager(oldTurn.snapshot.rootPath);
    await oldManager.loadSkills();

    const definitions = new FileBotDefinitionRepository({ runtimeRoot });
    definitions.writeCache({
      schema: 'xiaoba.bot-definition.v1',
      botId: 'bot-123',
      model: { kind: 'catalog', modelId: 'minimax-m3' },
      skills: [],
    });
    const tool = new SkillTool();
    const context = {
      workingDirectory: testRoot,
      conversationHistory: [],
      executionScope: { source: 'catscompany', agentId: 'usrbot-123' },
      runtimeServices: { aiService: {} as any, skillManager: oldManager },
      turnSkillSnapshot: oldTurn,
    } as any;

    const revoked = await tool.execute({ skill: 'demo' }, context);
    assert.equal(revoked.ok, false);
    assert.equal(revoked.errorCode, 'PERMISSION_DENIED');
    assert.match(String(revoked.message), /不在当前 BotDefinition/);

    const unmanaged = await tool.execute({ skill: 'xiaoba-knowledge' }, context);
    assert.equal(unmanaged.ok, true);
    await oldTurn.release();
  });

  test('keeps an owner revocation effective until Cloud confirms that reference is gone', () => {
    const runtimeRoot = path.join(testRoot, 'revocation-runtime');
    fs.mkdirSync(runtimeRoot, { recursive: true });
    process.env.XIAOBA_USER_DATA_DIR = runtimeRoot;
    const reference = {
      source: 'skillhub' as const,
      skillId: 'artifact-legacy',
      version: '1.0.0',
      contentHash: 'b'.repeat(64),
    };
    new FileBotDefinitionRepository({ runtimeRoot }).writeCache({
      schema: 'xiaoba.bot-definition.v1',
      botId: 'bot-123',
      model: { kind: 'catalog', modelId: 'minimax-m3' },
      skills: [reference],
    });
    recordPendingBotSkillRevocation('usrbot-123', reference, runtimeRoot);

    assert.equal(isBotSkillReferenceActive('usrbot-123', reference), false);
    reconcilePendingBotSkillRevocations('bot-123', [], runtimeRoot);
    assert.equal(isBotSkillReferenceActive('usrbot-123', reference), true);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
