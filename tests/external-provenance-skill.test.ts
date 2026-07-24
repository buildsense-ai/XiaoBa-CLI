import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';

import { distillCapabilityCandidates } from '../src/utils/capability-distiller';
import type {
  CapabilityProvenanceRef,
  DistilledKnowledgeCandidate,
} from '../src/utils/capability-distiller';
import type { DistillationUnit } from '../src/utils/distillation-unit';
import {
  buildLearningEpisodeCandidate,
  extractLearningEpisodes,
} from '../src/utils/learning-episode';
import type { LearningEpisode } from '../src/utils/learning-episode';
import {
  buildEvidenceCapsule,
  reconstructBundleFromCapsule,
} from '../src/utils/evidence-capsule';

/**
 * Focused tests for the agent-native provenance chain enhancement.
 *
 * Proves that external xurl-derived provenance reaching the learning-episode
 * and distiller pipeline retains and directly exposes provider, thread
 * identity, ordinal range / event position, and content hash — without an
 * HTTP API, Dashboard, new service, or mandatory new CLI command.
 *
 * Also proves existing local/session-log provenance remains compatible
 * (backward compatibility).
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXTERNAL_PROVIDER = 'openai';
const EXTERNAL_THREAD_ID = 'thread-abc123';
const EXTERNAL_CONTENT_HASH = 'sha256:deadbeefcafef00d1234567890abcdef';
const EXTERNAL_BRANCH = 'main';
const EXTERNAL_REVISION = 'rev-001';

/**
 * Build a DistillationUnit that simulates an xurl external source event,
 * carrying structured externalEventProvenance.
 */
function makeExternalDistillationUnit(): DistillationUnit {
  return {
    filePath: `xurl://${EXTERNAL_PROVIDER}/${EXTERNAL_THREAD_ID}`,
    newTurns: [
      {
        entry_type: 'turn',
        turn: 5,
        timestamp: '2026-07-14T10:00:00.000Z',
        session_id: `external:${EXTERNAL_PROVIDER}:${EXTERNAL_THREAD_ID}:${EXTERNAL_BRANCH}`,
        session_type: 'external',
        user: { text: 'Please create a deployment script for the staging environment.' },
        assistant: {
          text: 'I created the deployment script and verified it runs successfully.',
          tool_calls: [],
        },
        tokens: { prompt: 0, completion: 0 },
      },
      {
        entry_type: 'turn',
        turn: 6,
        timestamp: '2026-07-14T10:01:00.000Z',
        session_id: `external:${EXTERNAL_PROVIDER}:${EXTERNAL_THREAD_ID}:${EXTERNAL_BRANCH}`,
        session_type: 'external',
        user: { text: 'Thanks, that worked perfectly!' },
        assistant: {
          text: 'Glad it helped.',
          tool_calls: [],
        },
        tokens: { prompt: 0, completion: 0 },
      },
    ],
    continuityTurns: [],
    byteRange: { start: 3, end: 6 },
    generatedAt: '2026-07-14T10:01:00.000Z',
    externalEventProvenance: {
      provider: EXTERNAL_PROVIDER,
      threadId: EXTERNAL_THREAD_ID,
      contentHash: EXTERNAL_CONTENT_HASH,
      startOrdinal: 3,
      endOrdinal: 6,
      branchId: EXTERNAL_BRANCH,
      revision: EXTERNAL_REVISION,
    },
  };
}

/**
 * Build a local (non-external) DistillationUnit for backward-compat tests.
 */
