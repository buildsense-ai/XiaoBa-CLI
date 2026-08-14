import { createHash } from 'crypto';
import { assertLoopCandidateCompletion, type LoopCandidateCompletion } from './loop-execution-result';
import { CatsClient, type CatsOutgoingMessage } from './client';
import { resolveCatsCoRuntimeConfig } from './runtime-config';

export const LOOP_ACTION_PACKET_SCHEMA = 'loopctl-action-packet-v1';
export const LOOP_EVIDENCE_SIGNATURE = 'catsco-message-attested';

export type LoopEvidenceType = 'worker_ready' | 'runtime_started';
export type LoopCandidateProofMode = 'catsco-message';

export interface LoopCandidateProposal {
  schema: 'loop_candidate_v1';
  candidateId: string;
  deliverable: {
    kind: 'github_pr';
    repository: string;
    prNumber: number;
    headSha: string;
    baseSha: string;
  };
}

export interface LoopCandidateSubmittedEvent {
  type: 'candidate_submitted';
  eventId: string;
  idempotencyKey: string;
  source: string;
  entityRef: string;
  payload: {
    ownerUid: string;
    workItemId: string;
    workItemRevision: number;
    attemptId: string;
    generation: number;
    runtimePrincipal: string;
    workerSessionId: string;
    candidateId: string;
    deliverable: LoopCandidateProposal['deliverable'] & { digest: string };
    taskContractHash: string;
    referenceSnapshotHash: string;
    writeScopeHash: string;
    acceptanceContractHash: string;
    proofMode: LoopCandidateProofMode;
  };
}

export type LoopEvidenceEvent = LoopLifecycleEvidenceEvent | LoopCandidateSubmittedEvent;

export interface LoopActionPacket {
  schema: typeof LOOP_ACTION_PACKET_SCHEMA;
  kind: 'preflight_attempt' | 'execute_attempt';
  actionId: string;
  actionKey: string;
  action: {
    state: 'ready';
    workItemRevision: number;
    targetPrincipal: string;
    targetTopicId: string;
  };
  workItemId: string;
  workItemRevision: number;
  targetPrincipal: string;
  targetTopicId: string;
  workerTopicId: string;
  evidenceTopicId: string;
  attemptId: string;
  ownerUid: string;
  githubRepo: string;
  proofMode: LoopCandidateProofMode;
  contracts: {
    taskContractHash: string;
    referenceSnapshotHash: string;
    writeScopeHash: string;
    acceptanceContractHash: string;
  };
  generation: number;
  runtimePrincipal: string;
  workerSessionId: string;
  workBundle: {
    contractDigest: string;
    instructions: string;
    deliverables: string[];
  };
}

export interface LoopLifecycleEvidenceEvent {
  type: LoopEvidenceType;
  eventId: string;
  idempotencyKey: string;
  source: string;
  entityRef: string;
  payload: {
    workItemId: string;
    expectedRevision: number;
    attemptId: string;
    generation: number;
    runtimePrincipal: string;
    workerSessionId: string;
    signature: typeof LOOP_EVIDENCE_SIGNATURE;
  };
}

export interface LoopEvidenceBotBinding {
  botUid: string;
  apiKey: string;
  serverUrl: string;
  httpBaseUrl: string;
  bodyId: string;
  installationId?: string;
}

export interface LoopEvidenceSenderOptions {
  client: Pick<CatsClient, 'uid' | 'sendStructuredMessage'>;
  botUid: string;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Loop Action packet ${name} is required`);
  }
  return value;
}

function requiredInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`Loop Action packet ${name} must be a non-negative integer`);
  }
  return Number(value);
}

function requiredPositiveInteger(value: unknown, name: string): number {
  const number = requiredInteger(value, name);
  if (number < 1) throw new Error(`Loop Action packet ${name} must be a positive integer`);
  return number;
}

function requiredContractHash(value: unknown, name: string): string {
  const hash = requiredString(value, name);
  if (hash.length < 8) {
    throw new Error(`Loop Action packet ${name} must be at least 8 characters`);
  }
  return hash;
}

function expectedPrincipal(botUid: string): string {
  return `catsco-user:${requiredString(botUid, 'Bot UID')}`;
}

function expectedWorkerSessionId(topicId: string, botUid: string): string {
  return `session:v2:catscompany:group:${topicId}:agent:${botUid}`;
}

function requireLoopGroupTopic(value: string, name: string): string {
  if (!/^grp_[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Loop Action packet ${name} must be a Controller group topic`);
  return value;
}

