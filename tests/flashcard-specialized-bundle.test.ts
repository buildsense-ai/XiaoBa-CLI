import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildFlashcardEvidenceBundle } from '../src/utils/learning-episode';
import type { LearningEpisode, EpisodeEvidenceRef } from '../src/utils/learning-episode';
import type { ReferencedSkillSnapshot } from '../src/utils/skill-evolution';

/**
 * Progressive Trust: the explicit flashcard bundle may continue to declare a
 * known dependency when its evidence contract verifies it. The
 * flashcard composition adapter explicitly pins `word-card-maker`. Ordinary
 * bundle construction no longer copies the complete Skill catalog into
 * referencedSkills, but this flashcard bundle is built directly and must be
 * preserved unchanged.
 */

function makeFlashcardEpisode(): LearningEpisode {
  const completionEvidence: EpisodeEvidenceRef[] = [
    { ref: 'session.jsonl#12:artifact-delivery', sourceFilePath: 'session.jsonl', turn: 12, kind: 'artifact-delivery' },
    { ref: 'session.jsonl#13:artifact-validation', sourceFilePath: 'session.jsonl', turn: 13, kind: 'artifact-validation' },
    { ref: 'session.jsonl#14:user-acceptance', sourceFilePath: 'session.jsonl', turn: 14, kind: 'user-acceptance' },
  ];
  return {
    schemaVersion: 3 as any,
    episodeId: 'episode-flashcard-specialized',
    runtimeSessionId: 'sess-1',
    sourceFilePath: 'session.jsonl',
    deliveryTurn: 14,
    completionEvidence,
    contradictionSignals: [],
    semanticObservations: [],
    settlementDeadline: '2026-01-01T00:00:00.000Z',
    status: 'eligible',
    retryOfEpisodeId: 'episode-flashcard-predecessor',
  } as LearningEpisode;
}

describe('flashcard bundle preservation (progressive trust)', () => {
  test('buildFlashcardEvidenceBundle explicitly pins word-card-maker in referencedSkills', () => {
    const referencedSkill: ReferencedSkillSnapshot = {
      name: 'word-card-maker',
      version: '1.0.0',
      contentFingerprint: 'word-card-v1',
    };
    const bundle = buildFlashcardEvidenceBundle(
      makeFlashcardEpisode(),
      referencedSkill,
    );

    // The flashcard bundle declares its known dependency directly; ordinary
    // catalog-exclusion rules do not strip it.
    assert.equal(bundle.referencedSkills.length, 1);
    assert.equal(bundle.referencedSkills[0]!.name, 'word-card-maker');
    assert.equal(bundle.referencedSkills[0]!.version, '1.0.0');
    // relatedCurrentSkills is intentionally empty for this flashcard bundle.
    assert.deepEqual(bundle.relatedCurrentSkills, []);
    assert.equal(bundle.bundleId, 'flashcard-episode-flashcard-specialized');
    assert.deepEqual(bundle.authority, {
      kind: 'flashcard',
      episodeId: 'episode-flashcard-specialized',
    });
  });

  test('buildFlashcardEvidenceBundle requires validated delivery, validation, and acceptance evidence', () => {
    const referencedSkill: ReferencedSkillSnapshot = { name: 'word-card-maker' };
    // Episode missing artifact-validation evidence.
    const episode = makeFlashcardEpisode();
    episode.completionEvidence = episode.completionEvidence.filter(
      evidence => evidence.kind !== 'artifact-validation',
    );
    assert.throws(
      () => buildFlashcardEvidenceBundle(episode, referencedSkill),
      /Flashcard evidence bundle requires validation, delivery, and acceptance evidence\./,
    );
  });
});
