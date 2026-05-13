import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillTool } from '../src/tools/skill-tool';

describe('skill tool direct content mode', () => {
  let testRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skill-tool-'));
    process.chdir(testRoot);
    fs.mkdirSync(path.join(testRoot, 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(
      path.join(testRoot, 'skills', 'demo', 'SKILL.md'),
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
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('returns rendered SKILL.md content instead of activation JSON', async () => {
    const tool = new SkillTool();

    const result = await tool.execute({ skill: 'demo', args: 'alpha beta' }, {} as any);

    assert.equal(result.ok, true);
    assert.equal(typeof result.content, 'string');
    assert.match(String(result.content), /\[skill:demo\]/);
    assert.match(String(result.content), new RegExp(`Skill file: ${escapeRegExp(path.join(testRoot, 'skills', 'demo', 'SKILL.md'))}`));
    assert.match(String(result.content), new RegExp(`Skill directory: ${escapeRegExp(path.join(testRoot, 'skills', 'demo'))}`));
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
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
