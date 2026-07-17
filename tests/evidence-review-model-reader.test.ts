/**
 * Model-backed dual-lane Evidence Reader (#105/#106 production gap).
 *
 * Proves:
 * - Author and Verifier lanes each call the injected AIService once
 * - Reconstructable Reader Branch Transcripts are persisted
 * - Exact spans pass schema validation
 * - Invalid JSON / schema / spans / unreadable fail closed and retry locally
 * - Lanes do not share natural-language findings or branch identity
 */

import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { Message } from '../src/types';
import type { AIService } from '../src/utils/ai-service';
import {
  SkillEvolutionRuntime,
  type EvidenceBundle,
  type SkillDraft,
  type SkillVerifierResult,
} from '../src/utils/skill-evolution';
import { evidenceReviewJobStorePathForReviewQueue } from '../src/utils/evidence-review-job-store';
import { defaultDistilledOutputDir } from '../src/utils/distillation-pipeline';
import type { ShardFindingSet } from '../src/utils/evidence-review-types';
import {
  parseAndValidateReaderCompletion,
  runModelBackedReaderLane,
} from '../src/utils/evidence-review-reader-branch';
import type { ReaderLaneInput } from '../src/utils/evidence-review-engine';
import { EvidenceReviewEngine } from '../src/utils/evidence-review-engine';

interface CapturedChat {
  messages: Message[];
  lane: 'author' | 'verifier' | 'unknown';
}

class InjectedReaderAIService {
  readonly calls: CapturedChat[] = [];
  private readonly responses: Array<string | Error>;
  private index = 0;

  constructor(responses: Array<string | Error>) {
    this.responses = responses;
  }

  async chat(messages: Message[]): Promise<{ content: string }> {
    const system = String(messages.find(m => m.role === 'system')?.content ?? '');
    const lane: CapturedChat['lane'] = /Author Evidence Reader/i.test(system)
      ? 'author'
      : /Verifier Evidence Reader/i.test(system)
        ? 'verifier'
        : 'unknown';
    this.calls.push({ messages: messages.map(m => ({ ...m })), lane });
    const next = this.responses[this.index] ?? this.responses[this.responses.length - 1];
    this.index += 1;
    if (next instanceof Error) throw next;
    return { content: String(next ?? '') };
  }

  async chatStream(
    messages: Message[],
  ): Promise<{ content: string }> {
    return this.chat(messages);
  }

  isToolCallingSupported(): boolean {
    return true;
  }

  getConfig(): Record<string, unknown> {
    return { model: 'test-reader-model' };
  }
}

function fixtureBundle(content = 'Deliver the report. Confirm it works. No secret material.'): EvidenceBundle {
  return {
    bundleId: 'bundle-model-reader-1',
    episode: {
      schemaVersion: 1,
      kind: 'capability',
      capabilityId: 'model-reader',
      title: 'Model reader',
      applicability: 'Model-backed dual-lane readers.',
      actionPattern: 'Read shards with AIService.',
      boundaries: [],
      risks: [],
      provenance: [],
      solvedLoop: {
        problem: 'Structural reader certifies without model.',
        action: 'Run lane-isolated model readers.',
        verification: 'Schema-valid findings with transcripts.',
        noCorrection: 'No correction.',
      },
      generatedAt: new Date(0).toISOString(),
      sourceUnit: {
        filePath: 'model-reader.jsonl',
        byteRange: { start: 0, end: 1 },
        generatedAt: new Date(0).toISOString(),
      },
      // Keep content visible to sharding when present.
      summary: content,
    },
    completionEvidence: [{
      ref: 'model-reader.jsonl#1',
      sourceFilePath: 'model-reader.jsonl',
      turn: 1,
      kind: 'artifact-delivery',
      detail: content,
    }],
    settlementEvidence: [{
      ref: 'model-reader.jsonl#2',
      sourceFilePath: 'model-reader.jsonl',
      turn: 2,
      kind: 'user-confirmation',
      detail: 'Confirm delivered.',
    }],
    boundedContinuity: [],
    referencedSkills: [],
    relatedCurrentSkills: [],
    semanticObservations: [{
      kind: 'user-intent',
      value: content.slice(0, 200),
      sourceRefs: ['model-reader.jsonl#1'],
    }],
    sourceEvidence: [
      {
        ref: 'model-reader.jsonl#1',
        role: 'problem-action',
        content,
      },
      {
        ref: 'model-reader.jsonl#2',
        role: 'verification',
        content: 'Confirm delivered.',
      },
    ],
  };
}

