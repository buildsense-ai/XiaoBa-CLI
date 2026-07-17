/**
 * Evidence Review Job engine — leases and executes Review Quanta.
 *
 * Authoritative Review Quanta (ADR 0045 / #105–#107):
 * - Dual-lane readers produce schema-validated Shard Finding Sets with exact
 *   spans and auditable Reader transcript artifacts.
 * - skill_author / skill_verifier / commit execute as leased durable quanta
 *   via injected callbacks (no post-hoc graph projection).
 * - Failed quanta retry locally; succeeded quanta are never replayed.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type {
  EvidenceBundle,
  SkillDraft,
  SkillVerifierResult,
  SkillEvolutionResult,
  SkillEvolutionOptions,
} from './skill-evolution';
import type { DistilledKnowledgeCandidate } from './capability-distiller';
import {
  type EvidenceDossier,
  type EvidenceReviewJob,
  type DossierDifferenceIndex,
  type ObligationDisposition,
  type ReviewObligation,
  type ReviewQuantumRecord,
  type ReviewWorkClass,
  type ShardFindingSet,
  type TypedFinding,
  type EvidenceShard,
} from './evidence-review-types';
import type { EvidenceReviewLane } from './evidence-review';
import { createEvidenceReviewJob } from './evidence-review-graph';
import {
  deriveJobDisposition,
  listRunnableQuanta,
  loadEvidenceReviewJobStore,
  saveEvidenceReviewJobStore,
  upsertEvidenceReviewJob,
  evidenceReviewJobStorePathForReviewQueue,
} from './evidence-review-job-store';
import {
  claimQuantum as claimQuantumCore,
  completeQuantum as completeQuantumCore,
  failQuantum as failQuantumCore,
  reclaimExpiredLeases,
} from './evidence-review-graph-core';
import {
  buildDossierDifferenceIndex,
  buildEvidenceDossier,
  buildReviewObligations,
  verifyShardContent,
  validateShardFindingSet,
  allObligationsResolvedForCommit,
} from './evidence-review';
import { planFairQuantumClaims } from './evidence-review-scheduler';

const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 60_000;

export interface ReaderLaneInput {
  shard: EvidenceShard;
  lane: EvidenceReviewLane;
  job: EvidenceReviewJob;
  signal?: AbortSignal;
}

export interface ReaderLaneResult {
  findingSet: ShardFindingSet;
  /** Optional pre-written transcript path; engine persists one when omitted. */
  transcriptPath?: string;
}

export interface EvidenceReviewEngineOptions {
  jobStorePath: string;
  workingDirectory: string;
  leaseMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: () => Date;
  maxQuantaPerAdvance?: number;
  /**
   * Production / SkillEvolution seam: independent Author or Verifier reader
   * execution over one immutable shard. SkillEvolution wires a model-backed
   * reader here; tests inject deterministic fixtures via SkillEvolution.readerFixture
   * or a direct runReaderLane callback. When omitted, the engine uses a
   * lane-scoped structural fallback for low-level engine tests only — never as
   * silent production semantic certification.
   */
  runReaderLane?: (input: ReaderLaneInput) => Promise<ReaderLaneResult>;
  runSkillAuthor: (input: {
    bundle: EvidenceBundle;
    authorDossier: EvidenceDossier;
    job: EvidenceReviewJob;
    signal?: AbortSignal;
  }) => Promise<{ draft: SkillDraft; transcriptPaths: string[] }>;
  runSkillVerifier: (input: {
    bundle: EvidenceBundle;
    draft: SkillDraft;
    authorDossier: EvidenceDossier;
    verifierDossier: EvidenceDossier;
    differenceIndex: DossierDifferenceIndex;
    obligations: readonly ReviewObligation[];
    job: EvidenceReviewJob;
    signal?: AbortSignal;
  }) => Promise<{
    verifier: SkillVerifierResult;
    dispositions: readonly ObligationDisposition[];
    transcriptPaths: string[];
  }>;
  commitTransition: (input: {
    bundle: EvidenceBundle;
    draft: SkillDraft;
    verifier: SkillVerifierResult;
    job: EvidenceReviewJob;
    branchTranscriptPaths: string[];
  }) => Promise<SkillEvolutionResult>;
}

