import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { requestNeedsReviewRetry } from '../src/commands/runtime';
import {
  addNeedsReviewEntry,
  emptyNeedsReviewQueueState,
  loadNeedsReviewQueue,
  saveNeedsReviewQueue,
} from '../src/utils/needs-review-queue';
import { emptyCapabilityRegistryState } from '../src/utils/capability-registry';
import { buildPromotionPacket, PromotionReviewResult } from '../src/utils/promotion-reviewer';
import { DistilledKnowledgeCandidate } from '../src/utils/capability-distiller';

function candidate(): DistilledKnowledgeCandidate {
  return {
    schemaVersion: 1,
    kind: 'capability',
    capabilityId: 'cap-runtime-retry',
    title: 'Capability: retry a queued review',
    applicability: 'Use when a queued review should run again.',
    actionPattern: 'Request an explicit retry.',
    boundaries: [],
    risks: [],
    solvedLoop: {
      problem: 'A review needs another pass.',
      action: 'Request a retry.',
      verification: 'The retry was accepted.',
      noCorrection: 'No correction followed.',
    },
    provenance: [{
      filePath: '/logs/session.jsonl',
      turn: 1,
      role: 'problem-action',
      unitByteRange: { start: 0, end: 100 },
    }],
    generatedAt: '2026-07-10T00:00:00.000Z',
    sourceUnit: {
      filePath: '/logs/session.jsonl',
      byteRange: { start: 0, end: 100 },
      generatedAt: '2026-07-10T00:00:00.000Z',
    },
  };
}

describe('runtime needs-review retry command', () => {
  test('marks and durably saves the requested queue entry as retry eligible', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-runtime-retry-'));
    try {
      const queuePath = path.join(root, 'data', 'needs-review-queue-state.json');
      const state = emptyNeedsReviewQueueState();
      const packet = buildPromotionPacket(candidate());
      const review: PromotionReviewResult = {
        schemaVersion: 1,
        capabilityId: packet.candidate.capabilityId,
        decision: 'needs_review',
        rationale: 'More evidence is required.',
        reviewRisks: [],
        rewrite: null,
        reviewedAt: '2026-07-10T00:10:00.000Z',
      };
      const queued = addNeedsReviewEntry(state, {
        packet,
        review,
        matchedCapabilityIds: [],
        registry: emptyCapabilityRegistryState(),
        reviewerVersion: 'reviewer-v1',
        createdAt: review.reviewedAt,
      });
      saveNeedsReviewQueue(queuePath, state);

      const updated = requestNeedsReviewRetry(
        root,
        queued.entryId,
        'Operator requested another pass.',
        '2026-07-10T01:00:00.000Z',
      );

      assert.equal(updated.status, 'retry_eligible');
      const reloaded = loadNeedsReviewQueue(queuePath);
      const saved = reloaded.entries[queued.entryId];
      assert.equal(saved.status, 'retry_eligible');
      assert.equal(saved.retryEligibility.eligible, true);
      assert.equal(saved.retryEligibility.reason, 'Operator requested another pass.');
      assert.equal(saved.updatedAt, '2026-07-10T01:00:00.000Z');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
