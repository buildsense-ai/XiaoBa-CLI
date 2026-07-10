import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillTool } from '../src/tools/skill-tool';
import { loadSkillUsageLedger, SkillUsageLedger } from '../src/utils/skill-usage-ledger';

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

  test('records a successful generated Current Skill load but excludes manual skills', async () => {
    const generatedFile = path.join(testRoot, 'skills', 'generated-distilled', 'cap_generated', 'SKILL.md');
    fs.mkdirSync(path.dirname(generatedFile), { recursive: true });
    fs.writeFileSync(generatedFile, [
      '---',
      'name: generated-demo',
      'description: Generated demo skill',
      '---',
      '',
      'Generated guidance.',
    ].join('\n'), 'utf-8');

    const tool = new SkillTool();
    const generatedResult = await tool.execute(
      { skill: 'generated-demo' },
      { sessionId: 'runtime-1', conversationHistory: [{ __episodeId: 'episode-1' }] } as any,
    );
    assert.equal(generatedResult.ok, true);

    const manualResult = await tool.execute(
      { skill: 'demo' },
      { sessionId: 'runtime-1', episodeId: 'episode-1', conversationHistory: [] } as any,
    );
    assert.equal(manualResult.ok, true);

    const ledger = loadSkillUsageLedger(path.join(testRoot, 'data', 'skill-usage-ledger.json'));
    assert.equal(ledger.loads.length, 1);
    assert.equal(ledger.loads[0]!.skillName, 'generated-demo');
    assert.equal(ledger.loads[0]!.episodeId, 'episode-1');
    assert.equal(ledger.loads[0]!.capabilityHandle, 'cap_generated');
    assert.equal(Object.hasOwn(ledger.loads[0]!, 'caused'), false);

    const usageLedger = new SkillUsageLedger(
      path.join(testRoot, 'data', 'skill-usage-ledger.json'),
      path.join(testRoot, 'skills', 'generated-distilled'),
    );
    usageLedger.recordSameEpisodeOutcome({
      loadFactId: ledger.loads[0]!.factId,
      episodeId: 'episode-1',
      outcome: 'verified_success',
      evidenceRefs: ['session.jsonl#1:acceptance'],
    });
    assert.equal(loadSkillUsageLedger(path.join(testRoot, 'data', 'skill-usage-ledger.json')).outcomes[0]!.episodeId, 'episode-1');
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
