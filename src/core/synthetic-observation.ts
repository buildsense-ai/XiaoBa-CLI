import { createHash, randomUUID } from 'crypto';
import { Message } from '../types';
import { annotateContextMessage } from './context-lifecycle';
import {
  collectContextEventIds,
  isValidDurableSyntheticObservationEvent,
} from './context-event-watermarks';

export type SyntheticObservationSource = 'memory' | 'web' | 'runtime' | 'subagent' | 'skill_context';
export type SyntheticObservationStatus = 'completed' | 'partial' | 'failed' | 'cancelled';
export type SyntheticObservationRelevance = 'high' | 'medium' | 'low';
export type SyntheticObservationTiming = 'current_turn' | 'late_previous_turn';
export type SyntheticObservationLifecycleOutcome = 'injected' | 'dropped';

export interface SyntheticObservationEvidence {
  sourceType: SyntheticObservationSource | 'session' | 'file';
  title?: string;
  pathOrUrl?: string;
  locator?: string;
  snippet: string;
  relevanceReason?: string;
}

export interface SyntheticObservationUse {
  shouldUse: boolean;
  howToUse: string;
  conflicts?: string[];
  missingInfo?: string[];
}

export interface SyntheticObservationMetadata {
  branchId?: string;
  branchType?: string;
  refs?: string[];
  timing?: SyntheticObservationTiming;
  originTurn?: number;
  [key: string]: unknown;
}

export interface SyntheticObservation {
  id?: string;
  source: SyntheticObservationSource;
  status: SyntheticObservationStatus;
  relevance: SyntheticObservationRelevance;
  timing?: SyntheticObservationTiming;
  confidence?: number;
  userIntent?: string;
  summary: string;
  keyFacts?: string[];
  evidence?: SyntheticObservationEvidence[];
  recommendedUse?: SyntheticObservationUse;
  debug?: {
    queries?: string[];
    toolsUsed?: string[];
    durationMs?: number;
  };
  metadata?: SyntheticObservationMetadata;
  formattedContent?: string;
  createdAt?: number;
}

export interface SyntheticObservationQueue {
  push(observation: SyntheticObservation): boolean;
  drain(): SyntheticObservation[];
  cancel(): SyntheticObservation[];
  size(): number;
}

export const SYNTHETIC_OBSERVATION_TOOL_NAME = 'runtime_observation';
const DURABLE_MEMORY_OBSERVATION = Symbol('xiaoba.durable_memory_observation');

/**
 * Runtime-only trust boundary for MemorySearchBranchSession publications.
 * The symbol is deliberately private and is never serialized or provider-visible;
 * arbitrary observation payloads cannot opt themselves into persistence.
 */
export function createDurableMemoryObservation<T extends SyntheticObservation & { source: 'memory' }>(
  observation: T,
): T {
  const branchId = observation.metadata?.branchId;
  if (observation.metadata?.branchType !== 'memory' || typeof branchId !== 'string' || !branchId.trim()) {
    throw new Error('durable_memory_observation_attestation_invalid');
  }
  return markDurableMemoryObservation(observation);
}

export class InMemorySyntheticObservationQueue implements SyntheticObservationQueue {
  private observations: SyntheticObservation[] = [];
  private seen = new Set<string>();
  private cancelled = false;

  push(observation: SyntheticObservation): boolean {
    if (this.cancelled) return false;
    const id = observation.id || stableObservationId(observation);
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    const normalized = {
      ...observation,
      id,
      createdAt: observation.createdAt ?? Date.now(),
    };
    this.observations.push(isDurableMemoryObservation(observation)
      ? markDurableMemoryObservation(normalized)
      : normalized);
    return true;
  }

  drain(): SyntheticObservation[] {
    if (this.cancelled || this.observations.length === 0) return [];
    const drained = this.observations;
    this.observations = [];
    return drained;
  }

  cancel(): SyntheticObservation[] {
    const dropped = this.observations;
    this.cancelled = true;
    this.observations = [];
    return dropped;
  }

  size(): number {
    return this.observations.length;
  }
}

