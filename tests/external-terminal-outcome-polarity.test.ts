import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';

import { extractLearningEpisodes } from '../src/utils/learning-episode';
import type {
  DistillationUnit,
  DistillationTurn,
} from '../src/utils/distillation-unit';

/**
 * Progressive Trust regression (root cause #6): external terminal-outcome
 * polarity / continuation.
 *
 * External Session Log Sources (xURL/Pi) coalesce a complete User→final-
 * Assistant event with empty tool_calls. `isExternalCompleteFinalDelivery`
 * gates whether that external event may seed a Learning Episode on the
 * assistant tail alone. A review that says the package is NOT OK must not be
 * treated as a successful final artifact merely because its tail contains
 * positive validation words such as "verified" or "tests pass". If subsequent
 * corrected outcome evidence exists in the same rendered timeline, the
 * existing episode semantics (not manufactured success) must carry it.
 *
 * Public seam under test: `extractLearningEpisodes` over an external
 * DistillationUnit, observing whether a delivery episode is admitted.
 */

const PROVIDER = 'openai';
const THREAD_ID = 'thread-terminal-polarity-001';
const SOURCE_FILE = `xurl://${PROVIDER}/${THREAD_ID}`;
const NOW_ISO = '2026-07-15T12:00:00.000Z';

function externalUnit(assistantTail: string, userText = 'Please review the package and apply the VS Code exclusion.'): DistillationUnit {
  const fullAssistant = [
    'I inspected the Brewfile and the current install state.',
    'Here is the outcome of my review.',
    assistantTail,
  ].join('\n');
  const turn: DistillationTurn = {
    entry_type: 'turn',
    turn: 6,
    timestamp: NOW_ISO,
    session_id: `external:${PROVIDER}:${THREAD_ID}`,
    session_type: 'external',
    user: { text: userText },
    assistant: {
      text: fullAssistant,
      tool_calls: [],
    },
    tokens: { prompt: 0, completion: 0 },
  };
  return {
    filePath: SOURCE_FILE,
    newTurns: [turn],
    continuityTurns: [],
    byteRange: { start: 5, end: 6 },
    generatedAt: NOW_ISO,
    externalEventProvenance: {
      provider: PROVIDER,
      threadId: THREAD_ID,
      contentHash: 'sha256:polarity-test',
      startOrdinal: 5,
      endOrdinal: 6,
    },
  };
}

function episodeAssistantEvidence(unit: DistillationUnit) {
  const { episodes } = extractLearningEpisodes(unit, 3 * 60 * 60 * 1000);
  return episodes.flatMap(ep => ep.completionEvidence.filter(e => e.kind === 'assistant-response'));
}

describe('External terminal-outcome polarity (RC #6)', () => {
  test('a substantive final without success keywords remains a review candidate', () => {
    const unit = externalUnit(
      'Here is the requested report with the package findings and the recommended exclusion.',
    );
    const evidence = episodeAssistantEvidence(unit);
    assert.ok(evidence.length > 0, 'absence of a success keyword is not a definite reason to discard evidence');
  });

  test('a context-free continuation does not seed an external episode', () => {
    const unit = externalUnit('Here is the next part of the discussion.', 'continue');
    const evidence = episodeAssistantEvidence(unit);
    assert.equal(evidence.length, 0);
  });

  test('an explicit unfinished progress tail does not seed an external episode', () => {
    const unit = externalUnit('Exploring the codebase now. Let me add the regression test next.');
    const evidence = episodeAssistantEvidence(unit);
    assert.equal(evidence.length, 0);
  });

  test('earlier progress does not erase a later substantive final', () => {
    const unit = externalUnit(
      'I am investigating the package first. Here is the requested report with the findings and recommended exclusion.',
    );
    const evidence = episodeAssistantEvidence(unit);
    assert.ok(evidence.length > 0);
  });

  test('a genuinely successful outcome tail admits an external episode', () => {
    const unit = externalUnit(
      'Removed the VS Code cask and 19 extensions, ran `brew bundle`, and all checks passed. The package is OK and ready.',
    );
    const evidence = episodeAssistantEvidence(unit);
    assert.ok(evidence.length > 0, 'a positive terminal outcome should admit an external episode');
  });

  test('a negative review tail is NOT treated as success despite containing "verified"/"tests"', () => {
    const unit = externalUnit(
      'The package is NOT OK. The brew bundle check did not pass: these tests fail. I verified the failure is still present. Fix these issues before shipping.',
    );
    const evidence = episodeAssistantEvidence(unit);
    assert.equal(
      evidence.length,
      0,
      `a negative review must not be manufactured as a successful external episode; got ${JSON.stringify(evidence)}`,
    );
  });

  test('an explicitly negated outcome ("not verified", "did not pass") is not success', () => {
    const unit = externalUnit(
      'I attempted the exclusion but it was not verified and the validation did not pass; the cask is still present.',
    );
    const evidence = episodeAssistantEvidence(unit);
    assert.equal(evidence.length, 0, 'negated validation must not count as a successful final');
  });

  test('Chinese explicit failure tails are vetoed', () => {
    for (const tail of [
      '测试失败，暂时无法完成交付。',
      '验证失败，遇到错误，无法完成。',
      '实现过程中发生错误，尚未完成。',
    ]) {
      const evidence = episodeAssistantEvidence(externalUnit(tail));
      assert.equal(evidence.length, 0, `explicit Chinese failure must veto admission: ${tail}`);
    }
  });

  test('Chinese failure followed by a final success remains order-sensitive', () => {
    const evidence = episodeAssistantEvidence(externalUnit(
      '第一次测试失败，随后修复了配置，最终测试通过，已经完成交付。',
    ));
    assert.ok(evidence.length > 0, 'a later explicit success should clear an earlier failure');
  });

  test('negative-then-corrected: last positive outcome wins (order-sensitive)', () => {
    // Verified: the last decisive terminal outcome determines polarity.
    const unit = externalUnit(
      'The initial fix didn\'t work and tests failed. I then updated the config and now all tests pass successfully.',
    );
    const evidence = episodeAssistantEvidence(unit);
    assert.ok(
      evidence.length > 0,
      `corrected outcome with last positive should admit; got ${JSON.stringify(evidence.map(e => e.detail))}`,
    );
  });

  test('positive-then-final-blocker: last negative outcome wins (order-sensitive)', () => {
    // Verified: "blocker" is terminal negative, positioned last → rejects.
    // After fix: "blocker" is terminal negative, positioned last → rejects.
    const unit = externalUnit(
      'I have implemented the VS Code exclusion as requested, but security review found a blocker that must be addressed before shipping.',
    );
    const evidence = episodeAssistantEvidence(unit);
    assert.equal(
      evidence.length,
      0,
      `terminal blocker after positive implementation must reject; got ${JSON.stringify(evidence.map(e => e.detail))}`,
    );
  });
});
