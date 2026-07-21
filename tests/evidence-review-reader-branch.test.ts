import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AIService } from '../src/utils/ai-service';
import type { DistilledKnowledgeCandidate } from '../src/utils/capability-distiller';
import { createEvidenceReviewJob } from '../src/utils/evidence-review-graph';
import { runModelBackedReaderLane } from '../src/utils/evidence-review-reader-branch';
import type { EvidenceBundle } from '../src/utils/skill-evolution';

function fixtureCandidate(): DistilledKnowledgeCandidate {
  return {
    schemaVersion: 1,
    kind: 'capability',
    capabilityId: 'candidate-reader-stream',
    title: 'Reader stream recovery',
    applicability: 'When an evidence reader must preserve streamed output.',
    actionPattern: 'Read the bounded evidence and return structured findings.',
    boundaries: ['Use only the supplied shard.'],
    risks: ['The provider terminal response may omit visible output.'],
    solvedLoop: {
      problem: 'A terminal response omitted its visible message.',
      action: 'Aggregate the streamed response.',
      verification: 'The structured finding remained available.',
      noCorrection: 'No correction followed.',
    },
    provenance: [
      { filePath: 'session.jsonl', turn: 1, role: 'problem-action', unitByteRange: { start: 0, end: 10 } },
      { filePath: 'session.jsonl', turn: 2, role: 'verification', unitByteRange: { start: 11, end: 20 } },
    ],
    generatedAt: '2026-07-20T00:00:00.000Z',
    sourceUnit: {
      filePath: 'session.jsonl',
      byteRange: { start: 0, end: 20 },
      generatedAt: '2026-07-20T00:00:00.000Z',
    },
  };
}

function fixtureJob() {
  const candidate = fixtureCandidate();
  const bundle: EvidenceBundle = {
    bundleId: 'episode-reader-stream-recovery',
    episode: candidate,
    completionEvidence: [{ ref: 'session.jsonl#1' }],
    settlementEvidence: [{ ref: 'session.jsonl#2' }],
    semanticObservations: [],
    boundedContinuity: [],
    referencedSkills: [],
    relatedCurrentSkills: [],
  };
  return createEvidenceReviewJob({
    bundle,
    candidate,
    workClass: 'interactive',
    now: new Date('2026-07-20T00:00:00.000Z'),
  });
}

describe('model-backed evidence reader', () => {
  test('uses the streaming aggregation path so terminal responses cannot erase visible output', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-reader-stream-'));
    const job = fixtureJob();
    const shard = Object.values(job.shards)[0]!;
    let chatCalls = 0;
    let chatStreamCalls = 0;
    const aiService = {
      async chat() {
        chatCalls += 1;
        return { content: null };
      },
      async chatStream() {
        chatStreamCalls += 1;
        return {
          content: JSON.stringify({
            coverage: 'covered',
            findings: [{
              findingId: 'author:stream-preserved',
              classification: 'fact',
              summary: 'The streamed reader completion was preserved.',
              spans: [{ start: 0, end: Math.min(1, shard.byteLength) }],
            }],
          }),
        };
      },
    } as unknown as AIService;

    try {
      const result = await runModelBackedReaderLane(
        { shard, lane: 'author', job },
        { aiService, workingDirectory: root, branchLogRoot: path.join(root, 'branches') },
      );

      assert.equal(chatCalls, 0);
      assert.equal(chatStreamCalls, 1);
      assert.equal(result.findingSet.coverage, 'covered');
      assert.equal(result.findingSet.findings[0]?.findingId, 'author:stream-preserved');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