export function buildSyntheticObservationMessages(
  observations: SyntheticObservation[],
  options: { existingMessages?: readonly Message[]; episodeId?: string } = {},
): Message[] {
  const messages: Message[] = [];
  const usedToolCallIds = collectToolCallIds(options.existingMessages || []);
  for (const observation of observations) {
    const id = observation.id || stableObservationId(observation);
    const toolArguments = JSON.stringify({
      source: observation.source,
      status: observation.status,
      relevance: observation.relevance,
      timing: resolveObservationTiming(observation),
      confidence: observation.confidence,
    });
    const toolOutput = formatSyntheticObservation(observation);
    const visiblePayloadDigest = createHash('sha256')
      .update(toolArguments)
      .update('\0')
      .update(toolOutput)
      .digest('hex')
      .slice(0, 20);
    const persistence = isDurableMemoryObservation(observation) ? 'durable' : 'transient';
    const eventId = `synthetic_observation:${observation.source}:${visiblePayloadDigest}`;
    if (persistence === 'durable') {
      const priorMessages = [...(options.existingMessages || []), ...messages];
      const existingEvent = collectContextEventParts(priorMessages, eventId);
      if (existingEvent.length > 0) {
        if (matchesExistingSyntheticEvent(existingEvent, toolArguments, toolOutput)) continue;
        throw new Error('synthetic_observation_event_conflict');
      }
      if (collectContextEventIds(priorMessages).has(eventId)) continue;
    }
    // Provider-visible IDs participate in exact-prefix cache identity. Keep
    // them deterministic for equivalent visible observations while retaining
    // the unique internal observation/branch IDs below for audit correlation.
    const toolCallIdPrefix = `synthetic-${observation.source}-${visiblePayloadDigest}`;
    let ordinal = 1;
    while (usedToolCallIds.has(`${toolCallIdPrefix}-${ordinal}`)) ordinal++;
    const toolCallId = `${toolCallIdPrefix}-${ordinal}`;
    usedToolCallIds.add(toolCallId);
    const provenance = observationProvenance(observation);
    messages.push(annotateContextMessage({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: toolCallId,
        type: 'function',
        function: {
          name: SYNTHETIC_OBSERVATION_TOOL_NAME,
          arguments: toolArguments,
        },
      }],
      __syntheticObservation: true,
      syntheticObservationId: id,
      ...(options.episodeId ? { __episodeId: options.episodeId } : {}),
      ...(provenance ? { syntheticObservationProvenance: provenance } : {}),
    }, {
      source: 'synthetic_observation',
      lifecycle: 'episode',
      cacheScope: 'epoch',
      persistence,
      placement: 'transcript',
      retention: persistence === 'durable' ? 'append' : 'request',
      event: { id: eventId, part: 0, parts: 2 },
    }));
    messages.push(annotateContextMessage({
      role: 'tool',
      name: SYNTHETIC_OBSERVATION_TOOL_NAME,
      tool_call_id: toolCallId,
      content: toolOutput,
      __syntheticObservation: true,
      syntheticObservationId: id,
      ...(options.episodeId ? { __episodeId: options.episodeId } : {}),
      ...(provenance ? { syntheticObservationProvenance: provenance } : {}),
    }, {
      source: 'synthetic_observation',
      lifecycle: 'episode',
      cacheScope: 'epoch',
      persistence,
      placement: 'transcript',
      retention: persistence === 'durable' ? 'append' : 'request',
      event: { id: eventId, part: 1, parts: 2 },
    }));
  }
  return messages;
}

/** Drops every malformed durable synthetic event as one atomic unit. */
export function filterValidDurableSyntheticObservationEvents(messages: Message[]): Message[] {
  const candidates = new Set(messages.filter(isCandidateDurableSyntheticMessage));
  const candidateCallIds = new Set<string>();
  for (const message of candidates) {
    for (const call of message.tool_calls || []) {
      if (call.id) candidateCallIds.add(call.id);
    }
    if (message.tool_call_id) candidateCallIds.add(message.tool_call_id);
  }
  for (const message of messages) {
    if (
      (message.role === 'tool' && message.tool_call_id && candidateCallIds.has(message.tool_call_id))
      || (message.role === 'assistant'
        && message.tool_calls?.some(call => candidateCallIds.has(call.id)))
    ) candidates.add(message);
  }
  const groups = new Map<string, Message[]>();
  for (const message of messages) {
    if (!candidates.has(message)) continue;
    const eventId = message.__context?.event?.id;
    if (typeof eventId !== 'string') continue;
    const group = groups.get(eventId) || [];
    group.push(message);
    groups.set(eventId, group);
  }

  const validMessages = new Set<Message>();
  for (const group of groups.values()) {
    if (!isValidDurableSyntheticObservationEvent(group)) continue;
    for (const message of group) validMessages.add(message);
  }
  return messages.filter(message => !candidates.has(message) || validMessages.has(message));
}

function collectContextEventParts(messages: readonly Message[], eventId: string): Message[] {
  return messages.filter(message => message.__context?.event?.id === eventId);
}