function makeLocalDistillationUnit(): DistillationUnit {
  return {
    filePath: '/logs/sessions/local/2026-07-14/chat.jsonl',
    newTurns: [
      {
        entry_type: 'turn',
        turn: 5,
        timestamp: '2026-07-14T10:00:00.000Z',
        session_id: 'local-session-1',
        session_type: 'catscompany',
        user: { text: 'Please create a deployment script for the staging environment.' },
        assistant: {
          text: 'I created the deployment script and verified it runs successfully.',
          tool_calls: [{ name: 'write_file', arguments: '{}', result: 'ok' }],
        },
        tokens: { prompt: 100, completion: 50 },
      },
      {
        entry_type: 'turn',
        turn: 6,
        timestamp: '2026-07-14T10:01:00.000Z',
        session_id: 'local-session-1',
        session_type: 'catscompany',
        user: { text: 'Thanks, that worked perfectly!' },
        assistant: {
          text: 'Glad it helped.',
          tool_calls: [],
        },
        tokens: { prompt: 20, completion: 10 },
      },
    ],
    continuityTurns: [],
    byteRange: { start: 1024, end: 4096 },
    generatedAt: '2026-07-14T10:01:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// Tests: distiller propagates external provenance
// ---------------------------------------------------------------------------

describe('External provenance — distiller path', () => {
  test('distillCapabilityCandidates copies external fields to provenance refs', () => {
    const unit = makeExternalDistillationUnit();
    const candidates = distillCapabilityCandidates(unit);

    // Prove the distiller actually exercised at least one candidate.
    assert.ok(candidates.length >= 1, 'distiller should produce at least one candidate for this fixture');
    for (const candidate of candidates) {
      assert.ok(candidate.provenance.length >= 1, 'expected provenance refs');
      for (const ref of candidate.provenance) {
        assert.equal(ref.provider, EXTERNAL_PROVIDER, 'provenance ref should expose provider');
        assert.equal(ref.threadId, EXTERNAL_THREAD_ID, 'provenance ref should expose threadId');
        assert.equal(ref.contentHash, EXTERNAL_CONTENT_HASH, 'provenance ref should expose contentHash');
        assert.equal(ref.startOrdinal, 3, 'provenance ref should expose startOrdinal');
        assert.equal(ref.endOrdinal, 6, 'provenance ref should expose endOrdinal');
      }
    }
  });

  test('local distillation does not populate external provenance fields', () => {
    const unit = makeLocalDistillationUnit();
    const candidates = distillCapabilityCandidates(unit);

    // Prove the distiller actually exercised at least one candidate.
    assert.ok(candidates.length >= 1, 'distiller should produce at least one candidate for this fixture');
    for (const candidate of candidates) {
      for (const ref of candidate.provenance) {
        assert.equal(ref.provider, undefined, 'local provenance should not have provider');
        assert.equal(ref.threadId, undefined, 'local provenance should not have threadId');
        assert.equal(ref.contentHash, undefined, 'local provenance should not have contentHash');
        assert.equal(ref.startOrdinal, undefined, 'local provenance should not have startOrdinal');
        assert.equal(ref.endOrdinal, undefined, 'local provenance should not have endOrdinal');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: learning episode path propagates external provenance
// ---------------------------------------------------------------------------

describe('External provenance — learning episode path', () => {
  test('does not admit external progress narration as a completed delivery', () => {
    const unit = makeExternalDistillationUnit();
    unit.newTurns = [{
      ...unit.newTurns[0]!,
      user: { text: 'Fix the scheduler regression.' },
      assistant: {
        text: 'Exploring the codebase now. Let me add the test next.',
        tool_calls: [],
      },
    }];

    assert.equal(extractLearningEpisodes(unit).episodes.length, 0);
  });

  test('does not mint a capability from a context-free external continuation', () => {
    const unit = makeExternalDistillationUnit();
    unit.newTurns = [{
      ...unit.newTurns[0]!,
      user: { text: 'yes, go on continue' },
      assistant: {
        text: 'Implementation completed. All 52 tests passed.',
        tool_calls: [],
      },
    }];

    assert.equal(extractLearningEpisodes(unit).episodes.length, 0);
  });

  test('preserves the terminal outcome when bounding long external evidence', () => {
    const unit = makeExternalDistillationUnit();
    unit.newTurns = [{
      ...unit.newTurns[0]!,
      user: { text: 'Fix the scheduler regression.' },
      assistant: {
        text: `${'Investigating the scheduler. '.repeat(100)}\nFixed the wake gate. All 52 tests passed.`,
        tool_calls: [],
      },
    }];

    const episode = extractLearningEpisodes(unit).episodes[0];
    assert.ok(episode);
    const response = episode.completionEvidence.find(item => item.kind === 'assistant-response');
    assert.match(response?.detail ?? '', /omitted from middle/);
    assert.match(response?.detail ?? '', /All 52 tests passed\./);
    assert.ok(Buffer.byteLength(response?.detail ?? '', 'utf8') <= 1_100);
  });

  test('extractLearningEpisodes carries externalEventProvenance on episodes', () => {
    const unit = makeExternalDistillationUnit();
    const result = extractLearningEpisodes(unit);

    // Prove the extractor actually exercised at least one episode.
    assert.ok(result.episodes.length >= 1, 'extractor should produce at least one episode for this fixture');
    for (const episode of result.episodes) {
      assert.ok(
        episode.externalEventProvenance,
        'episode from external unit should carry externalEventProvenance',
      );
      assert.equal(
        episode.externalEventProvenance!.provider,
        EXTERNAL_PROVIDER,
      );
      assert.equal(
        episode.externalEventProvenance!.threadId,
        EXTERNAL_THREAD_ID,
      );
      assert.equal(
        episode.externalEventProvenance!.contentHash,
        EXTERNAL_CONTENT_HASH,
      );
    }
  });

  test('buildLearningEpisodeCandidate propagates external fields to provenance refs', () => {
    const unit = makeExternalDistillationUnit();
    const result = extractLearningEpisodes(unit);
    const episode = result.episodes[0];
    assert.ok(episode, 'expected at least one episode');

    const candidate = buildLearningEpisodeCandidate(episode, unit);
    assert.ok(candidate.provenance.length >= 1, 'expected provenance refs');
    for (const ref of candidate.provenance) {
      assert.equal(ref.provider, EXTERNAL_PROVIDER, 'candidate provenance should expose provider');
      assert.equal(ref.threadId, EXTERNAL_THREAD_ID, 'candidate provenance should expose threadId');
      assert.equal(ref.contentHash, EXTERNAL_CONTENT_HASH, 'candidate provenance should expose contentHash');
      assert.equal(ref.startOrdinal, 3, 'candidate provenance should expose startOrdinal');
      assert.equal(ref.endOrdinal, 6, 'candidate provenance should expose endOrdinal');
    }
  });

  test('local episodes do not populate external provenance fields', () => {
    const unit = makeLocalDistillationUnit();
    const result = extractLearningEpisodes(unit);
    // Prove the extractor actually exercised at least one episode.
    assert.ok(result.episodes.length >= 1, 'extractor should produce at least one episode for this fixture');
    for (const episode of result.episodes) {
      assert.equal(
        episode.externalEventProvenance,
        undefined,
        'local episode should not carry externalEventProvenance',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Evidence Capsule preserves external identity through round-trip
// ---------------------------------------------------------------------------

describe('External provenance — Evidence Capsule round-trip', () => {
  test('reconstructBundleFromCapsule propagates external identity to provenance refs', () => {
    const capsule = buildEvidenceCapsule({
      sourceIdentity: {
        sourceId: 'xurl-source-1',
        label: 'External Source (openai)',
        category: 'external',
        provider: EXTERNAL_PROVIDER,
        reader: 'xurl',
      },
      eventIdentity: {
        eventId: `agents://${EXTERNAL_PROVIDER}/${EXTERNAL_THREAD_ID}#3-6`,
        position: 6,
        contentHash: EXTERNAL_CONTENT_HASH,
        conversationId: EXTERNAL_THREAD_ID,
        branchId: EXTERNAL_BRANCH,
        revision: EXTERNAL_REVISION,
      },
      episodeId: 'episode-capsule-test-001',
      bundleId: 'v3:learning-episode:episode-capsule-test-001',
      completionEvidence: [
        {
          ref: `xurl://${EXTERNAL_PROVIDER}/${EXTERNAL_THREAD_ID}#5:problem-action`,
          content: 'User asked to deploy to staging.',
          role: 'problem-action',
          sourceFilePath: `xurl://${EXTERNAL_PROVIDER}/${EXTERNAL_THREAD_ID}`,
          turn: 5,
          byteRange: { start: 3, end: 5 },
        },
      ],
      settlementEvidence: [
        {
          ref: `xurl://${EXTERNAL_PROVIDER}/${EXTERNAL_THREAD_ID}#6:verification`,
          content: 'User confirmed it worked.',
          role: 'verification',
          sourceFilePath: `xurl://${EXTERNAL_PROVIDER}/${EXTERNAL_THREAD_ID}`,
          turn: 6,
          byteRange: { start: 3, end: 6 },
        },
      ],
      semanticObservations: [],
      now: new Date('2026-07-15T12:00:00.000Z'),
    });

    const bundle = reconstructBundleFromCapsule(capsule, [], []);

    assert.ok(bundle.episode.provenance.length >= 1, 'expected provenance refs');
    for (const ref of bundle.episode.provenance) {
      assert.equal(ref.provider, EXTERNAL_PROVIDER, 'capsule reconstruction should expose provider');
      assert.equal(ref.threadId, EXTERNAL_THREAD_ID, 'capsule reconstruction should expose threadId');
      assert.equal(ref.contentHash, EXTERNAL_CONTENT_HASH, 'capsule reconstruction should expose contentHash');
    }
  });
});
