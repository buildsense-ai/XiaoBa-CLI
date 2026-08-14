import type { LoopActionPacket } from './loop-evidence';

export const LOOP_EXECUTION_RESULT_SCHEMA = 'loopctl-execution-result-v1';

export type LoopExecutionOutcome = 'completed' | 'failed' | 'cancelled';

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

export function buildLoopExecutionResult(
  packet: LoopActionPacket,
  outcome: LoopExecutionOutcome,
): LoopExecutionResult {
  if (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'cancelled') {
    throw new Error('Loop execution result outcome is invalid');
  }
  return {
    schema: LOOP_EXECUTION_RESULT_SCHEMA,
    attemptId: packet.attemptId,
    workerSessionId: packet.workerSessionId,
    generation: packet.generation,
    workItemRevision: packet.workItemRevision,
    outcome,
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
}
