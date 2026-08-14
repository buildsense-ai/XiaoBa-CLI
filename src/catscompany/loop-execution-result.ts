import type { LoopActionPacket, LoopCandidateProposal } from './loop-evidence';

export const LOOP_EXECUTION_RESULT_SCHEMA = 'loopctl-execution-result-v1';

export type LoopExecutionOutcome = 'completed' | 'failed' | 'cancelled';

const PARSED_LOOP_CANDIDATE_COMPLETION = Symbol('parsed-loop-candidate-completion');

/** Candidate data may cross into Loop evidence only through the terminal parser. */
export interface LoopCandidateCompletion {
  readonly [PARSED_LOOP_CANDIDATE_COMPLETION]: true;
  readonly candidate: LoopCandidateProposal;
}

function isLoopCandidateCompletion(value: unknown): value is LoopCandidateCompletion {
  return Boolean(value && typeof value === 'object' &&
    (value as LoopCandidateCompletion)[PARSED_LOOP_CANDIDATE_COMPLETION] === true);
}

export function assertLoopCandidateCompletion(value: unknown): asserts value is LoopCandidateCompletion {
  if (!isLoopCandidateCompletion(value)) {
    throw new Error('Loop execution result candidate must come from the terminal completion parser');
  }
}

/**
 * Typed terminal record for a Loop action. This records worker execution only;
 * it deliberately does not claim a GitHub deliverable or Controller candidate.
 */
export interface LoopExecutionResult {
  schema: typeof LOOP_EXECUTION_RESULT_SCHEMA;
  attemptId: string;
  workerSessionId: string;
  generation: number;
  workItemRevision: number;
  outcome: LoopExecutionOutcome;
  candidate?: LoopCandidateCompletion;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Loop execution result ${name} is required`);
  }
  return value;
}

function requiredNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`Loop execution result ${name} must be a non-negative integer`);
  }
  return Number(value);
}

export function parseLoopCandidateCompletion(text: string): LoopCandidateCompletion | undefined {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const envelope = value as Record<string, unknown>;
    if (Object.keys(envelope).length !== 3 || Object.keys(envelope).some(key => !['schema', 'candidateId', 'deliverable'].includes(key))) return undefined;
    if (envelope.schema !== 'loop_candidate_v1' || typeof envelope.candidateId !== 'string' || !envelope.candidateId.trim()) return undefined;
    const deliverable = envelope.deliverable;
    if (!deliverable || typeof deliverable !== 'object' || Array.isArray(deliverable)) return undefined;
    const valueDeliverable = deliverable as Record<string, unknown>;
    const requiredKeys = ['kind', 'repository', 'prNumber', 'headSha', 'baseSha'];
    if (Object.keys(valueDeliverable).length !== requiredKeys.length || Object.keys(valueDeliverable).some(key => !requiredKeys.includes(key))) return undefined;
    if (valueDeliverable.kind !== 'github_pr' || typeof valueDeliverable.repository !== 'string' || !valueDeliverable.repository.trim() ||
      !Number.isInteger(valueDeliverable.prNumber) || Number(valueDeliverable.prNumber) < 1 ||
      typeof valueDeliverable.headSha !== 'string' || !valueDeliverable.headSha.trim() ||
      typeof valueDeliverable.baseSha !== 'string' || !valueDeliverable.baseSha.trim()) return undefined;
    return {
      [PARSED_LOOP_CANDIDATE_COMPLETION]: true,
      candidate: {
        schema: 'loop_candidate_v1',
        candidateId: envelope.candidateId,
        deliverable: {
          kind: 'github_pr', repository: valueDeliverable.repository, prNumber: Number(valueDeliverable.prNumber),
          headSha: valueDeliverable.headSha, baseSha: valueDeliverable.baseSha,
        },
      },
    };
  } catch {
    return undefined;
  }
}

export function buildLoopExecutionResult(
  packet: LoopActionPacket,
  outcome: LoopExecutionOutcome,
  candidate?: LoopCandidateCompletion,
): LoopExecutionResult {
  if (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'cancelled') {
    throw new Error('Loop execution result outcome is invalid');
  }
  if (candidate !== undefined) assertLoopCandidateCompletion(candidate);
  if (outcome !== 'completed' && candidate !== undefined) {
    throw new Error('Loop execution result only permits a candidate for completed execution');
  }
  return {
    schema: LOOP_EXECUTION_RESULT_SCHEMA,
    attemptId: packet.attemptId,
    workerSessionId: packet.workerSessionId,
    generation: packet.generation,
    workItemRevision: packet.workItemRevision,
    outcome,
    ...(candidate ? { candidate } : {}),
  };
}

/** Reject result substitution across attempts, sessions, generations, or revisions. */
export function validateLoopExecutionResult(packet: LoopActionPacket, result: LoopExecutionResult): void {
  if (!result || result.schema !== LOOP_EXECUTION_RESULT_SCHEMA) {
    throw new Error('Loop execution result schema is unsupported');
  }
  if (requiredString(result.attemptId, 'attemptId') !== packet.attemptId) {
    throw new Error('Loop execution result attemptId does not match action packet');
  }
  if (requiredString(result.workerSessionId, 'workerSessionId') !== packet.workerSessionId) {
    throw new Error('Loop execution result workerSessionId does not match action packet');
  }
  if (requiredNonNegativeInteger(result.generation, 'generation') !== packet.generation) {
    throw new Error('Loop execution result generation does not match action packet');
  }
  if (requiredNonNegativeInteger(result.workItemRevision, 'workItemRevision') !== packet.workItemRevision) {
    throw new Error('Loop execution result workItemRevision does not match action packet');
  }
  if (result.outcome !== 'completed' && result.outcome !== 'failed' && result.outcome !== 'cancelled') {
    throw new Error('Loop execution result outcome is invalid');
  }
  if (result.candidate !== undefined) {
    if (result.outcome !== 'completed') {
      throw new Error('Loop execution result only permits a candidate for completed execution');
    }
    assertLoopCandidateCompletion(result.candidate);
    const candidate = result.candidate.candidate;
    if (!candidate || candidate.schema !== 'loop_candidate_v1' || typeof candidate.candidateId !== 'string' || !candidate.candidateId.trim() ||
      !candidate.deliverable || candidate.deliverable.kind !== 'github_pr' || typeof candidate.deliverable.repository !== 'string' || !candidate.deliverable.repository.trim() ||
      !Number.isInteger(candidate.deliverable.prNumber) || candidate.deliverable.prNumber < 1 ||
      typeof candidate.deliverable.headSha !== 'string' || !candidate.deliverable.headSha.trim() ||
      typeof candidate.deliverable.baseSha !== 'string' || !candidate.deliverable.baseSha.trim()) {
      throw new Error('Loop execution result candidate is invalid');
    }
  }
}
