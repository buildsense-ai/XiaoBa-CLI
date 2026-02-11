import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillManager } from '../src/skills/skill-manager';
import { Skill } from '../src/types/skill';

function buildSkill(name: string, autoInvocable: boolean = true): Skill {
  return {
    metadata: {
      name,
      description: `${name} description`,
      autoInvocable,
      userInvocable: true,
    },
    content: `# ${name}`,
    filePath: `skills/${name}/SKILL.md`,
  };
}

test('auto skill matching requires explicit skill mention', () => {
  const manager = new SkillManager();
  (manager as any).skills = new Map<string, Skill>([
    ['paper-analysis', buildSkill('paper-analysis')],
  ]);

  const matched = manager.findAutoInvocableSkillByText('please use paper-analysis for this pdf');
  assert.equal(matched?.metadata.name, 'paper-analysis');

  const notMatched = manager.findAutoInvocableSkillByText('please analyze this pdf for me');
  assert.equal(notMatched, undefined);
});

test('auto skill matching ignores non-autoInvocable skills', () => {
  const manager = new SkillManager();
  (manager as any).skills = new Map<string, Skill>([
    ['paper-analysis', buildSkill('paper-analysis', false)],
  ]);

  const matched = manager.findAutoInvocableSkillByText('paper-analysis this file');
  assert.equal(matched, undefined);
});

test('auto skill matching prefers longer more specific skill name', () => {
  const manager = new SkillManager();
  (manager as any).skills = new Map<string, Skill>([
    ['paper', buildSkill('paper')],
    ['paper-analysis', buildSkill('paper-analysis')],
  ]);

  const matched = manager.findAutoInvocableSkillByText('we should run paper-analysis today');
  assert.equal(matched?.metadata.name, 'paper-analysis');
});