function validFindingJson(
  shardId: string,
  contentHash: string,
  lane: 'author' | 'verifier',
  content: string,
  summary: string,
): string {
  const end = Buffer.byteLength(content, 'utf8');
  return JSON.stringify({
    coverage: 'covered',
    findings: [{
      findingId: `${lane}:fact:span0`,
      classification: 'fact',
      summary,
      spans: [{ start: 0, end }],
    }],
  });
}

function setupRuntime(ai: InjectedReaderAIService): {
  root: string;
  skillEvolution: SkillEvolutionRuntime;
  jobStorePath: string;
  branchLogRoot: string;
  teardown: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-model-reader-'));
  const skillsRoot = path.join(root, 'skills');
  const outputDir = defaultDistilledOutputDir(skillsRoot);
  const reviewQueuePath = path.join(root, 'data', 'review-queue.json');
  const registryPath = path.join(root, 'data', 'current-skill-registry.json');
  const auditPath = path.join(root, 'data', 'transition-audit.jsonl');
  const journalPath = path.join(root, 'data', 'transition-journal.json');
  const branchLogRoot = path.join(root, 'data', 'branch-logs');
  const jobStorePath = evidenceReviewJobStorePathForReviewQueue(reviewQueuePath);

  const skillEvolution = new SkillEvolutionRuntime({
    workingDirectory: root,
    outputDir,
    registryPath,
    auditPath,
    journalPath,
    reviewQueuePath,
    branchLogRoot,
    settlementWindowMs: 0,
    operationalRetryMs: 1,
    operationalRetryMaxMs: 1_000,
    logEnabled: true,
    aiService: ai as unknown as AIService,
    // No readerFixture — production model-backed path under test.
    authorFixture: (): SkillDraft => ({
      body: '# Model Reader\n\nDeliver from model-backed readers.',
      envelope: {
        decision: 'create_current_skill',
        routingName: 'model-reader-delivery',
        description: 'Model-backed dual-lane readers.',
        referencedSkills: [],
        evidenceRefs: ['model-reader.jsonl#1'],
        rationale: 'Readers and promotion complete.',
      },
    }),
    verifierFixture: (): SkillVerifierResult => ({
      decision: 'accept',
      transition: 'create_current_skill',
      issues: [],
      rationale: 'Accept after model-backed readers.',
      registryReadSet: [],
    }),
  });

  return {
    root,
    skillEvolution,
    jobStorePath,
    branchLogRoot,
    teardown: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function listBranchTranscripts(branchLogRoot: string): string[] {
  if (!fs.existsSync(branchLogRoot)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(branchLogRoot);
  return out;
}

function readTranscriptEvents(filePath: string): Array<Record<string, unknown>> {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('Model-backed Evidence Reader', () => {
  let teardown: (() => void) | undefined;

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  test('both lanes call AI, persist transcripts, and keep independent findings', async () => {
    const content = 'Deliver the report. Confirm it works. No secret material.';
    const authorSummary = 'Author-only observation of delivery language.';
    const verifierSummary = 'Verifier-only independent confirmation of delivery.';

    // Responses are consumed in claim order; produce lane-specific content from
    // the request so order independence is preserved.
    const ai = new InjectedReaderAIService([]);
    // Override chat to craft per-lane valid JSON from the user payload.
    ai.chat = async function (this: InjectedReaderAIService, messages: Message[]) {
      const system = String(messages.find(m => m.role === 'system')?.content ?? '');
      const user = String(messages.find(m => m.role === 'user')?.content ?? '');
      const lane: CapturedChat['lane'] = /Author Evidence Reader/i.test(system)
        ? 'author'
        : /Verifier Evidence Reader/i.test(system)
          ? 'verifier'
          : 'unknown';
      this.calls.push({ messages: messages.map(m => ({ ...m })), lane });
      const payload = JSON.parse(user) as {
        lane: 'author' | 'verifier';
        shard: { shardId: string; contentHash: string; content: string };
      };
      const summary = payload.lane === 'author' ? authorSummary : verifierSummary;
      return {
        content: validFindingJson(
          payload.shard.shardId,
          payload.shard.contentHash,
          payload.lane,
          payload.shard.content,
          summary,
        ),
      };
    };

    const env = setupRuntime(ai);
    teardown = env.teardown;

    const bundle = fixtureBundle(content);
    const result = await env.skillEvolution.reviewAndApply(bundle);
    assert.equal(result.transition, 'create_current_skill');

    // Both reader lanes invoked the model (at least once each).
    const authorCalls = ai.calls.filter(c => c.lane === 'author');
    const verifierCalls = ai.calls.filter(c => c.lane === 'verifier');
    assert.ok(authorCalls.length >= 1, 'author lane must call AI');
    assert.ok(verifierCalls.length >= 1, 'verifier lane must call AI');

    // No cross-lane sharing of natural-language findings in prompts or results.
    for (const call of authorCalls) {
      const system = String(call.messages.find(m => m.role === 'system')?.content ?? '');
      assert.match(system, /Author Evidence Reader/);
      assert.doesNotMatch(system, /Verifier Evidence Reader/);
      assert.doesNotMatch(system, new RegExp(verifierSummary));
    }
    for (const call of verifierCalls) {
      const system = String(call.messages.find(m => m.role === 'system')?.content ?? '');
      assert.match(system, /Verifier Evidence Reader/);
      assert.doesNotMatch(system, /Author Evidence Reader/);
      assert.doesNotMatch(system, new RegExp(authorSummary));
    }

    const engine = env.skillEvolution.getEvidenceReviewEngine();
    const jobs = Object.values(engine.loadStore().jobs);
    assert.ok(jobs.length >= 1);
    const job = jobs[0]!;
    const authorReaders = Object.values(job.quanta).filter(q => q.kind === 'author_reader' && q.state === 'succeeded');
    const verifierReaders = Object.values(job.quanta).filter(q => q.kind === 'verifier_reader' && q.state === 'succeeded');
    assert.ok(authorReaders.length >= 1);
    assert.ok(verifierReaders.length >= 1);

    const authorSet = authorReaders[0]!.result as ShardFindingSet;
    const verifierSet = verifierReaders[0]!.result as ShardFindingSet;
    assert.equal(authorSet.lane, 'author');
    assert.equal(verifierSet.lane, 'verifier');
    assert.ok(authorSet.findings.some(f => f.summary === authorSummary));
    assert.ok(verifierSet.findings.some(f => f.summary === verifierSummary));
    // Exact spans cover the shard content.
    for (const set of [authorSet, verifierSet]) {
      for (const finding of set.findings) {
        for (const span of finding.spans) {
          assert.ok(Number.isInteger(span.start));
          assert.ok(Number.isInteger(span.end));
          assert.ok(span.start >= 0);
          assert.ok(span.end >= span.start);
        }
      }
    }
    const authorIds = new Set(authorSet.findings.map(f => f.findingId));
    for (const f of verifierSet.findings) {
      assert.equal(authorIds.has(f.findingId), false, 'finding ids must not be shared across lanes');
    }

    // Reconstructable branch transcripts for both lane types.
    const transcripts = listBranchTranscripts(env.branchLogRoot);
    const authorTx = transcripts.filter(p => p.includes('evidence-author-reader'));
    const verifierTx = transcripts.filter(p => p.includes('evidence-verifier-reader'));
    assert.ok(authorTx.length >= 1, 'author reader transcript required');
    assert.ok(verifierTx.length >= 1, 'verifier reader transcript required');

    for (const file of [...authorTx, ...verifierTx]) {
      const events = readTranscriptEvents(file);
      const types = new Set(events.map(e => e.event_type));
      assert.ok(types.has('start'));
      assert.ok(types.has('transcript'));
      assert.ok(types.has('run_result'));
      assert.ok(events.every(e => e.entry_type === 'branch'));
      const transcript = events.find(e => e.event_type === 'transcript');
      assert.ok(Array.isArray(transcript?.messages));
      const branchTypes = new Set(events.map(e => e.branch_type));
      assert.equal(branchTypes.size, 1);
    }
    // Separate branch identity: author vs verifier paths never share a file.
    for (const a of authorTx) {
      assert.equal(verifierTx.includes(a), false);
    }
  });

  test('invalid JSON fails closed with local retry; no coverage certification', async () => {
    // Always return non-JSON so every attempt fails closed (no eventual empty-findings success).
    const ai = new InjectedReaderAIService([
      'not-json at all',
      'still broken {{{',
      'definitely not a finding set',
    ]);
    const env = setupRuntime(ai);
    teardown = env.teardown;

    const bundle = fixtureBundle();
    // Prefer direct engine advance with model-backed callback for focused fail-closed proof.
    const engine = new EvidenceReviewEngine({
      jobStorePath: env.jobStorePath,
      workingDirectory: env.root,
      maxQuantaPerAdvance: 4,
      leaseMs: 60_000,
      retryBaseMs: 1,
      retryMaxMs: 10,
      runReaderLane: async (input) => runModelBackedReaderLane(input, {
        aiService: ai as unknown as AIService,
        workingDirectory: env.root,
        branchLogRoot: env.branchLogRoot,
        signal: input.signal,
      }),
      runSkillAuthor: async () => {
        throw new Error('must not reach skill_author after invalid reader');
      },
      runSkillVerifier: async () => {
        throw new Error('must not reach skill_verifier after invalid reader');
      },
      commitTransition: async () => {
        throw new Error('must not reach commit after invalid reader');
      },
    });

    const job = engine.createJob({
      bundle,
      candidate: bundle.episode as any,
      workClass: 'live_learning',
    });
    const advanced = await engine.advanceJob(job.jobId, 'wake-invalid-json', undefined, {
      allowedKinds: ['author_reader', 'verifier_reader'],
    });

    const live = engine.loadStore().jobs[job.jobId]!;
    const readers = Object.values(live.quanta).filter(
      q => q.kind === 'author_reader' || q.kind === 'verifier_reader',
    );
    const failedReaders = readers.filter(q => q.state === 'retry_wait' || q.state === 'terminal_failed');
    assert.ok(
      failedReaders.length >= 1
        || /invalid_completion_schema|non-JSON|no JSON|empty completion/i.test(advanced.lastError?.message ?? ''),
      `expected fail-closed reader; lastError=${advanced.lastError?.message ?? 'none'} states=${readers.map(q => `${q.kind}:${q.state}`).join(',')}`,
    );
    assert.equal(readers.every(q => q.state === 'succeeded'), false);
    assert.equal(live.authorDossier, undefined);
    assert.ok(ai.calls.length >= 1);

    // Transcript still reconstructable on failure path.
    const transcripts = listBranchTranscripts(env.branchLogRoot);
    assert.ok(transcripts.length >= 1);
    const events = readTranscriptEvents(transcripts[0]!);
    assert.ok(events.some(e => e.event_type === 'start'));
    assert.ok(events.some(e => e.event_type === 'transcript'));
  });

  test('invalid spans and unreadable coverage fail closed', async () => {
    const content = 'hello world';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-reader-parse-'));
    teardown = () => fs.rmSync(root, { recursive: true, force: true });

    const engine = new EvidenceReviewEngine({
      jobStorePath: path.join(root, 'jobs.json'),
      workingDirectory: root,
      maxQuantaPerAdvance: 1,
      runSkillAuthor: async () => ({ draft: null as any, transcriptPaths: [] }),
      runSkillVerifier: async () => ({ verifier: null as any, dispositions: [], transcriptPaths: [] }),
      commitTransition: async () => ({ transition: 'defer', verified: false, rounds: 1 }),
    });
    const job = engine.createJob({
      bundle: fixtureBundle(content),
      candidate: fixtureBundle(content).episode as any,
      workClass: 'live_learning',
    });
    const shardId = job.manifest.shardIds[0]!;
    const shard = job.shards[shardId]!;

    assert.throws(
      () => parseAndValidateReaderCompletion(
        JSON.stringify({
          coverage: 'covered',
          findings: [{
            findingId: 'author:fact:1',
            classification: 'fact',
            summary: 'bad span',
            spans: [{ start: 0, end: 99999 }],
          }],
        }),
        shard,
        'author',
        job,
      ),
      /invalid_completion_schema|invalid_span/,
    );

    assert.throws(
      () => parseAndValidateReaderCompletion(
        JSON.stringify({ coverage: 'unreadable', findings: [], diagnostic: 'garbled' }),
        shard,
        'author',
        job,
      ),
      /reader coverage incomplete: unreadable/,
    );

    assert.throws(
      () => parseAndValidateReaderCompletion(
        JSON.stringify({
          coverage: 'covered',
          findings: [],
          diagnostic: 'looks fine',
        }),
        shard,
        'author',
        job,
      ),
      /invalid_completion_schema|free_form_only/,
    );

    // Valid path with exact spans.
    const ok = parseAndValidateReaderCompletion(
      validFindingJson(shard.shardId, shard.contentHash, 'author', shard.content, 'ok'),
      shard,
      'author',
      job,
    );
    assert.equal(ok.lane, 'author');
    assert.equal(ok.coverage, 'covered');
    assert.equal(ok.findings[0]!.spans[0]!.end, Buffer.byteLength(shard.content, 'utf8'));
  });

  test('lane-isolated prompts never include the other lane\'s findings', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-reader-iso-'));
    teardown = () => fs.rmSync(root, { recursive: true, force: true });
    const branchLogRoot = path.join(root, 'logs');

    const captured: CapturedChat[] = [];
    const ai = {
      async chat(messages: Message[]) {
        const system = String(messages.find(m => m.role === 'system')?.content ?? '');
        const lane: CapturedChat['lane'] = /Author Evidence Reader/i.test(system)
          ? 'author'
          : 'verifier';
        captured.push({ messages, lane });
        const user = JSON.parse(String(messages.find(m => m.role === 'user')?.content ?? '{}')) as {
          lane: 'author' | 'verifier';
          shard: { shardId: string; contentHash: string; content: string };
        };
        return {
          content: validFindingJson(
            user.shard.shardId,
            user.shard.contentHash,
            user.lane,
            user.shard.content,
            `${user.lane}-summary-${user.shard.shardId}`,
          ),
        };
      },
    };

    const engine = new EvidenceReviewEngine({
      jobStorePath: path.join(root, 'jobs.json'),
      workingDirectory: root,
      maxQuantaPerAdvance: 8,
      runReaderLane: async (input: ReaderLaneInput) => runModelBackedReaderLane(input, {
        aiService: ai as unknown as AIService,
        workingDirectory: root,
        branchLogRoot,
      }),
      runSkillAuthor: async () => ({ draft: null as any, transcriptPaths: [] }),
      runSkillVerifier: async () => ({ verifier: null as any, dispositions: [], transcriptPaths: [] }),
      commitTransition: async () => ({ transition: 'defer', verified: false, rounds: 1 }),
    });

    const job = engine.createJob({
      bundle: fixtureBundle(),
      candidate: fixtureBundle().episode as any,
      workClass: 'live_learning',
    });
    await engine.advanceJob(job.jobId, 'wake-iso', undefined, {
      allowedKinds: ['author_reader', 'verifier_reader'],
    });

    assert.ok(captured.some(c => c.lane === 'author'));
    assert.ok(captured.some(c => c.lane === 'verifier'));

    for (const call of captured) {
      const blob = JSON.stringify(call.messages);
      // Prompt only contains this lane's identity — never the other lane's summaries.
      if (call.lane === 'author') {
        assert.doesNotMatch(blob, /verifier-summary-/);
        assert.doesNotMatch(blob, /Verifier Evidence Reader/);
      } else {
        assert.doesNotMatch(blob, /author-summary-/);
        assert.doesNotMatch(blob, /Author Evidence Reader/);
      }
      // Only the immutable shard payload — no other lane finding sets.
      const user = JSON.parse(String(call.messages.find(m => m.role === 'user')?.content ?? '{}'));
      assert.equal(user.lane, call.lane);
      assert.ok(user.shard?.contentHash);
      assert.equal(user.findings, undefined);
      assert.equal(user.authorFindings, undefined);
      assert.equal(user.verifierFindings, undefined);
    }

    const live = engine.loadStore().jobs[job.jobId]!;
    const authorSet = Object.values(live.quanta)
      .find(q => q.kind === 'author_reader' && q.state === 'succeeded')
      ?.result as ShardFindingSet | undefined;
    const verifierSet = Object.values(live.quanta)
      .find(q => q.kind === 'verifier_reader' && q.state === 'succeeded')
      ?.result as ShardFindingSet | undefined;
    assert.ok(authorSet);
    assert.ok(verifierSet);
    assert.notEqual(authorSet.findings[0]!.summary, verifierSet.findings[0]!.summary);
  });
});
