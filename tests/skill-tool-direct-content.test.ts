import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillTool } from '../src/tools/skill-tool';
import { SkillManager } from '../src/skills/skill-manager';
import { TurnSkillSnapshotStore } from '../src/skills/turn-skill-snapshot';

describe('skill tool direct content mode', () => {
  let testRoot: string;
  let originalCwd: string;
  let originalSkillsEnv: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalSkillsEnv = process.env.XIAOBA_SKILLS_DIR;
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
    assert.match(String(result.content), /已重新加载 1 个 skills/);
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
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
