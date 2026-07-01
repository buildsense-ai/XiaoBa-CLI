import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPetEvent,
  createDefaultProfile,
  getLevelInfo,
  normalizePetEvent,
  PET_LEVEL_RULES,
} from '../src/pet/pet-growth-engine';

test('pet level rules extend the companion progression to level 10', () => {
  assert.deepEqual(PET_LEVEL_RULES.map(rule => rule.level), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(getLevelInfo(0).level, 1);
  assert.equal(getLevelInfo(700).level, 5);
  assert.equal(getLevelInfo(4500).level, 10);
  assert.equal(PET_LEVEL_RULES.at(-1)?.title, '高级伙伴');
});

test('message completion is activity, not meaningful growth', () => {
  const data = {
    profile: createDefaultProfile(),
    events: [],
    skill_stats: [],
  };
  const event = normalizePetEvent({
    event_type: 'message_completed',
    session_id: 'chat:noise',
  });

  assert.equal(event.xp_delta, 0);

  applyPetEvent(data, event);

  assert.equal(data.profile.total_xp, 0);
  assert.equal(data.profile.level, 1);
});

test('meaningful task completion can still advance companion growth', () => {
  const data = {
    profile: createDefaultProfile(),
    events: [],
    skill_stats: [],
  };
  const event = normalizePetEvent({
    event_type: 'task_completed',
    session_id: 'chat:meaningful-work',
  });

  assert.equal(event.xp_delta > 0, true);

  applyPetEvent(data, event);

  assert.equal(data.profile.total_xp, event.xp_delta);
});