export interface AdvanceJobResult {
  job: EvidenceReviewJob;
  executedQuantumIds: string[];
  remainingRunnable: number;
  result?: SkillEvolutionResult;
  /** Last quantum execution error (message + optional operational kind). */
  lastError?: {
    message: string;
    kind?: string;
    transcriptPaths?: string[];
    quantumId?: string;
    quantumKind?: string;
  };
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Pure graph helpers mutate job.quanta in place. We pass the engine job
 * directly (structurally compatible for quanta/disposition/updatedAt).
 */
function asMutableGraphJob(job: EvidenceReviewJob): any {
  return job;
}

/**
 * Lane-scoped structural reader for explicit test fixtures and engine unit tests.
 * Not the production SkillEvolution default (that path is model-backed).
 * Author and Verifier use independent finding identity and different pattern
 * emphasis; neither certifies coverage via a shared first-64-byte span.
 */
export function readShardStructurally(
  shardId: string,
  contentHash: string,
  content: string,
  lane: 'author' | 'verifier',
): ShardFindingSet {
  const findings: TypedFinding[] = [];
  const lower = content.toLowerCase();
  const contentBytes = Buffer.byteLength(content, 'utf8');

  const push = (
    classification: TypedFinding['classification'],
    summary: string,
    needle: string,
    salt: string,
  ): void => {
    const idx = lower.indexOf(needle.toLowerCase());
    if (idx < 0) return;
    const start = Buffer.byteLength(content.slice(0, idx), 'utf8');
    const end = start + Buffer.byteLength(content.slice(idx, idx + needle.length), 'utf8');
    findings.push({
      findingId: `${lane}:${classification}:${sha256(`${lane}:${salt}:${shardId}:${needle}`).slice(0, 12)}`,
      classification,
      summary,
      spans: [{ start, end }],
    });
  };

  // Author lane emphasizes instruction / privilege / risk extraction.
  // Verifier lane emphasizes corroboration / limitation / contradiction.
  if (lane === 'author') {
    if (/ignore (all )?(previous|prior) instructions|system prompt|you are now/i.test(content)) {
      push('source_instruction', 'Author lane: source material contains instruction-like text.', 'ignore', 'a1');
    }
    if (/password|secret|credential|sudo|rm -rf|privilege/i.test(content)) {
      push('privilege_implication', 'Author lane: privilege-sensitive content observed.', 'privilege', 'a2');
    }
    if (/risk|danger|unsafe|leak/i.test(content)) {
      push('risk', 'Author lane: risk language observed.', 'risk', 'a3');
    }
    if (/but |however |contradict|instead /i.test(content)) {
      push('limitation', 'Author lane: limiting or contrastive language observed.', 'but', 'a4');
    }
  } else {
    if (/ignore (all )?(previous|prior) instructions|system prompt|you are now/i.test(content)) {
      push('source_instruction', 'Verifier lane: independent confirmation of instruction-like text.', 'system', 'v1');
    }
    if (/password|secret|credential|sudo|rm -rf|privilege/i.test(content)) {
      push('privilege_implication', 'Verifier lane: independent privilege-sensitive observation.', 'secret', 'v2');
    }
    if (/risk|danger|unsafe|leak/i.test(content)) {
      push('risk', 'Verifier lane: independent risk observation.', 'danger', 'v3');
    }
    if (/but |however |contradict|instead /i.test(content)) {
      push('contradiction', 'Verifier lane: contrastive language may indicate contradiction.', 'however', 'v4');
    }
    if (/confirm|verify|thanks|works|delivered/i.test(content)) {
      push('fact', 'Verifier lane: corroborating settlement/delivery language.', 'confirm', 'v5');
    }
  }

  // Nonempty content without pattern hits still needs structured coverage —
  // cite the full immutable shard, never a shared first-N-byte heuristic.
  if (findings.length === 0 && content.trim().length > 0) {
    findings.push({
      findingId: `${lane}:fact:${sha256(`${lane}:full:${contentHash}`).slice(0, 12)}`,
      classification: 'fact',
      summary: `${lane === 'author' ? 'Author' : 'Verifier'} lane observed full shard content for dual-lane coverage.`,
      spans: [{ start: 0, end: contentBytes }],
    });
  }

  return {
    shardId,
    contentHash,
    lane,
    coverage: content.trim().length === 0 ? 'empty' : 'covered',
    findings,
  };
}

// Re-export package builders for tests / integrators that used prior names.
export function buildDossierFromFindingSets(
  lane: 'author' | 'verifier',
  manifestHash: string,
  sets: readonly ShardFindingSet[],
  complete = true,
): EvidenceDossier {
  return {
    lane,
    manifestHash,
    coveredShardIds: sets
      .filter(s => s.coverage === 'covered' || s.coverage === 'empty')
      .map(s => s.shardId)
      .sort((a, b) => a.localeCompare(b, 'en')),
    findings: sets.flatMap(s => s.findings),
    findingSets: sets,
    complete,
  };
}

export function buildDifferenceIndex(
  author: EvidenceDossier,
  verifier: EvidenceDossier,
): DossierDifferenceIndex {
  return buildDossierDifferenceIndex(author, verifier);
}

export { buildReviewObligations };

export class EvidenceReviewEngine {
  private readonly options: EvidenceReviewEngineOptions;

