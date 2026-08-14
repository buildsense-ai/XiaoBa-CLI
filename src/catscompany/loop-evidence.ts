import { createHash } from 'crypto';
import { CatsClient, type CatsOutgoingMessage } from './client';
import { resolveCatsCoRuntimeConfig } from './runtime-config';

export const LOOP_ACTION_PACKET_SCHEMA = 'loopctl-action-packet-v1';
export const LOOP_EVIDENCE_SIGNATURE = 'catsco-message-attested';

export type LoopEvidenceType = 'worker_ready' | 'runtime_started';

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
  generation: number;
  runtimePrincipal: string;
  workerSessionId: string;
}

export interface LoopEvidenceEvent {
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
  const text = String(value || '').trim();
  if (!text) throw new Error(`Loop Action packet ${name} is required`);
  return text;
}

function requiredInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`Loop Action packet ${name} must be a non-negative integer`);
  }
  return Number(value);
}

function expectedPrincipal(botUid: string): string {
  return `catsco-user:${requiredString(botUid, 'Bot UID')}`;
}

function expectedWorkerSessionId(topicId: string, botUid: string): string {
  return `session:v2:catscompany:group:${topicId}:agent:${botUid}`;
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
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]));
  }
  return value;
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

  const targetTopicId = requiredString(packet.targetTopicId, 'targetTopicId');
  const actionTargetTopicId = requiredString(packet.action?.targetTopicId, 'action.targetTopicId');
  const workerTopicId = requiredString(packet.workerTopicId, 'workerTopicId');
  if (targetTopicId !== actionTargetTopicId || targetTopicId !== workerTopicId || targetTopicId !== requiredString(receivedTopicId, 'received topic')) {
    throw new Error('Loop Action packet execution topic does not match the received topic');
  }
  const evidenceTopicId = requiredString(packet.evidenceTopicId, 'evidenceTopicId');
  if (evidenceTopicId === targetTopicId) throw new Error('Loop Action packet evidence topic must differ from execution topic');

  if (requiredString(packet.targetPrincipal, 'targetPrincipal') !== principal || requiredString(packet.action?.targetPrincipal, 'action.targetPrincipal') !== principal) {
    throw new Error('Loop Action packet target principal does not match Bot UID');
  }
  if (requiredString(packet.runtimePrincipal, 'runtimePrincipal') !== principal) {
    throw new Error('Loop Action packet runtime principal does not match Bot UID');
  }
  if (requiredInteger(packet.workItemRevision, 'workItemRevision') !== requiredInteger(packet.action?.workItemRevision, 'action.workItemRevision')) {
    throw new Error('Loop Action packet revision does not match action revision');
  }
  requiredString(packet.actionId, 'actionId');
  requiredString(packet.actionKey, 'actionKey');
  requiredString(packet.workItemId, 'workItemId');
  requiredString(packet.attemptId, 'attemptId');
  requiredInteger(packet.generation, 'generation');
  validateWorkerSessionId(packet.workerSessionId, workerTopicId, botUid);
}

export function buildLoopEvidenceEvent(
  packet: LoopActionPacket,
  receivedTopicId: string,
  botUid: string,
  type: LoopEvidenceType,
): LoopEvidenceEvent {
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

  async send(packet: LoopActionPacket, receivedTopicId: string, type: LoopEvidenceType): Promise<{ seqId: number; event: LoopEvidenceEvent }> {
    const expectedUid = this.botUid;
    if (String(this.options.client.uid || '').trim() !== expectedUid) {
      throw new Error('connected CatsCo client UID does not match configured Bot UID');
    }
    const event = buildLoopEvidenceEvent(packet, receivedTopicId, expectedUid, type);
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

  workerReady(packet: LoopActionPacket, receivedTopicId: string): Promise<{ seqId: number; event: LoopEvidenceEvent }> {
    return this.send(packet, receivedTopicId, 'worker_ready');
  }

  runtimeStarted(packet: LoopActionPacket, receivedTopicId: string): Promise<{ seqId: number; event: LoopEvidenceEvent }> {
    return this.send(packet, receivedTopicId, 'runtime_started');
  }
}
