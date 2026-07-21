import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
  renderDistilledSkillMarkdown,
} from '../src/utils/distilled-skill-installer';
import type { PromotionReviewResult } from '../src/utils/promotion-reviewer';
import {
  buildEvidenceCapsule,
  reconstructBundleFromCapsule,
} from '../src/utils/evidence-capsule';
// parseProvenanceRefs is exported as a legitimate module API: it is the pure
// parser used internally by the legacy bootstrap path to extract provenance
// refs from rendered skill Markdown. Testing it directly is the smallest
// honest seam for verifying backward-compatible regex changes (ordinal
// range label) without standing up a full generated-skills directory.
import { parseProvenanceRefs } from '../src/utils/distilled-skill-bootstrap';
import { XurlExternalBackfillSource } from '../src/utils/xurl-session-log-source';
import type { ExternalSessionLogBackfillReadResult } from '../src/utils/xurl-session-log-source';

/**
 * Focused tests for the agent-native provenance chain enhancement.
 *
 * Proves that external xurl-derived provenance reaching a generated Skill
 * retains and directly exposes provider, thread identity, ordinal range /
 * event position, and content hash — without an HTTP API, Dashboard, new
 * service, or mandatory new CLI command.
 *
 * Also proves existing local/session-log provenance rendering remains
 * compatible (backward compatibility).
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXTERNAL_PROVIDER = 'openai';
const EXTERNAL_THREAD_ID = 'thread-abc123';
const EXTERNAL_CONTENT_HASH = 'sha256:deadbeefcafef00d1234567890abcdef';
const EXTERNAL_BRANCH = 'main';
const EXTERNAL_REVISION = 'rev-001';

function makePromotionReview(
  candidate: DistilledKnowledgeCandidate,
  decision: 'promote' | 'new_capability' = 'promote',
): PromotionReviewResult {
  return {
    schemaVersion: 1,
    capabilityId: candidate.capabilityId,
    decision,
    rationale: 'Test promotion for provenance verification.',
    reviewRisks: [],
    rewrite: null,
    reviewedAt: '2026-07-15T12:00:00.000Z',
  };
}

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
      const candidate = buildLearningEpisodeCandidate(episode, unit);
      for (const ref of candidate.provenance) {
        assert.equal(ref.provider, undefined);
        assert.equal(ref.threadId, undefined);
        assert.equal(ref.contentHash, undefined);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: rendered Skill exposes external provenance
// ---------------------------------------------------------------------------

describe('External provenance — rendered Skill', () => {
  test('renderDistilledSkillMarkdown exposes provider, thread, ordinal range, and content hash', () => {
    // Build a candidate with external provenance refs directly.
    const candidate: DistilledKnowledgeCandidate = {
      schemaVersion: 1,
      kind: 'capability',
      capabilityId: 'cap-external-test-001',
      title: 'Deploy to staging',
      applicability: 'When deploying to staging.',
      actionPattern: 'Run the deployment script.',
      boundaries: ['Only for staging.'],
      risks: ['Single observation.'],
      solvedLoop: {
        problem: 'Deploy to staging',
        action: 'Ran deployment script',
        verification: 'User confirmed it worked',
        noCorrection: 'No correction markers.',
      },
      provenance: [
        {
          filePath: `xurl://${EXTERNAL_PROVIDER}/${EXTERNAL_THREAD_ID}`,
          turn: 5,
          role: 'problem-action',
          unitByteRange: { start: 3, end: 5 },
          provider: EXTERNAL_PROVIDER,
          threadId: EXTERNAL_THREAD_ID,
          contentHash: EXTERNAL_CONTENT_HASH,
          startOrdinal: 3,
          endOrdinal: 5,
        },
        {
          filePath: `xurl://${EXTERNAL_PROVIDER}/${EXTERNAL_THREAD_ID}`,
          turn: 6,
          role: 'verification',
          unitByteRange: { start: 3, end: 6 },
          provider: EXTERNAL_PROVIDER,
          threadId: EXTERNAL_THREAD_ID,
          contentHash: EXTERNAL_CONTENT_HASH,
          startOrdinal: 3,
          endOrdinal: 6,
        },
      ],
      generatedAt: '2026-07-14T10:01:00.000Z',
      sourceUnit: {
        filePath: `xurl://${EXTERNAL_PROVIDER}/${EXTERNAL_THREAD_ID}`,
        byteRange: { start: 3, end: 6 },
        generatedAt: '2026-07-14T10:01:00.000Z',
      },
    };

    const review = makePromotionReview(candidate);
    const markdown = renderDistilledSkillMarkdown(candidate, review);

    // The Provenance Refs section must expose all four fields.
    assert.ok(markdown.includes('## Provenance Refs'), 'expected Provenance Refs section');
    assert.ok(
      markdown.includes(`provider: \`${EXTERNAL_PROVIDER}\``),
      'rendered skill should expose provider',
    );
    assert.ok(
      markdown.includes(`thread: \`${EXTERNAL_THREAD_ID}\``),
      'rendered skill should expose thread identity',
    );
    assert.ok(
      markdown.includes(`content hash: \`${EXTERNAL_CONTENT_HASH}\``),
      'rendered skill should expose content hash',
    );
    // Ordinal range is labeled explicitly for external sources.
    assert.ok(
      markdown.includes('ordinal range 3–5'),
      'rendered skill should expose ordinal range for external provenance',
    );
    // Event position (turn) is still present.
    assert.ok(
      markdown.includes('turn 5'),
      'rendered skill should expose event position (turn)',
    );
  });

  test('local provenance rendering remains compatible (byte range, no external fields)', () => {
    const candidate: DistilledKnowledgeCandidate = {
      schemaVersion: 1,
      kind: 'capability',
      capabilityId: 'cap-local-test-001',
      title: 'Local capability',
      applicability: 'When doing local work.',
      actionPattern: 'Run a local tool.',
      boundaries: ['Only local.'],
      risks: ['Single observation.'],
      solvedLoop: {
        problem: 'Local problem',
        action: 'Ran local tool',
        verification: 'User confirmed',
        noCorrection: 'No correction.',
      },
      provenance: [
        {
          filePath: '/logs/sessions/local/chat.jsonl',
          turn: 5,
          role: 'problem-action',
          unitByteRange: { start: 1024, end: 2048 },
        },
        {
          filePath: '/logs/sessions/local/chat.jsonl',
          turn: 6,
          role: 'verification',
          unitByteRange: { start: 1024, end: 2048 },
        },
      ],
      generatedAt: '2026-07-14T10:01:00.000Z',
      sourceUnit: {
        filePath: '/logs/sessions/local/chat.jsonl',
        byteRange: { start: 1024, end: 2048 },
        generatedAt: '2026-07-14T10:01:00.000Z',
      },
    };

    const review = makePromotionReview(candidate);
    const markdown = renderDistilledSkillMarkdown(candidate, review);

    assert.ok(markdown.includes('## Provenance Refs'), 'expected Provenance Refs section');
    // Local provenance uses "byte range" label.
    assert.ok(
      markdown.includes('byte range 1024–2048'),
      'local provenance should use byte range label',
    );
    // No external fields.
    assert.ok(
      !markdown.includes('provider:'),
      'local provenance should not expose provider',
    );
    assert.ok(
      !markdown.includes('thread:'),
      'local provenance should not expose thread',
    );
    assert.ok(
      !markdown.includes('content hash:'),
      'local provenance should not expose content hash',
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: Evidence Capsule reconstruction preserves external provenance
// ---------------------------------------------------------------------------

describe('External provenance — Evidence Capsule reconstruction', () => {
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

    const bundle = reconstructBundleFromCapsule(capsule, [], {
      schemaVersion: 2 as const,
      catalogRevision: 0,
      routeRedirects: {},
      capabilities: {},
    });

    assert.ok(bundle.episode.provenance.length >= 1, 'expected provenance refs');
    for (const ref of bundle.episode.provenance) {
      assert.equal(ref.provider, EXTERNAL_PROVIDER, 'capsule reconstruction should expose provider');
      assert.equal(ref.threadId, EXTERNAL_THREAD_ID, 'capsule reconstruction should expose threadId');
      assert.equal(ref.contentHash, EXTERNAL_CONTENT_HASH, 'capsule reconstruction should expose contentHash');
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: legacy parser handles ordinal range label
// ---------------------------------------------------------------------------

describe('External provenance — legacy parser compatibility', () => {
  test('parseProvenanceRefs matches both byte range and ordinal range labels', () => {
    const body = [
      '## Provenance Refs',
      '',
      '- `xurl://openai/thread-abc` turn 5 (problem-action) — ordinal range 3–5 · provider: `openai` · thread: `thread-abc` · content hash: `sha256:deadbeef`',
      '- `xurl://openai/thread-abc` turn 6 (verification) — ordinal range 3–6 · provider: `openai` · thread: `thread-abc` · content hash: `sha256:deadbeef`',
      '',
    ].join('\n');

    const refs = parseProvenanceRefs(body, 'fallback.jsonl', { start: 0, end: 1 });
    assert.equal(refs.length, 2, 'parser should match both ordinal range lines');
    assert.equal(refs[0].turn, 5);
    assert.equal(refs[0].role, 'problem-action');
    assert.equal(refs[0].start, 3);
    assert.equal(refs[0].end, 5);
    assert.equal(refs[1].turn, 6);
    assert.equal(refs[1].role, 'verification');
  });

  test('parseProvenanceRefs still matches byte range for local provenance', () => {
    const body = [
      '## Provenance Refs',
      '',
      '- `/logs/sessions/local/chat.jsonl` turn 5 (problem-action) — byte range 1024–2048',
      '',
    ].join('\n');

    const refs = parseProvenanceRefs(body, 'fallback.jsonl', { start: 0, end: 1 });
    assert.equal(refs.length, 1);
    assert.equal(refs[0].turn, 5);
    assert.equal(refs[0].start, 1024);
    assert.equal(refs[0].end, 2048);
  });
});

// ---------------------------------------------------------------------------
// Tests: ordinal semantics — structured startOrdinal/endOrdinal
// ---------------------------------------------------------------------------

describe('External provenance — ordinal semantics', () => {
  test('rendered ordinal range uses structured startOrdinal/endOrdinal, not arbitrary unitByteRange', () => {
    // Construct a candidate where unitByteRange differs from the typed
    // ordinals to prove the renderer uses the structured values.
    const candidate: DistilledKnowledgeCandidate = {
      schemaVersion: 1,
      kind: 'capability',
      capabilityId: 'cap-ordinal-semantics-001',
      title: 'Ordinal semantics test',
      applicability: 'When testing ordinal semantics.',
      actionPattern: 'Verify ordinal rendering.',
      boundaries: ['Test only.'],
      risks: ['Single observation.'],
      solvedLoop: {
        problem: 'Test problem',
        action: 'Test action',
        verification: 'Test verification',
        noCorrection: 'No correction.',
      },
      provenance: [
        {
          filePath: `xurl://${EXTERNAL_PROVIDER}/${EXTERNAL_THREAD_ID}`,
          turn: 5,
          role: 'problem-action',
          // unitByteRange holds a DIFFERENT value than startOrdinal/endOrdinal
          // to prove the renderer uses the typed ordinals, not the byte range.
          unitByteRange: { start: 999, end: 999 },
          provider: EXTERNAL_PROVIDER,
          threadId: EXTERNAL_THREAD_ID,
          contentHash: EXTERNAL_CONTENT_HASH,
          startOrdinal: 3,
          endOrdinal: 5,
        },
      ],
      generatedAt: '2026-07-14T10:01:00.000Z',
      sourceUnit: {
        filePath: `xurl://${EXTERNAL_PROVIDER}/${EXTERNAL_THREAD_ID}`,
        byteRange: { start: 3, end: 6 },
        generatedAt: '2026-07-14T10:01:00.000Z',
      },
    };

    const review = makePromotionReview(candidate);
    const markdown = renderDistilledSkillMarkdown(candidate, review);

    // The rendered range must come from startOrdinal/endOrdinal (3–5),
    // NOT from unitByteRange (999–999).
    assert.ok(
      markdown.includes('ordinal range 3–5'),
      'rendered range should use structured startOrdinal/endOrdinal (3–5), not unitByteRange (999)',
    );
    assert.ok(
      !markdown.includes('999'),
      'unitByteRange value (999) must not appear in rendered ordinal range',
    );
  });

  test('rendered range falls back to unitByteRange when startOrdinal/endOrdinal are absent', () => {
    // Simulates an older persisted record that has provider/threadId/contentHash
    // but no typed startOrdinal/endOrdinal — the renderer must fall back to
    // unitByteRange for backward compatibility.
    const candidate: DistilledKnowledgeCandidate = {
      schemaVersion: 1,
      kind: 'capability',
      capabilityId: 'cap-ordinal-fallback-001',
      title: 'Ordinal fallback test',
      applicability: 'When testing ordinal fallback.',
      actionPattern: 'Verify fallback.',
      boundaries: ['Test only.'],
      risks: ['Single observation.'],
      solvedLoop: {
        problem: 'Test problem',
        action: 'Test action',
        verification: 'Test verification',
        noCorrection: 'No correction.',
      },
      provenance: [
        {
          filePath: `xurl://${EXTERNAL_PROVIDER}/${EXTERNAL_THREAD_ID}`,
          turn: 5,
          role: 'problem-action',
          unitByteRange: { start: 10, end: 20 },
          provider: EXTERNAL_PROVIDER,
          threadId: EXTERNAL_THREAD_ID,
          contentHash: EXTERNAL_CONTENT_HASH,
          // startOrdinal/endOrdinal intentionally absent
        },
      ],
      generatedAt: '2026-07-14T10:01:00.000Z',
      sourceUnit: {
        filePath: `xurl://${EXTERNAL_PROVIDER}/${EXTERNAL_THREAD_ID}`,
        byteRange: { start: 10, end: 20 },
        generatedAt: '2026-07-14T10:01:00.000Z',
      },
    };

    const review = makePromotionReview(candidate);
    const markdown = renderDistilledSkillMarkdown(candidate, review);

    // Falls back to unitByteRange when typed ordinals are absent.
    assert.ok(
      markdown.includes('ordinal range 10–20'),
      'rendered range should fall back to unitByteRange (10–20) when startOrdinal/endOrdinal are absent',
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: adversarial — external identifier injection resistance
// ---------------------------------------------------------------------------

describe('External provenance — adversarial identifier injection', () => {
  test('newline in provider cannot inject new Markdown lines or sections', () => {
    const candidate: DistilledKnowledgeCandidate = {
      schemaVersion: 1,
      kind: 'capability',
      capabilityId: 'cap-adversarial-nl-001',
      title: 'Newline injection test',
      applicability: 'When testing newline injection.',
      actionPattern: 'Verify newline sanitization.',
      boundaries: ['Test only.'],
      risks: ['Single observation.'],
      solvedLoop: {
        problem: 'Test',
        action: 'Test',
        verification: 'Test',
        noCorrection: 'No correction.',
      },
      provenance: [
        {
          filePath: `xurl://evil/thread-001`,
          turn: 1,
          role: 'problem-action',
          unitByteRange: { start: 1, end: 2 },
          provider: 'evil\n## Injected Section',
          threadId: 'thread-001',
          contentHash: 'hash-001',
          startOrdinal: 1,
          endOrdinal: 2,
        },
      ],
      generatedAt: '2026-07-14T10:01:00.000Z',
      sourceUnit: {
        filePath: 'xurl://evil/thread-001',
        byteRange: { start: 1, end: 2 },
        generatedAt: '2026-07-14T10:01:00.000Z',
      },
    };

    const review = makePromotionReview(candidate);
    const markdown = renderDistilledSkillMarkdown(candidate, review);

    // The injected section heading must NOT appear at the start of a line
    // (which would make it a real Markdown heading). The newline is stripped
    // so the provider value stays on a single line inside the inline-code span.
    const lines = markdown.split('\n');
    const hasInjectedSection = lines.some(l => /^##\s+Injected\s+Section/.test(l));
    assert.ok(
      !hasInjectedSection,
      'newline in provider must not inject a new Markdown section heading at line start',
    );
    // The provenance line containing the provider should be a single line.
    const provenanceSection = markdown.split('## Provenance Refs')[1] ?? '';
    const provenanceLines = provenanceSection.split('\n').filter(l => l.trim() !== '' && !l.startsWith('##'));
    // The provider line should not contain a line break that creates a heading.
    const providerLine = provenanceLines.find(l => l.includes('provider:'));
    assert.ok(providerLine, 'provider line should exist');
    assert.ok(
      !/^##\s/.test(providerLine),
      'provider line must not start with a Markdown heading',
    );
  });

  test('backtick in threadId cannot break inline-code framing', () => {
    const candidate: DistilledKnowledgeCandidate = {
      schemaVersion: 1,
      kind: 'capability',
      capabilityId: 'cap-adversarial-bt-001',
      title: 'Backtick injection test',
      applicability: 'When testing backtick injection.',
      actionPattern: 'Verify backtick sanitization.',
      boundaries: ['Test only.'],
      risks: ['Single observation.'],
      solvedLoop: {
        problem: 'Test',
        action: 'Test',
        verification: 'Test',
        noCorrection: 'No correction.',
      },
      provenance: [
        {
          filePath: `xurl://evil/thread-001`,
          turn: 1,
          role: 'problem-action',
          unitByteRange: { start: 1, end: 2 },
          provider: 'evil',
          threadId: 'thread-`+malicious+',
          contentHash: 'hash-001',
          startOrdinal: 1,
          endOrdinal: 2,
        },
      ],
      generatedAt: '2026-07-14T10:01:00.000Z',
      sourceUnit: {
        filePath: 'xurl://evil/thread-001',
        byteRange: { start: 1, end: 2 },
        generatedAt: '2026-07-14T10:01:00.000Z',
      },
    };

    const review = makePromotionReview(candidate);
    const markdown = renderDistilledSkillMarkdown(candidate, review);

    // The backtick in threadId must be stripped so it cannot close the
    // inline-code span early and inject arbitrary Markdown.
    const provenanceSection = markdown.split('## Provenance Refs')[1] ?? '';
    const threadLine = provenanceSection.split('\n').find(l => l.includes('thread:'));
    assert.ok(threadLine, 'thread line should exist');
    // Extract the thread value between backticks. There should be exactly
    // one inline-code span for the thread value, and the backtick from the
    // input must not appear inside it.
    const threadMatch = /thread: `([^`]*)`/.exec(threadLine);
    assert.ok(threadMatch, 'thread value should be inside a single inline-code span');
    // The malicious backtick payload must not appear in the rendered value.
    assert.ok(
      !threadMatch![1].includes('`'),
      'backtick from threadId must be stripped from the rendered value',
    );
    // The sanitized value should be the threadId with backticks removed.
    assert.equal(threadMatch![1], 'thread-+malicious+');
  });

  test('oversized contentHash is truncated and cannot grow without bound', () => {
    const oversizedHash = 'a'.repeat(10_000);
    const candidate: DistilledKnowledgeCandidate = {
      schemaVersion: 1,
      kind: 'capability',
      capabilityId: 'cap-adversarial-size-001',
      title: 'Oversized identifier test',
      applicability: 'When testing oversized identifiers.',
      actionPattern: 'Verify truncation.',
      boundaries: ['Test only.'],
      risks: ['Single observation.'],
      solvedLoop: {
        problem: 'Test',
        action: 'Test',
        verification: 'Test',
        noCorrection: 'No correction.',
      },
      provenance: [
        {
          filePath: `xurl://evil/thread-001`,
          turn: 1,
          role: 'problem-action',
          unitByteRange: { start: 1, end: 2 },
          provider: 'evil',
          threadId: 'thread-001',
          contentHash: oversizedHash,
          startOrdinal: 1,
          endOrdinal: 2,
        },
      ],
      generatedAt: '2026-07-14T10:01:00.000Z',
      sourceUnit: {
        filePath: 'xurl://evil/thread-001',
        byteRange: { start: 1, end: 2 },
        generatedAt: '2026-07-14T10:01:00.000Z',
      },
    };

    const review = makePromotionReview(candidate);
    const markdown = renderDistilledSkillMarkdown(candidate, review);

    // The rendered content hash must be bounded — the full 10,000-char hash
    // must not appear in the output.
    assert.ok(
      !markdown.includes(oversizedHash),
      'oversized contentHash must be truncated, not rendered in full',
    );
    // The rendered line should contain a truncated version (128 chars max).
    const provenanceSection = markdown.split('## Provenance Refs')[1] ?? '';
    const hashLine = provenanceSection.split('\n').find(l => l.includes('content hash:'));
    assert.ok(hashLine, 'content hash line should exist');
    // Extract the value between backticks.
    const hashMatch = /content hash: `([^`]*)`/.exec(hashLine);
    assert.ok(hashMatch, 'content hash value should be in backticks');
    assert.ok(
      hashMatch![1].length <= 128,
      `truncated content hash should be <= 128 chars, got ${hashMatch![1].length}`,
    );
  });

  test('carriage return in provider is stripped (cannot inject lines on Windows-style Markdown)', () => {
    const candidate: DistilledKnowledgeCandidate = {
      schemaVersion: 1,
      kind: 'capability',
      capabilityId: 'cap-adversarial-cr-001',
      title: 'CR injection test',
      applicability: 'When testing CR injection.',
      actionPattern: 'Verify CR sanitization.',
      boundaries: ['Test only.'],
      risks: ['Single observation.'],
      solvedLoop: {
        problem: 'Test',
        action: 'Test',
        verification: 'Test',
        noCorrection: 'No correction.',
      },
      provenance: [
        {
          filePath: `xurl://evil/thread-001`,
          turn: 1,
          role: 'problem-action',
          unitByteRange: { start: 1, end: 2 },
          provider: 'evil\r\n## Injected',
          threadId: 'thread-001',
          contentHash: 'hash-001',
          startOrdinal: 1,
          endOrdinal: 2,
        },
      ],
      generatedAt: '2026-07-14T10:01:00.000Z',
      sourceUnit: {
        filePath: 'xurl://evil/thread-001',
        byteRange: { start: 1, end: 2 },
        generatedAt: '2026-07-14T10:01:00.000Z',
      },
    };

    const review = makePromotionReview(candidate);
    const markdown = renderDistilledSkillMarkdown(candidate, review);

    // The CR+LF must be stripped so the injected heading does not appear
    // at the start of a line.
    const lines = markdown.split('\n');
    const hasInjectedSection = lines.some(l => /^##\s+Injected/.test(l));
    assert.ok(
      !hasInjectedSection,
      'carriage return in provider must not inject a new Markdown section heading at line start',
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: end-to-end from public xurl reader to DistillationUnit to rendered Skill
// ---------------------------------------------------------------------------

describe('External provenance — end-to-end from public xurl reader', () => {
  test('XurlExternalBackfillSource.read produces DistillationUnit with exact provider, thread, ordinals, and content hash, then renders correctly', () => {
    // Build a fake xurl binary that speaks the agents:// protocol.
    // The Timeline has explicit ordinal + fingerprint in frontmatter so the
    // source uses head -I for stability confirmation (one read + one head).
    const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xurl-e2e-'));
    const command = path.join(scriptDir, process.platform === 'win32' ? 'fake-xurl-e2e.cjs' : 'fake-xurl-e2e');

    const E2E_PROVIDER = 'codex';
    const E2E_THREAD = 'thread-e2e-001';
    const E2E_BRANCH = 'main';
    const E2E_ORDINAL = 2;
    const E2E_FINGERPRINT = 'stable-fingerprint-e2e';
    const E2E_USER_CONTENT = 'Please create a deployment script for the staging environment.';
    const E2E_ASSISTANT_CONTENT = 'I created the deployment script and verified it runs successfully.';

    // Compute the expected content hash the same way parseRenderedTimeline does.
    const expectedContentHash = crypto
      .createHash('sha256')
      .update(`User:${E2E_USER_CONTENT}\nAssistant:${E2E_ASSISTANT_CONTENT}`, 'utf8')
      .digest('hex');

    const timelineMarkdown = [
      '---',
      `uri: agents://${E2E_PROVIDER}/${E2E_THREAD}`,
      `provider: ${E2E_PROVIDER}`,
      `thread: ${E2E_THREAD}`,
      `branch: ${E2E_BRANCH}`,
      `ordinal: ${E2E_ORDINAL}`,
      `fingerprint: ${E2E_FINGERPRINT}`,
      'queried_at: 2026-07-14T10:01:00.000Z',
      '---',
      '',
      '## Timeline',
      '',
      '### 1. User',
      '',
      E2E_USER_CONTENT,
      '',
      '### 2. Assistant',
      '',
      E2E_ASSISTANT_CONTENT,
      '',
    ].join('\n');

    const headFrontmatter = [
      '---',
      `uri: agents://${E2E_PROVIDER}/${E2E_THREAD}`,
      `provider: ${E2E_PROVIDER}`,
      `thread: ${E2E_THREAD}`,
      `branch: ${E2E_BRANCH}`,
      `ordinal: ${E2E_ORDINAL}`,
      `fingerprint: ${E2E_FINGERPRINT}`,
      '---',
      '',
    ].join('\n');

    const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('xurl 0.0.27\\n'); process.exit(0); }
// head -I: args are ['-I', 'agents://...']
if (args[0] === '-I' && args[1] && args[1].startsWith('agents://')) {
  process.stdout.write(${JSON.stringify(headFrontmatter)});
  process.exit(0);
}
// read: args are ['agents://...']
if (args[0] && args[0].startsWith('agents://')) {
  process.stdout.write(${JSON.stringify(timelineMarkdown)});
  process.exit(0);
}
process.stderr.write('fake-xurl-e2e: unknown args ' + JSON.stringify(args) + '\\n');
process.exit(1);
`;
    fs.writeFileSync(command, script, { encoding: 'utf8', mode: 0o755 });

    try {
      const source = new XurlExternalBackfillSource({
        command,
        provider: E2E_PROVIDER,
        sourceId: 'external-codex-e2e',
        sourceLabel: 'Codex Session Logs (E2E)',
        checkVersion: true,
      });

      // Restrict to a single thread to avoid needing a catalog response.
      source.restrictToResourceRefs([E2E_THREAD]);
      const resources = source.discoverResources();
      assert.equal(resources.length, 1, 'should discover exactly one restricted resource');
      assert.equal(resources[0]!.resourceRef, E2E_THREAD);

      // Read from position 0 — the source calls read + head -I internally.
      const readResult: ExternalSessionLogBackfillReadResult = source.read(
        resources[0]!,
        { resourceRef: E2E_THREAD, position: 0, processedCount: 0 },
      );

      // Prove the source produced at least one DistillationUnit.
      assert.ok(readResult.events.length >= 1, 'read should produce at least one event with a DistillationUnit');

      const unit = readResult.events[0]!.distillationUnit;

      // Verify the DistillationUnit carries exact external provenance.
      assert.ok(unit.externalEventProvenance, 'DistillationUnit should carry externalEventProvenance');
      assert.equal(unit.externalEventProvenance!.provider, E2E_PROVIDER);
      assert.equal(unit.externalEventProvenance!.threadId, E2E_THREAD);
      assert.equal(unit.externalEventProvenance!.contentHash, expectedContentHash);
      assert.equal(unit.externalEventProvenance!.startOrdinal, 1);
      assert.equal(unit.externalEventProvenance!.endOrdinal, 2);
      assert.equal(unit.externalEventProvenance!.branchId, E2E_BRANCH);

      // Now prove downstream propagation through the distiller.
      const candidates = distillCapabilityCandidates(unit);
      // The external unit has a single User→Assistant pair. The distiller
      // needs a positive-acceptance verification turn. This fixture has only
      // one turn, so the distiller may not produce a candidate. Instead,
      // prove the learning-episode path and the renderer directly.
      if (candidates.length > 0) {
        for (const ref of candidates[0]!.provenance) {
          assert.equal(ref.provider, E2E_PROVIDER);
          assert.equal(ref.threadId, E2E_THREAD);
          assert.equal(ref.contentHash, expectedContentHash);
          assert.equal(ref.startOrdinal, 1);
          assert.equal(ref.endOrdinal, 2);
        }
      }

      // Prove the learning-episode path propagates external provenance.
      const episodeResult = extractLearningEpisodes(unit);
      if (episodeResult.episodes.length > 0) {
        for (const episode of episodeResult.episodes) {
          assert.ok(episode.externalEventProvenance, 'episode should carry externalEventProvenance');
          assert.equal(episode.externalEventProvenance!.provider, E2E_PROVIDER);
          assert.equal(episode.externalEventProvenance!.threadId, E2E_THREAD);
          assert.equal(episode.externalEventProvenance!.contentHash, expectedContentHash);
        }
      }

      // Prove the renderer correctly displays the external provenance by
      // building a candidate from the unit's external fields and rendering it.
      const external = unit.externalEventProvenance!;
      const renderCandidate: DistilledKnowledgeCandidate = {
        schemaVersion: 1,
        kind: 'capability',
        capabilityId: 'cap-e2e-render-001',
        title: 'E2E rendered capability',
        applicability: 'When testing end-to-end rendering.',
        actionPattern: 'Verify rendering.',
        boundaries: ['Test only.'],
        risks: ['Single observation.'],
        solvedLoop: {
          problem: E2E_USER_CONTENT,
          action: E2E_ASSISTANT_CONTENT,
          verification: 'User confirmed',
          noCorrection: 'No correction.',
        },
        provenance: [
          {
            filePath: unit.filePath,
            turn: 2,
            role: 'problem-action',
            unitByteRange: unit.byteRange,
            provider: external.provider,
            threadId: external.threadId,
            contentHash: external.contentHash,
            startOrdinal: external.startOrdinal,
            endOrdinal: external.endOrdinal,
          },
        ],
        generatedAt: unit.generatedAt,
        sourceUnit: {
          filePath: unit.filePath,
          byteRange: unit.byteRange,
          generatedAt: unit.generatedAt,
        },
      };

      const review = makePromotionReview(renderCandidate);
      const markdown = renderDistilledSkillMarkdown(renderCandidate, review);

      assert.ok(markdown.includes('## Provenance Refs'), 'rendered skill should have Provenance Refs section');
      assert.ok(
        markdown.includes(`provider: \`${E2E_PROVIDER}\``),
        'rendered skill should expose provider from DistillationUnit',
      );
      assert.ok(
        markdown.includes(`thread: \`${E2E_THREAD}\``),
        'rendered skill should expose thread from DistillationUnit',
      );
      assert.ok(
        markdown.includes(`content hash: \`${expectedContentHash}\``),
        'rendered skill should expose content hash from DistillationUnit',
      );
      assert.ok(
        markdown.includes('ordinal range 1–2'),
        'rendered skill should expose ordinal range from DistillationUnit',
      );
    } finally {
      fs.rmSync(scriptDir, { recursive: true, force: true });
    }
  });
});