  constructor(options: EvidenceReviewEngineOptions) {
    this.options = options;
  }

  get jobStorePath(): string {
    return this.options.jobStorePath;
  }

  loadStore() {
    return loadEvidenceReviewJobStore(this.options.jobStorePath);
  }

  saveStore(state: ReturnType<typeof loadEvidenceReviewJobStore>): void {
    saveEvidenceReviewJobStore(this.options.jobStorePath, state);
  }

  findActiveJobForBundle(bundleId: string): EvidenceReviewJob | undefined {
    const state = this.loadStore();
    return Object.values(state.jobs)
      .filter(job => job.bundle.bundleId === bundleId && job.disposition === 'active')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt, 'en'))[0];
  }

  createJob(input: {
    bundle: EvidenceBundle;
    candidate: DistilledKnowledgeCandidate;
    workClass: ReviewWorkClass;
    registryReadSet?: Parameters<typeof createEvidenceReviewJob>[0]['registryReadSet'];
    sharding?: Parameters<typeof createEvidenceReviewJob>[0]['sharding'];
  }): EvidenceReviewJob {
    const job = createEvidenceReviewJob({
      bundle: input.bundle,
      candidate: input.candidate,
      workClass: input.workClass,
      registryReadSet: input.registryReadSet,
      now: this.options.now?.() ?? new Date(),
      sharding: input.sharding,
    });
    const state = this.loadStore();
    upsertEvidenceReviewJob(state, job);
    this.saveStore(state);
    return job;
  }

  ensureJob(input: {
    bundle: EvidenceBundle;
    candidate: DistilledKnowledgeCandidate;
    workClass: ReviewWorkClass;
    registryReadSet?: Parameters<typeof createEvidenceReviewJob>[0]['registryReadSet'];
    sharding?: Parameters<typeof createEvidenceReviewJob>[0]['sharding'];
  }): EvidenceReviewJob {
    const existing = this.findActiveJobForBundle(input.bundle.bundleId);
    if (existing) return existing;
    return this.createJob(input);
  }

  async advanceJob(
    jobId: string,
    wakeId: string,
    signal?: AbortSignal,
    options?: {
      allowedKinds?: ReadonlySet<ReviewQuantumRecord['kind']> | readonly ReviewQuantumRecord['kind'][];
      /** Execute only the quantum selected by an external scheduler. */
      quantumId?: string;
      /** Per-call execution bound; defaults to the engine-wide setting. */
      maxQuanta?: number;
    },
  ): Promise<AdvanceJobResult> {
    const nowFn = this.options.now ?? (() => new Date());
    const leaseMs = this.options.leaseMs ?? DEFAULT_LEASE_MS;
    const retryBaseMs = this.options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    const retryMaxMs = this.options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    const maxQuanta = Math.max(
      1,
      options?.maxQuanta ?? this.options.maxQuantaPerAdvance ?? 64,
    );
    const allowedKinds = options?.allowedKinds
      ? new Set(options.allowedKinds)
      : undefined;
    const executedQuantumIds: string[] = [];
    let result: SkillEvolutionResult | undefined;
    let lastError: AdvanceJobResult['lastError'];

    for (let i = 0; i < maxQuanta; i++) {
      if (signal?.aborted) break;
      const now = nowFn();
      const state = this.loadStore();
      let job = state.jobs[jobId];
      if (!job || job.disposition !== 'active') {
        return {
          job: job ?? state.jobs[jobId]!,
          executedQuantumIds,
          remainingRunnable: 0,
          result,
          lastError,
        };
      }

      // Reclaim expired leases via pure graph helper (mutates quanta in place).
      reclaimExpiredLeases(asMutableGraphJob(job), now);
      upsertEvidenceReviewJob(state, job);
      this.saveStore(state);

      const runnable = listRunnableQuanta(job, now).filter(q => (
        (!allowedKinds || allowedKinds.has(q.kind))
        && (!options?.quantumId || q.quantumId === options.quantumId)
      ));
      if (runnable.length === 0) {
        job.disposition = deriveJobDisposition(job);
        job.updatedAt = now.toISOString();
        upsertEvidenceReviewJob(state, job);
        this.saveStore(state);
        return { job, executedQuantumIds, remainingRunnable: 0, result, lastError };
      }

      const selected = selectNextQuantum(job, runnable);
      if (!selected) break;

      const claim = claimQuantumCore(asMutableGraphJob(job), selected.quantumId, {
        ownerWakeId: wakeId,
        now,
        leaseMs,
      });
      if (!claim.ok) break;
      upsertEvidenceReviewJob(state, job);
      this.saveStore(state);

      try {
        const execution = await this.executeQuantum(job, job.quanta[selected.quantumId]!, signal);
        const after = this.loadStore();
        const live = after.jobs[jobId]!;
        const completed = completeQuantumCore(asMutableGraphJob(live), selected.quantumId, {
          result: execution.result,
          now: nowFn(),
          // graph-core accepts a single transcriptPath; fold multiples into result metadata
          ...(execution.transcriptPaths[0] ? { transcriptPath: execution.transcriptPaths[0] } : {}),
        });
        if (!completed.ok) {
          throw new Error(`completeQuantum failed: ${completed.reason}`);
        }
        // Preserve additional transcript paths on the quantum when present.
        if (execution.transcriptPaths.length > 1) {
          const q = live.quanta[selected.quantumId]!;
          live.quanta[selected.quantumId] = {
            ...q,
            transcriptPaths: [...new Set([...q.transcriptPaths, ...execution.transcriptPaths])],
          };
        }
        if (execution.jobPatch) Object.assign(live, execution.jobPatch);
        if (execution.skillResult) result = execution.skillResult;
        live.disposition = deriveJobDisposition(live);
        live.updatedAt = nowFn().toISOString();
        if (live.disposition === 'completed' && result?.transitionId) {
          live.transitionId = result.transitionId;
        }
        // Semantic defer from commit quantum: surface deferred disposition.
        if (
          selected.kind === 'commit'
          && result
          && (result.transition === 'defer' || result.queued === 'deferred')
          && live.disposition === 'completed'
        ) {
          live.disposition = 'deferred';
        }
        upsertEvidenceReviewJob(after, live);
        this.saveStore(after);
        executedQuantumIds.push(selected.quantumId);
        if (selected.kind === 'commit' && result) {
          return {
            job: live,
            executedQuantumIds,
            remainingRunnable: listRunnableQuanta(live, nowFn()).length,
            result,
            lastError,
          };
        }
        job = live;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const operationalKind = extractOperationalKind(error);
        const operationalTranscripts = extractOperationalTranscripts(error);
        lastError = {
          message,
          ...(operationalKind ? { kind: operationalKind } : {}),
          ...(operationalTranscripts.length > 0 ? { transcriptPaths: operationalTranscripts } : {}),
          quantumId: selected.quantumId,
          quantumKind: selected.kind,
        };
        const terminal = /terminal|integrity|manifest/i.test(message);
        const after = this.loadStore();
        const live = after.jobs[jobId]!;
        const failed = failQuantumCore(asMutableGraphJob(live), selected.quantumId, {
          message,
          now: nowFn(),
          retryBaseMs,
          retryMaxMs,
          terminal,
        });
        if (!failed.ok) {
          // Fall back to manual retry_wait if pure helper rejects.
          live.quanta[selected.quantumId] = {
            ...live.quanta[selected.quantumId]!,
            state: terminal ? 'terminal_failed' : 'retry_wait',
            failureMessage: message,
            lease: undefined,
            updatedAt: nowFn().toISOString(),
          };
        }
        live.disposition = deriveJobDisposition(live);
        if (live.disposition === 'terminal_failed') {
          live.terminalReason = message;
        }
        live.updatedAt = nowFn().toISOString();
        const retrying = Object.values(live.quanta)
          .filter(q => q.state === 'retry_wait' && q.nextRetryAt)
          .map(q => q.nextRetryAt!)
          .sort();
        live.nextDueAt = retrying[0];
        upsertEvidenceReviewJob(after, live);
        this.saveStore(after);
        executedQuantumIds.push(selected.quantumId);
        job = live;
      }
    }

    const finalState = this.loadStore();
    const finalJob = finalState.jobs[jobId]!;
    return {
      job: finalJob,
      executedQuantumIds,
      remainingRunnable: listRunnableQuanta(finalJob, nowFn()).length,
      result,
      lastError,
    };
  }

  private async executeQuantum(
    job: EvidenceReviewJob,
    quantum: ReviewQuantumRecord,
    signal?: AbortSignal,
  ): Promise<{
    result: unknown;
    transcriptPaths: string[];
    jobPatch?: Partial<EvidenceReviewJob>;
    skillResult?: SkillEvolutionResult;
  }> {
    switch (quantum.kind) {
      case 'author_reader':
      case 'verifier_reader':
        return this.executeReader(job, quantum, signal);
      case 'author_dossier':
        return this.executeDossier(job, 'author');
      case 'verifier_dossier':
        return this.executeDossier(job, 'verifier');
      case 'difference_index':
        return this.executeDifference(job);
      case 'obligations':
        return this.executeObligations(job);
      case 'skill_author':
        return this.executeSkillAuthor(job, signal);
      case 'skill_verifier':
        return this.executeSkillVerifier(job, signal);
      case 'commit':
        return this.executeCommit(job);
      default:
        throw new Error(`unknown quantum kind: ${(quantum as ReviewQuantumRecord).kind}`);
    }
  }

  private async executeReader(
    job: EvidenceReviewJob,
    quantum: ReviewQuantumRecord,
    signal?: AbortSignal,
  ): Promise<{ result: ShardFindingSet; transcriptPaths: string[] }> {
    const shardId = quantum.shardId;
    if (!shardId) throw new Error('reader quantum missing shardId');
    const shard = job.shards[shardId];
    if (!shard) throw new Error(`missing shard ${shardId}`);
    if (!verifyShardContent(shard)) {
      throw new Error(`integrity: shard content hash mismatch for ${shardId}`);
    }
    const lane = quantum.lane ?? (quantum.kind === 'author_reader' ? 'author' : 'verifier');

    let findingSet: ShardFindingSet;
    let providedTranscript: string | undefined;
    if (this.options.runReaderLane) {
      const laneResult = await this.options.runReaderLane({ shard, lane, job, signal });
      if (!laneResult || !laneResult.findingSet) {
        throw new Error(`invalid_completion_schema: reader lane returned no finding set for ${lane}:${shardId}`);
      }
      findingSet = laneResult.findingSet;
      providedTranscript = laneResult.transcriptPath;
    } else {
      findingSet = readShardStructurally(shard.shardId, shard.contentHash, shard.content, lane);
    }

    const validation = validateShardFindingSet(findingSet, shard, job.manifest, { expectedLane: lane });
    if (!validation.ok) {
      const first = validation.errors[0]!;
      throw new Error(`invalid_completion_schema: ${first.code}: ${first.message}`);
    }
    if (findingSet.coverage !== 'covered' && findingSet.coverage !== 'empty') {
      throw new Error(`reader coverage incomplete: ${findingSet.coverage}`);
    }

    const transcriptPath = providedTranscript && fs.existsSync(providedTranscript)
      ? providedTranscript
      : this.persistReaderTranscript(job, quantum, lane, shard, findingSet);

    return { result: findingSet, transcriptPaths: [transcriptPath] };
  }

  private persistReaderTranscript(
    job: EvidenceReviewJob,
    quantum: ReviewQuantumRecord,
    lane: EvidenceReviewLane,
    shard: EvidenceShard,
    findingSet: ShardFindingSet,
  ): string {
    const root = path.join(this.options.workingDirectory, 'data', 'reader-transcripts');
    const jobDir = path.join(root, sanitizeFilePart(job.jobId));
    fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
    const filePath = path.join(
      jobDir,
      `${sanitizeFilePart(quantum.quantumId)}-${lane}.jsonl`,
    );
    const write = (eventType: string, payload: Record<string, unknown>): void => {
      const entry = {
        entry_type: 'reader',
        branch_type: `evidence-${lane}-reader`,
        branch_id: quantum.quantumId,
        event_type: eventType,
        timestamp: new Date().toISOString(),
        jobId: job.jobId,
        shardId: shard.shardId,
        contentHash: shard.contentHash,
        lane,
        ...payload,
      };
      fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    };
    write('start', {
      quantumKind: quantum.kind,
      byteLength: shard.byteLength,
    });
    write('fixture_result', {
      coverage: findingSet.coverage,
      findingCount: findingSet.findings.length,
      findingIds: findingSet.findings.map(f => f.findingId),
    });
    write('transcript', {
      messages: [
        {
          role: 'system',
          content: `Independent ${lane} reader over immutable shard ${shard.shardId}`,
        },
        {
          role: 'assistant',
          content: JSON.stringify({
            shardId: findingSet.shardId,
            contentHash: findingSet.contentHash,
            lane: findingSet.lane,
            coverage: findingSet.coverage,
            findings: findingSet.findings,
          }),
        },
      ],
    });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // best-effort permissions
    }
    return filePath;
  }

  private executeDossier(
    job: EvidenceReviewJob,
    lane: 'author' | 'verifier',
  ): { result: EvidenceDossier; transcriptPaths: string[]; jobPatch: Partial<EvidenceReviewJob> } {
    const kind = lane === 'author' ? 'author_reader' : 'verifier_reader';
    const sets = Object.values(job.quanta)
      .filter(q => q.kind === kind && q.state === 'succeeded')
      .map(q => q.result as ShardFindingSet)
      .filter(Boolean);
    const shards = job.manifest.shardIds.map(id => job.shards[id]!).filter(Boolean);
    const dossier = buildEvidenceDossier({
      lane,
      manifest: job.manifest,
      shards,
      findingSets: sets,
      requireCompleteCoverage: true,
    });
    const jobPatch: Partial<EvidenceReviewJob> = lane === 'author'
      ? { authorDossier: dossier }
      : { verifierDossier: dossier };
    return { result: dossier, transcriptPaths: [], jobPatch };
  }

  private executeDifference(
    job: EvidenceReviewJob,
  ): { result: DossierDifferenceIndex; transcriptPaths: string[]; jobPatch: Partial<EvidenceReviewJob> } {
    if (!job.authorDossier || !job.verifierDossier) {
      throw new Error('difference index requires both dossiers');
    }
    const index = buildDossierDifferenceIndex(job.authorDossier, job.verifierDossier);
    return { result: index, transcriptPaths: [], jobPatch: { differenceIndex: index } };
  }

  private executeObligations(
    job: EvidenceReviewJob,
  ): { result: ReviewObligation[]; transcriptPaths: string[]; jobPatch: Partial<EvidenceReviewJob> } {
    if (!job.authorDossier || !job.verifierDossier || !job.differenceIndex) {
      throw new Error('obligations require dossiers and difference index');
    }
    const obligations = buildReviewObligations(
      job.authorDossier,
      job.verifierDossier,
      job.differenceIndex,
    );
    return { result: obligations, transcriptPaths: [], jobPatch: { obligations } };
  }

  private async executeSkillAuthor(
    job: EvidenceReviewJob,
    signal?: AbortSignal,
  ): Promise<{
    result: SkillDraft;
    transcriptPaths: string[];
    jobPatch: Partial<EvidenceReviewJob>;
  }> {
    if (!job.authorDossier) {
      throw new Error('skill_author requires author dossier');
    }
    const outcome = await this.options.runSkillAuthor({
      bundle: job.bundle,
      authorDossier: job.authorDossier,
      job,
      signal,
    });
    if (!outcome?.draft) {
      throw new Error('invalid_completion_schema: skill_author returned no draft');
    }
    return {
      result: outcome.draft,
      transcriptPaths: outcome.transcriptPaths ?? [],
      jobPatch: { draft: outcome.draft },
    };
  }

  private async executeSkillVerifier(
    job: EvidenceReviewJob,
    signal?: AbortSignal,
  ): Promise<{
    result: { verifier: SkillVerifierResult; dispositions: readonly ObligationDisposition[] };
    transcriptPaths: string[];
    jobPatch: Partial<EvidenceReviewJob>;
  }> {
    if (!job.authorDossier || !job.verifierDossier || !job.differenceIndex || !job.obligations) {
      throw new Error('skill_verifier requires dossiers, difference index, and obligations');
    }
    const draft = job.draft ?? this.readSucceededQuantumResult<SkillDraft>(job, 'skill_author');
    if (!draft) {
      throw new Error('skill_verifier requires skill_author draft');
    }
    const outcome = await this.options.runSkillVerifier({
      bundle: job.bundle,
      draft,
      authorDossier: job.authorDossier,
      verifierDossier: job.verifierDossier,
      differenceIndex: job.differenceIndex,
      obligations: job.obligations,
      job,
      signal,
    });
    if (!outcome?.verifier) {
      throw new Error('invalid_completion_schema: skill_verifier returned no verifier result');
    }
    const dispositions = outcome.dispositions ?? [];
    return {
      result: { verifier: outcome.verifier, dispositions },
      transcriptPaths: outcome.transcriptPaths ?? [],
      jobPatch: {
        draft,
        verifierResult: outcome.verifier,
        obligationDispositions: dispositions,
      },
    };
  }

  private async executeCommit(
    job: EvidenceReviewJob,
  ): Promise<{
    result: SkillEvolutionResult;
    transcriptPaths: string[];
    jobPatch: Partial<EvidenceReviewJob>;
    skillResult: SkillEvolutionResult;
  }> {
    const draft = job.draft ?? this.readSucceededQuantumResult<SkillDraft>(job, 'skill_author');
    const verifierPayload = job.verifierResult
      ? { verifier: job.verifierResult, dispositions: job.obligationDispositions ?? [] }
      : this.readSucceededQuantumResult<{
        verifier: SkillVerifierResult;
        dispositions: readonly ObligationDisposition[];
      }>(job, 'skill_verifier');
    if (!draft || !verifierPayload?.verifier) {
      throw new Error('commit requires skill_author draft and skill_verifier result');
    }

    const branchTranscriptPaths = uniqueTranscriptPaths(job);
    const skillResult = await this.options.commitTransition({
      bundle: job.bundle,
      draft,
      verifier: verifierPayload.verifier,
      job,
      branchTranscriptPaths,
    });

    // commitTransition may have superseded the job (stale Review Basis).
    const reloaded = this.loadStore().jobs[job.jobId];
    if (reloaded?.disposition === 'superseded' || reloaded?.supersededByJobId) {
      return {
        result: skillResult,
        transcriptPaths: branchTranscriptPaths,
        jobPatch: {
          disposition: 'superseded',
          supersededByJobId: reloaded.supersededByJobId,
          terminalReason: reloaded.terminalReason,
        },
        skillResult,
      };
    }

    // Operational queue means the commit quantum itself did not finish — retry later.
    if (skillResult.queued === 'operational' && !skillResult.transitionId && !skillResult.audit) {
      throw new Error('commit deferred to operational retry queue');
    }

    const jobPatch: Partial<EvidenceReviewJob> = {
      draft,
      verifierResult: verifierPayload.verifier,
      obligationDispositions: verifierPayload.dispositions ?? job.obligationDispositions,
      transitionId: skillResult.transitionId ?? skillResult.audit?.transitionId,
    };
    if (skillResult.transition === 'defer' || skillResult.queued === 'deferred') {
      jobPatch.disposition = 'deferred';
    }

    return {
      result: skillResult,
      transcriptPaths: branchTranscriptPaths,
      jobPatch,
      skillResult,
    };
  }

  private readSucceededQuantumResult<T>(
    job: EvidenceReviewJob,
    kind: ReviewQuantumRecord['kind'],
  ): T | undefined {
    const quantum = Object.values(job.quanta).find(q => q.kind === kind && q.state === 'succeeded');
    return quantum?.result as T | undefined;
  }
}