function matchesExistingSyntheticEvent(
  messages: readonly Message[],
  toolArguments: string,
  toolOutput: string,
): boolean {
  if (!isValidDurableSyntheticObservationEvent(messages)) return false;
  const assistant = messages.find(message => message.__context?.event?.part === 0);
  const tool = messages.find(message => message.__context?.event?.part === 1);
  if (!assistant || !tool) return false;
  const call = assistant.tool_calls?.[0];
  if (!call) return false;
  return call.function.arguments === toolArguments && tool.content === toolOutput;
}

function isCandidateDurableSyntheticMessage(message: Message): boolean {
  return message.__syntheticObservation === true
    || message.__context?.source === 'synthetic_observation'
    || message.name === SYNTHETIC_OBSERVATION_TOOL_NAME
    || Boolean(message.tool_calls?.some(call => call.function.name === SYNTHETIC_OBSERVATION_TOOL_NAME));
}

function isDurableMemoryObservation(observation: SyntheticObservation): boolean {
  const branchId = observation.metadata?.branchId;
  return (observation as any)[DURABLE_MEMORY_OBSERVATION] === true
    && observation.source === 'memory'
    && observation.metadata?.branchType === 'memory'
    && typeof branchId === 'string'
    && Boolean(branchId.trim());
}

function markDurableMemoryObservation<T extends SyntheticObservation>(observation: T): T {
  Object.defineProperty(observation, DURABLE_MEMORY_OBSERVATION, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return observation;
}

function inheritDurableMemoryAttestation<T extends SyntheticObservation>(
  source: SyntheticObservation,
  clone: T,
): T {
  return isDurableMemoryObservation(source) && clone.source === 'memory'
    ? markDurableMemoryObservation(clone)
    : clone;
}

function collectToolCallIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const toolCall of message.tool_calls || []) {
      const id = toolCall.id?.trim();
      if (id) ids.add(id);
    }
    const resultId = message.tool_call_id?.trim();
    if (resultId) ids.add(resultId);
  }
  return ids;
}

function observationProvenance(
  observation: SyntheticObservation,
): Message['syntheticObservationProvenance'] | undefined {
  const branchId = typeof observation.metadata?.branchId === 'string'
    ? observation.metadata.branchId.trim()
    : '';
  const branchType = typeof observation.metadata?.branchType === 'string'
    ? observation.metadata.branchType.trim()
    : '';
  if (!branchId || !branchType) return undefined;
  return { branchId, branchType };
}

export function formatSyntheticObservation(observation: SyntheticObservation): string {
  if (observation.formattedContent !== undefined) {
    return observation.formattedContent;
  }

  const lines: string[] = [
    `[runtime_observation:${observation.source}]`,
    `status: ${observation.status}`,
    `relevance: ${observation.relevance}`,
    `timing: ${resolveObservationTiming(observation)}`,
  ];
  if (typeof observation.confidence === 'number') {
    lines.push(`confidence: ${Math.max(0, Math.min(1, observation.confidence)).toFixed(2)}`);
  }
  if (observation.userIntent) {
    lines.push(`user_intent: ${observation.userIntent}`);
  }
  lines.push('', 'summary:', observation.summary.trim() || '(empty)');

  if (observation.keyFacts?.length) {
    lines.push('', 'key_facts:');
    for (const fact of observation.keyFacts.slice(0, 8)) {
      lines.push(`- ${normalizeLine(fact)}`);
    }
  }

  if (observation.evidence?.length) {
    lines.push('', 'evidence:');
    for (const item of observation.evidence.slice(0, 8)) {
      const source = [
        item.sourceType,
        item.title,
        item.pathOrUrl,
        item.locator,
      ].filter(Boolean).join(' | ');
      lines.push(`- ${source}`);
      lines.push(`  snippet: ${normalizeLine(item.snippet)}`);
      if (item.relevanceReason) {
        lines.push(`  why: ${normalizeLine(item.relevanceReason)}`);
      }
    }
  }

  if (observation.recommendedUse) {
    lines.push('', 'recommended_use:');
    lines.push(`should_use: ${observation.recommendedUse.shouldUse ? 'true' : 'false'}`);
    lines.push(`how: ${normalizeLine(observation.recommendedUse.howToUse)}`);
    if (observation.recommendedUse.conflicts?.length) {
      lines.push(`conflicts: ${observation.recommendedUse.conflicts.map(normalizeLine).join('; ')}`);
    }
    if (observation.recommendedUse.missingInfo?.length) {
      lines.push(`missing_info: ${observation.recommendedUse.missingInfo.map(normalizeLine).join('; ')}`);
    }
  }

  if (observation.debug) {
    lines.push('', 'debug:');
    if (observation.debug.queries?.length) lines.push(`queries: ${observation.debug.queries.join(' | ')}`);
    if (observation.debug.toolsUsed?.length) lines.push(`tools: ${observation.debug.toolsUsed.join(', ')}`);
    if (typeof observation.debug.durationMs === 'number') lines.push(`duration_ms: ${observation.debug.durationMs}`);
  }

  return lines.join('\n');
}