function validateWorkerSessionId(value: unknown, workerTopicId: string, botUid: string): void {
  if (requiredString(value, 'workerSessionId') !== expectedWorkerSessionId(workerTopicId, botUid)) {
    throw new Error('Loop Action packet workerSessionId does not match execution topic and Bot UID');
  }
}

function stableId(prefix: string, parts: string[]): string {
  const digest = createHash('sha256').update(parts.join('\u0000')).digest('hex');
  return `${prefix}:${digest}`;
}

/** Stable JSON is required because the controller persists and later attests the exact content. */
export function canonicalLoopEvidenceJson(event: LoopEvidenceEvent): string {
  return JSON.stringify(sortJson(event));
}

function sortJson(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const nested = (value as Record<string, unknown>)[key];
      if (nested !== undefined) result[key] = sortJson(nested);
    }
    return result;
  }
  throw new TypeError(`canonical JSON rejects ${typeof value}`);
}

export function validateLoopActionPacket(
  packet: LoopActionPacket,
  receivedTopicId: string,
  botUid: string,
  eventType: LoopEvidenceType,
): void {
  const principal = expectedPrincipal(botUid);
  if (packet?.schema !== LOOP_ACTION_PACKET_SCHEMA) throw new Error('unsupported Loop Action packet schema');
  if (packet?.kind !== 'preflight_attempt' && packet?.kind !== 'execute_attempt') {
    throw new Error('Loop Action packet kind is not actionable');
  }
  if ((eventType === 'worker_ready') !== (packet.kind === 'preflight_attempt')) {
    throw new Error(`${eventType} does not match Loop Action packet kind`);
  }
  if (packet.action?.state !== 'ready') throw new Error('Loop Action packet is stale or non-actionable');

  const targetTopicId = requireLoopGroupTopic(requiredString(packet.targetTopicId, 'targetTopicId'), 'targetTopicId');
  const actionTargetTopicId = requireLoopGroupTopic(requiredString(packet.action?.targetTopicId, 'action.targetTopicId'), 'action.targetTopicId');
  const workerTopicId = requireLoopGroupTopic(requiredString(packet.workerTopicId, 'workerTopicId'), 'workerTopicId');
  if (targetTopicId !== actionTargetTopicId || targetTopicId !== workerTopicId || targetTopicId !== requiredString(receivedTopicId, 'received topic')) {
    throw new Error('Loop Action packet execution topic does not match the received topic');
  }
  const evidenceTopicId = requireLoopGroupTopic(requiredString(packet.evidenceTopicId, 'evidenceTopicId'), 'evidenceTopicId');
  if (evidenceTopicId === targetTopicId) throw new Error('Loop Action packet evidence topic must differ from execution topic');

  if (requiredString(packet.targetPrincipal, 'targetPrincipal') !== principal || requiredString(packet.action?.targetPrincipal, 'action.targetPrincipal') !== principal) {
    throw new Error('Loop Action packet target principal does not match Bot UID');
  }
  if (requiredString(packet.runtimePrincipal, 'runtimePrincipal') !== principal) {
    throw new Error('Loop Action packet runtime principal does not match Bot UID');
  }
  if (requiredPositiveInteger(packet.workItemRevision, 'workItemRevision') !== requiredPositiveInteger(packet.action?.workItemRevision, 'action.workItemRevision')) {
    throw new Error('Loop Action packet revision does not match action revision');
  }
  requiredString(packet.actionId, 'actionId');
  requiredString(packet.actionKey, 'actionKey');
  requiredString(packet.workItemId, 'workItemId');
  requiredString(packet.attemptId, 'attemptId');
  requiredString(packet.ownerUid, 'ownerUid');
  requiredString(packet.githubRepo, 'githubRepo');
  if (packet.proofMode !== 'catsco-message') throw new Error('Loop Action packet proofMode must be catsco-message');
  if (!packet.contracts || typeof packet.contracts !== 'object') throw new Error('Loop Action packet contracts are required');
  requiredContractHash(packet.contracts.taskContractHash, 'contracts.taskContractHash');
  requiredContractHash(packet.contracts.referenceSnapshotHash, 'contracts.referenceSnapshotHash');
  requiredContractHash(packet.contracts.writeScopeHash, 'contracts.writeScopeHash');
  requiredContractHash(packet.contracts.acceptanceContractHash, 'contracts.acceptanceContractHash');
  requiredInteger(packet.generation, 'generation');
  validateWorkerSessionId(packet.workerSessionId, workerTopicId, botUid);
  if (!packet.workBundle || typeof packet.workBundle !== 'object') throw new Error('Loop Action packet workBundle is required');
  requiredString(packet.workBundle.contractDigest, 'workBundle.contractDigest');
  requiredString(packet.workBundle.instructions, 'workBundle.instructions');
  if (!Array.isArray(packet.workBundle.deliverables)) throw new Error('Loop Action packet workBundle.deliverables must be an array');
}

