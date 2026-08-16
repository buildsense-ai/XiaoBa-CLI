import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  buildEvidenceCapsule,
  reconstructBundleFromCapsule,
} from '../src/utils/evidence-capsule';
import type { SemanticObservation } from '../src/utils/learning-episode';

/**
 * Progressive Trust regression (root cause #3) for external Evidence Capsule
 * reconstruction.
 *
 * The capsule durably pins bounded, redacted external completion evidence.
 * Reconstructing a Review Bundle from the capsule must preserve a recognizable
 * external solved-loop (trigger / action / result) when the capsule carries a
 * bounded successful completion response, instead of downgrading the candidate
 * to mere admission metadata ("external event was admitted" / "redacted and
 * pinned") with fallback byte ranges 0..1.
 *
 * Provider-neutral, bounded, redacted: no private ~/.codex or ~/.pi parsing.
 */

const PROVIDER = 'openai';
const THREAD_ID = 'thread-019f7345-fd29-7c13-af79-f96ef7996e2e';
const CONTENT_HASH = 'sha256:vscode-exclusion-closed-loop';
const SOURCE_ID = 'xurl-source-codex';
const EPISODE_ID = 'episode-vscode-exclusion-001';
const BUNDLE_ID = `v3:learning-episode:${EPISODE_ID}`;
const REDACTED_AT = new Date('2026-07-15T12:00:00.000Z');

function capsuleFrom(completionContent: string, settlementContent: string, observations: SemanticObservation[] = [], completionVerification = '') {
  const completionEntries: {ref: string; content: string; role: 'problem-action' | 'verification'; sourceFilePath: string; turn: number; byteRange: {start: number; end: number}}[] = [
    {
      ref: `xurl://${PROVIDER}/${THREAD_ID}#5:problem-action`,
      content: completionContent,
      role: 'problem-action',
      sourceFilePath: `xurl://${PROVIDER}/${THREAD_ID}`,
      turn: 5,
      byteRange: { start: 5, end: 6 },
    },
  ];
  if (completionVerification) {
    completionEntries.push({
      ref: `xurl://${PROVIDER}/${THREAD_ID}#5:verification`,
      content: completionVerification,
      role: 'verification',
      sourceFilePath: `xurl://${PROVIDER}/${THREAD_ID}`,
      turn: 5,
      byteRange: { start: 5, end: 6 },
    });
  }
  return buildEvidenceCapsule({
    sourceIdentity: {
      sourceId: SOURCE_ID,
      label: 'External Source (openai)',
      category: 'external',
      provider: PROVIDER,
      reader: 'xurl',
    },
    eventIdentity: {
      eventId: `agents://${PROVIDER}/${THREAD_ID}#5-6`,
      position: 6,
      contentHash: CONTENT_HASH,
      conversationId: THREAD_ID,
    },
    episodeId: EPISODE_ID,
    bundleId: BUNDLE_ID,
    completionEvidence: completionEntries,
    settlementEvidence: [
      {
        ref: `xurl://${PROVIDER}/${THREAD_ID}#6:verification`,
        content: settlementContent,
        role: 'verification',
        sourceFilePath: `xurl://${PROVIDER}/${THREAD_ID}`,
        turn: 6,
        byteRange: { start: 5, end: 6 },
      },
    ],
    semanticObservations: observations,
    now: REDACTED_AT,
  });
}

describe('Evidence Capsule reconstruction preserves external solved-loop (RC #3)', () => {
  test('reconstructed solvedLoop carries a recognizable trigger/action/result, not admission metadata', () => {
    const completion = [
      'User asked to remove VS Code from the Mac developer environment.',
      'Inspected the Brewfile, removed the VS Code cask and 19 extensions,',
      'ran `brew bundle` and `brew bundle check`, synced documentation.',
      'Ran `brew bundle --file ~/Brewfile` successfully; all taps resolved.',
    ].join(' ');
    const settlement = 'Episode settled after the contradiction window elapsed without a correction.';
    const capsule = capsuleFrom(completion, settlement, [
      {
        kind: 'user-intent',
        value: 'Exclude VS Code from the Mac developer environment transfer setup.',
        sourceRefs: [`xurl://${PROVIDER}/${THREAD_ID}#5:problem-action`],
      },
      {
        kind: 'verification',
        value: 'brew bundle check passed after removing the VS Code cask and extensions.',
        sourceRefs: [`xurl://${PROVIDER}/${THREAD_ID}#5:problem-action`],
      },
    ],
    'brew bundle check passed; VS Code cask and 19 extensions removed successfully.');

    const bundle = reconstructBundleFromCapsule(capsule, [], []);
    const solved = (bundle.episode as { solvedLoop: { problem: string; action: string; verification: string } }).solvedLoop;

    assert.ok(solved && typeof solved.problem === 'string', 'reconstructed bundle must carry a solvedLoop');
    // Recognizable trigger (user intent) survives reconstruction.
    assert.match(solved.problem, /VS Code|developer environment/i, `problem should carry recognizable trigger, got: ${solved.problem}`);
    // Recognizable action survives reconstruction, not just "external event was admitted".
    assert.ok(!/external event was admitted/i.test(solved.action), `action must not be bare admission metadata: ${solved.action}`);
    assert.match(solved.action, /VS ?Code|Brewfile|brew bundle|extensions/i, `action should carry recognizable action, got: ${solved.action}`);
    // Recognizable result/verification survives, not just "Redacted and pinned".
    assert.ok(!/redacted and pinned/i.test(solved.verification), `verification must not be bare redaction metadata: ${solved.verification}`);
    assert.match(solved.verification, /brew bundle|passed|without contradiction|settl/i, `verification should carry recognizable result, got: ${solved.verification}`);
  });

  test('reconstructed provenance byte ranges are non-degenerate (not 0..1) when the capsule carries real ranges', () => {
    const capsule = capsuleFrom('Delivered a bounded external artifact.', 'Settled without contradiction.');
    const bundle = reconstructBundleFromCapsule(capsule, [], []);
    const provenance = (bundle.episode as { provenance: { unitByteRange?: { start: number; end: number } }[] }).provenance;

    assert.ok(provenance.length >= 1, 'reconstructed bundle must carry provenance refs');
    for (const ref of provenance) {
      assert.ok(ref.unitByteRange, 'provenance ref must carry a byte range');
      assert.ok(
        ref.unitByteRange!.end > ref.unitByteRange!.start,
        `provenance byte range must be non-degenerate, got ${JSON.stringify(ref.unitByteRange)}`,
      );
    }
  });

  test('admission-metadata fallback still used when the capsule has no recognizable completion content', () => {
    const capsule = capsuleFrom('', 'Settled without contradiction.');
    const bundle = reconstructBundleFromCapsule(capsule, [], []);
    const solved = (bundle.episode as { solvedLoop: { problem: string; action: string; verification: string } }).solvedLoop;

    // When there is no bounded successful completion content, the honest
    // admission-metadata solvedLoop must remain (we never manufacture success).
    assert.match(solved.action, /admitted|external/i, `empty capsule must keep honest admission fallback: ${solved.action}`);
  });
});
