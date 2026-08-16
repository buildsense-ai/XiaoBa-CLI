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
  test('records token-limit diagnostics when the reader exhausts output before JSON', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-reader-length-'));
    const job = fixtureJob();
    const shard = Object.values(job.shards)[0]!;
    const branchRoot = path.join(root, 'branches');
    const aiService = {
      async chatStream() {
        return {
          content: null,
          stopReason: 'length',
          usage: { promptTokens: 120, completionTokens: 64, totalTokens: 184 },
        };
      },
    } as unknown as AIService;

    try {
      await assert.rejects(
        () => runModelBackedReaderLane(
          { shard, lane: 'author', job },
          { aiService, workingDirectory: root, branchLogRoot: branchRoot },
        ),
        /reader exhausted output budget before returning JSON \(stopReason=length\)/,
      );
      const transcriptFile = fs.readdirSync(path.join(branchRoot, 'evidence-author-reader'))
        .flatMap(day => fs.readdirSync(path.join(branchRoot, 'evidence-author-reader', day))
          .map(file => path.join(branchRoot, 'evidence-author-reader', day, file)))[0]!;
      const log = fs.readFileSync(transcriptFile, 'utf8');
      assert.match(log, /"stop_reason":"length"/);
      assert.match(log, /"completionTokens":64/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('records response diagnostics for valid JSON and disables in-call retries', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-reader-success-diagnostics-'));
    const job = fixtureJob();
    const shard = Object.values(job.shards)[0]!;
    const branchRoot = path.join(root, 'branches');
    let requestOptions: any;
    const aiService = {
      async chatStream(_messages: unknown, _tools: unknown, _callbacks: unknown, options: unknown) {
        requestOptions = options;
        return {
          content: JSON.stringify({
            coverage: 'covered',
            findings: [{
              findingId: 'author:complete-at-token-boundary',
              classification: 'fact',
              summary: 'The completion is valid despite ending at the token boundary.',
              spans: [{ start: 0, end: Math.min(1, shard.byteLength) }],
            }],
          }),
          stopReason: 'length',
          usage: { promptTokens: 120, completionTokens: 64, totalTokens: 184 },
        };
      },
    } as unknown as AIService;

    try {
      await runModelBackedReaderLane(
        { shard, lane: 'author', job },
        { aiService, workingDirectory: root, branchLogRoot: branchRoot },
      );
      assert.equal(requestOptions?.retryMode, 'none');
      const transcriptFile = fs.readdirSync(path.join(branchRoot, 'evidence-author-reader'))
        .flatMap(day => fs.readdirSync(path.join(branchRoot, 'evidence-author-reader', day))
          .map(file => path.join(branchRoot, 'evidence-author-reader', day, file)))[0]!;
      const log = fs.readFileSync(transcriptFile, 'utf8');
      assert.match(log, /"stop_reason":"length"/);
      assert.match(log, /"completionTokens":64/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('records null response diagnostics when the model request fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-reader-transport-diagnostics-'));
    const job = fixtureJob();
    const shard = Object.values(job.shards)[0]!;
    const branchRoot = path.join(root, 'branches');
    const aiService = {
      async chatStream() {
        throw new Error('rate limited');
      },
    } as unknown as AIService;

    try {
      await assert.rejects(
        () => runModelBackedReaderLane(
          { shard, lane: 'author', job },
          { aiService, workingDirectory: root, branchLogRoot: branchRoot },
        ),
        /rate limited/,
      );
      const transcriptFile = fs.readdirSync(path.join(branchRoot, 'evidence-author-reader'))
        .flatMap(day => fs.readdirSync(path.join(branchRoot, 'evidence-author-reader', day))
          .map(file => path.join(branchRoot, 'evidence-author-reader', day, file)))[0]!;
      const log = fs.readFileSync(transcriptFile, 'utf8');
      assert.match(log, /"stop_reason":null/);
      assert.match(log, /"usage":null/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

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