export function buildLoopEvidenceEvent(
  packet: LoopActionPacket,
  receivedTopicId: string,
  botUid: string,
  type: LoopEvidenceType,
): LoopLifecycleEvidenceEvent {
  validateLoopActionPacket(packet, receivedTopicId, botUid, type);
  const source = expectedPrincipal(botUid);
  const stableParts = [packet.actionKey, type, packet.attemptId, String(packet.generation), String(packet.workItemRevision), packet.workerSessionId];
  const idempotencyKey = stableId('loop-evidence', stableParts);
  return {
    type,
    eventId: stableId('loop-event', stableParts),
    idempotencyKey,
    source,
    entityRef: `attempt:${packet.attemptId}`,
    payload: {
      workItemId: packet.workItemId,
      expectedRevision: packet.workItemRevision,
      attemptId: packet.attemptId,
      generation: packet.generation,
      runtimePrincipal: source,
      workerSessionId: packet.workerSessionId,
      signature: LOOP_EVIDENCE_SIGNATURE,
    },
  };
}

function candidateDeliverableDigest(candidate: LoopCandidateProposal): string {
  return createHash('sha256').update(JSON.stringify(sortJson(candidate.deliverable))).digest('hex');
}

function validateLoopCandidateProposal(packet: LoopActionPacket, candidate: LoopCandidateProposal): void {
  if (!candidate || candidate.schema !== 'loop_candidate_v1') throw new Error('Loop candidate schema is unsupported');
  requiredString(candidate.candidateId, 'candidateId');
  const deliverable = candidate.deliverable;
  if (!deliverable || typeof deliverable !== 'object') throw new Error('Loop candidate deliverable is required');
  if (deliverable.kind !== 'github_pr') throw new Error('Loop candidate deliverable kind must be github_pr');
  if (requiredString(deliverable.repository, 'deliverable.repository') !== packet.githubRepo) {
    throw new Error('Loop candidate deliverable repository does not match action packet');
  }
  requiredPositiveInteger(deliverable.prNumber, 'deliverable.prNumber');
  requiredString(deliverable.headSha, 'deliverable.headSha');
  requiredString(deliverable.baseSha, 'deliverable.baseSha');
}