function uniqueTranscriptPaths(job: EvidenceReviewJob): string[] {
  const paths: string[] = [];
  for (const quantum of Object.values(job.quanta)) {
    if (quantum.kind !== 'skill_author' && quantum.kind !== 'skill_verifier') continue;
    for (const p of quantum.transcriptPaths ?? []) {
      if (p && !paths.includes(p)) paths.push(p);
    }
  }
  return paths;
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) || 'quantum';
}

function extractOperationalKind(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const kind = (error as { kind?: unknown }).kind;
  return typeof kind === 'string' && kind.length > 0 ? kind : undefined;
}

function extractOperationalTranscripts(error: unknown): string[] {
  if (!error || typeof error !== 'object') return [];
  const paths = (error as { transcriptPaths?: unknown }).transcriptPaths;
  if (!Array.isArray(paths)) return [];
  return paths.filter((p): p is string => typeof p === 'string' && p.length > 0);
}

export function selectNextQuantum(
  job: EvidenceReviewJob,
  runnable: readonly ReviewQuantumRecord[],
): ReviewQuantumRecord | undefined {
  if (runnable.length === 0) return undefined;
  const nonReaders = runnable.filter(q => q.kind !== 'author_reader' && q.kind !== 'verifier_reader');
  if (nonReaders.length > 0) return nonReaders[0];

  const authorDone = Object.values(job.quanta)
    .filter(q => q.kind === 'author_reader' && q.state === 'succeeded').length;
  const verifierDone = Object.values(job.quanta)
    .filter(q => q.kind === 'verifier_reader' && q.state === 'succeeded').length;
  const preferLane: 'author' | 'verifier' = authorDone <= verifierDone ? 'author' : 'verifier';
  const preferred = runnable.find(q => q.lane === preferLane);
  return preferred ?? runnable[0];
}

