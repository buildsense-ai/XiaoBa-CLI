import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { SessionSkillRuntime } from '../src/skills/session-skill-runtime';
import type { Skill } from '../src/types/skill';

describe('SessionSkillRuntime', () => {
  test('builds transient skills list without embedding skill content', () => {
    const runtime = new SessionSkillRuntime(buildSkillManager({
      userInvocableSkills: [
        buildSkill('demo', 'Demo skill'),
      ],
    }) as any, 'session-demo');

    const message = runtime.buildSkillsListMessage();

    assert.ok(message);
    assert.equal(message.role, 'system');
    assert.match(String(message.content), /^\[transient_skills_list\]/);
    assert.match(String(message.content), /demo: Demo skill/);
    assert.doesNotMatch(String(message.content), /Skill prompt for demo/);
    assert.match(String(message.content), /skill 工具/);
  });

  test('lists skills as names only for slash skills command', () => {
    const runtime = new SessionSkillRuntime(buildSkillManager({
      skills: {
        demo: buildSkill('demo', 'Demo skill', { argumentHint: '<topic>' }),
      },
    }) as any, 'session-demo');

    const result = runtime.handleSkillsCommand();

    assert.equal(result.handled, true);
    assert.match(result.reply ?? '', /demo <topic>/);
    assert.match(result.reply ?? '', /Demo skill/);
    assert.doesNotMatch(result.reply ?? '', /Skill prompt for demo/);
  });
});

function buildSkill(
  name: string,
  description: string,
  metadata: Partial<Skill['metadata']> = {},
): Skill {
  return {
    metadata: {
      name,
      description,
      userInvocable: true,
      ...metadata,
    },
    content: `Skill prompt for ${name}`,
    filePath: `/tmp/${name}/SKILL.md`,
  };
}

function buildSkillManager(options: {
  skills?: Record<string, Skill>;
  userInvocableSkills?: Skill[];
} = {}): any {
  return {
    async loadSkills() {},
    getUserInvocableSkills() {
      return options.userInvocableSkills ?? Object.values(options.skills ?? {});
    },
  };
}