export function buildLoopCandidateSubmittedEvent(
  packet: LoopActionPacket,
  receivedTopicId: string,
  botUid: string,
  completion: LoopCandidateCompletion,
): LoopCandidateSubmittedEvent {
  assertLoopCandidateCompletion(completion);
  const candidate = completion.candidate;
  validateLoopActionPacket(packet, receivedTopicId, botUid, 'runtime_started');
  if (packet.kind !== 'execute_attempt') throw new Error('candidate_submitted requires an execute_attempt packet');
  validateLoopCandidateProposal(packet, candidate);
  const source = expectedPrincipal(botUid);
  const stableParts = [
    packet.actionKey, 'candidate_submitted', packet.attemptId, String(packet.generation),
    String(packet.workItemRevision), packet.workerSessionId, candidate.candidateId,
    candidate.deliverable.repository, String(candidate.deliverable.prNumber),
    candidate.deliverable.headSha, candidate.deliverable.baseSha,
  ];
  return {
    type: 'candidate_submitted',
    eventId: stableId('loop-candidate-event', stableParts),
    idempotencyKey: stableId('loop-candidate-evidence', stableParts),
    source,
    entityRef: `attempt:${packet.attemptId}`,
    payload: {
      ownerUid: packet.ownerUid,
      workItemId: packet.workItemId,
      workItemRevision: packet.workItemRevision,
      attemptId: packet.attemptId,
      generation: packet.generation,
      runtimePrincipal: source,
      workerSessionId: packet.workerSessionId,
      candidateId: candidate.candidateId,
      deliverable: { ...candidate.deliverable, digest: candidateDeliverableDigest(candidate) },
      ...packet.contracts,
      proofMode: 'catsco-message',
    },
  };
}

/**
 * Resolves only the Bot binding used to establish a CatsCo connection. It does
 * not connect and never exposes or logs a configuration snapshot.
 */
export function resolveLoopEvidenceBotBinding(runtimeRoot = process.cwd()): LoopEvidenceBotBinding {
  const runtime = resolveCatsCoRuntimeConfig({ runtimeRoot });
  const botUid = requiredString(runtime.auth.botUid, 'Bot UID');
  const apiKey = requiredString(runtime.auth.apiKey, 'Bot API key');
  const bodyId = requiredString(runtime.connector?.bodyId, 'Bot bodyId');
  return {
    botUid,
    apiKey,
    serverUrl: requiredString(runtime.auth.serverUrl, 'serverUrl'),
    httpBaseUrl: requiredString(runtime.auth.httpBaseUrl, 'httpBaseUrl'),
    bodyId,
    ...(runtime.connector?.installationId ? { installationId: runtime.connector.installationId } : {}),
  };
}

export class LoopEvidenceSender {
  private readonly botUid: string;

  constructor(private readonly options: LoopEvidenceSenderOptions) {
    this.botUid = requiredString(options.botUid, 'Bot UID');
  }

  async send(packet: LoopActionPacket, receivedTopicId: string, type: LoopEvidenceType): Promise<{ seqId: number; event: LoopLifecycleEvidenceEvent }> {
    const expectedUid = this.botUid;
    if (String(this.options.client.uid || '').trim() !== expectedUid) {
      throw new Error('connected CatsCo client UID does not match configured Bot UID');
    }
    const event = buildLoopEvidenceEvent(packet, receivedTopicId, expectedUid, type);
    return this.sendEvent(packet, event);
  }

  async candidateSubmitted(
    packet: LoopActionPacket,
    receivedTopicId: string,
    completion: LoopCandidateCompletion,
  ): Promise<{ seqId: number; event: LoopCandidateSubmittedEvent }> {
    const expectedUid = this.botUid;
    if (String(this.options.client.uid || '').trim() !== expectedUid) {
      throw new Error('connected CatsCo client UID does not match configured Bot UID');
    }
    const event = buildLoopCandidateSubmittedEvent(packet, receivedTopicId, expectedUid, completion);
    return this.sendEvent(packet, event);
  }

  private async sendEvent<T extends LoopEvidenceEvent>(packet: LoopActionPacket, event: T): Promise<{ seqId: number; event: T }> {
    const content = canonicalLoopEvidenceJson(event);
    const payload: CatsOutgoingMessage = {
      topic_id: packet.evidenceTopicId,
      client_msg_id: event.idempotencyKey,
      type: 'text',
      content,
      metadata: { client_msg_id: event.idempotencyKey },
    };
    const seqId = await this.options.client.sendStructuredMessage(payload);
    return { seqId, event };
  }

  workerReady(packet: LoopActionPacket, receivedTopicId: string): Promise<{ seqId: number; event: LoopLifecycleEvidenceEvent }> {
    return this.send(packet, receivedTopicId, 'worker_ready');
  }

  runtimeStarted(packet: LoopActionPacket, receivedTopicId: string): Promise<{ seqId: number; event: LoopLifecycleEvidenceEvent }> {
    return this.send(packet, receivedTopicId, 'runtime_started');
  }
}