export function resolveEvidenceReviewJobStorePath(
  options: Pick<SkillEvolutionOptions, 'reviewQueuePath' | 'workingDirectory'>,
): string {
  if (options.reviewQueuePath) {
    return evidenceReviewJobStorePathForReviewQueue(options.reviewQueuePath);
  }
  return `${options.workingDirectory.replace(/\/$/, '')}/data/evidence-review-jobs.json`;
}

export { allObligationsResolvedForCommit };

/**
 * Fair multi-job advance for one wake (#108).
 * Claims a bounded set of quanta across jobs using Fair Review Quantum Rotation.
 */
export async function advanceJobsFairly(
  engine: EvidenceReviewEngine,
  wakeId: string,
  options: {
    maxClaims: number;
    maxClaimsPerJob?: number;
    signal?: AbortSignal;
    now?: Date;
  },
): Promise<{ claims: number; jobIds: string[] }> {
  const state = engine.loadStore();
  const plan = planFairQuantumClaims(state, {
    maxClaims: options.maxClaims,
    maxClaimsPerJob: options.maxClaimsPerJob ?? 1,
    now: options.now,
  });
  state.fairness = plan.fairness;
  engine.saveStore(state);

  const touched = new Set<string>();
  for (const claim of plan.claims) {
    touched.add(claim.jobId);
    if (options.signal?.aborted) break;
    await engine.advanceJob(
      claim.jobId,
      `${wakeId}:${claim.jobId}:${claim.quantumId}`,
      options.signal,
      { quantumId: claim.quantumId, maxQuanta: 1 },
    );
  }
  return { claims: plan.claims.length, jobIds: [...touched] };
}