export function describeSyntheticObservationForLog(observation: SyntheticObservation): string {
  const id = String(observation.id || '').trim() || '(unassigned)';
  const metadata = observation.metadata || {};
  const timing = resolveObservationTiming(observation);
  const parts = [
    `id=${id}`,
    `source=${observation.source}`,
    `status=${observation.status}`,
    `relevance=${observation.relevance}`,
    `timing=${timing}`,
  ];
  if (metadata.branchType || metadata.branchId) {
    parts.push(`branch=${[metadata.branchType, metadata.branchId].filter(Boolean).join(':')}`);
  }
  if (Array.isArray(metadata.refs) && metadata.refs.length > 0) {
    parts.push(`refs=${metadata.refs.slice(0, 6).join(',')}${metadata.refs.length > 6 ? `,+${metadata.refs.length - 6}` : ''}`);
  }
  const summary = normalizeLine(observation.summary);
  if (summary) {
    parts.push(`summary="${truncate(summary, 220).replace(/\n/g, ' ')}"`);
  }
  return parts.join(' ');
}

export function buildSyntheticObservationLifecycleEvent(
  observation: SyntheticObservation,
  options: {
    outcome: SyntheticObservationLifecycleOutcome;
    reason?: string;
    originTurn?: number;
  },
): { type: string; payload: Record<string, unknown> } {
  const metadata = observation.metadata || {};
  const refs = Array.isArray(metadata.refs)
    ? metadata.refs.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0)
    : [];
  const originTurn = typeof options.originTurn === 'number'
    ? options.originTurn
    : typeof metadata.originTurn === 'number'
      ? metadata.originTurn
      : undefined;
  const payload: Record<string, unknown> = {
    outcome: options.outcome,
    observation_id: String(observation.id || '').trim() || '(unassigned)',
    source: observation.source,
    timing: resolveObservationTiming(observation),
  };
  if (options.reason) payload.reason = options.reason;
  if (typeof originTurn === 'number') payload.origin_turn = originTurn;
  if (typeof metadata.branchId === 'string' && metadata.branchId) payload.branch_id = metadata.branchId;
  if (typeof metadata.branchType === 'string' && metadata.branchType) payload.branch_type = metadata.branchType;
  if (refs.length > 0) payload.refs = refs;
  return {
    type: 'synthetic_observation_lifecycle',
    payload,
  };
}

export function withSyntheticObservationTiming(
  observation: SyntheticObservation,
  timing: SyntheticObservationTiming,
): SyntheticObservation {
  const next: SyntheticObservation = {
    ...observation,
    timing,
    metadata: {
      ...(observation.metadata || {}),
      timing,
    },
  };

  if (observation.formattedContent !== undefined) {
    next.formattedContent = formatTimedObservationContent(observation.formattedContent, timing);
  }

  return inheritDurableMemoryAttestation(observation, next);
}

export function withSyntheticObservationMetadata(
  observation: SyntheticObservation,
  metadata: SyntheticObservationMetadata,
): SyntheticObservation {
  return inheritDurableMemoryAttestation(observation, {
    ...observation,
    metadata: { ...metadata },
  });
}

function resolveObservationTiming(observation: SyntheticObservation): SyntheticObservationTiming {
  return observation.timing || observation.metadata?.timing || 'current_turn';
}

function formatTimedObservationContent(content: string, timing: SyntheticObservationTiming): string {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return JSON.stringify({
        ...parsed,
        timing,
      });
    }
  } catch {
    // Keep non-JSON formatted content unchanged.
  }
  return content;
}

function stableObservationId(observation: SyntheticObservation): string {
  const explicit = String(observation.id || '').trim();
  if (explicit) return sanitizeId(explicit);
  const basis = [
    observation.source,
    observation.status,
    observation.relevance,
    observation.summary,
    ...(observation.keyFacts || []),
  ].join('\n');
  return sanitizeId(`${Date.now().toString(36)}-${hashString(basis)}-${randomUUID().slice(0, 8)}`);
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) || randomUUID();
}

function normalizeLine(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated, original ${value.length} chars]`;
}

function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}
