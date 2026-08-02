import { createHash } from 'crypto';
import type { Message } from '../types';

const SYNTHETIC_OBSERVATION_TOOL_NAME = 'runtime_observation';

/**
 * Exact durable event IDs already represented by the transcript or a
 * compaction checkpoint. These are internal idempotency keys, never provider
 * cache keys and never execution authority.
 */
export function collectContextEventIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>();
  const groups = new Map<string, {
    parts?: number;
    seen: Set<number>;
    invalid: boolean;
    messages: Message[];
  }>();
  for (const message of messages) {
    if (
      message.__context?.source === 'compaction_summary'
      && message.__context.persistence === 'durable'
    ) {
      for (const id of message.__contextEventIds || []) record(ids, id);
    }
    const event = message.__context?.retention === 'append'
      ? message.__context.event
      : undefined;
    if (!event || !validId(event.id)) continue;
    const group = groups.get(event.id) || { seen: new Set<number>(), invalid: false, messages: [] };
    group.messages.push(message);
    if (
      !Number.isInteger(event.parts)
      || event.parts < 1
      || event.parts > 64
      || !Number.isInteger(event.part)
      || event.part < 0
      || event.part >= event.parts
      || (group.parts !== undefined && group.parts !== event.parts)
      || group.seen.has(event.part)
    ) {
      group.invalid = true;
    } else {
      group.parts = event.parts;
      group.seen.add(event.part);
    }
    groups.set(event.id, group);
  }
  for (const [id, group] of groups) {
    if (
      !group.invalid
      && group.parts !== undefined
      && group.seen.size === group.parts
      && isValidDurableSyntheticObservationEvent(group.messages)
    ) {
      ids.add(id);
    }
  }
  return ids;
}

export function isValidDurableSyntheticObservationEvent(messages: readonly Message[]): boolean {
  if (messages.length !== 2) return false;
  const assistant = messages.find(message => message.__context?.event?.part === 0);
  const tool = messages.find(message => message.__context?.event?.part === 1);
  if (
    !assistant
    || !tool
    || !hasDurableEventContext(assistant)
    || !hasDurableEventContext(tool)
    || assistant.__context?.event?.parts !== 2
    || tool.__context?.event?.parts !== 2
    || assistant.__context.event.id !== tool.__context.event.id
    || assistant.role !== 'assistant'
    || assistant.tool_calls?.length !== 1
    || assistant.content !== null
    || tool.role !== 'tool'
  ) return false;
  const call = assistant.tool_calls?.[0];
  const assistantBranchId = assistant.syntheticObservationProvenance?.branchId;
  const toolBranchId = tool.syntheticObservationProvenance?.branchId;
  if (
    !call
    || call.type !== 'function'
    || call.function.name !== SYNTHETIC_OBSERVATION_TOOL_NAME
    || tool.name !== SYNTHETIC_OBSERVATION_TOOL_NAME
    || tool.tool_call_id !== call.id
    || typeof call.function.arguments !== 'string'
    || typeof tool.content !== 'string'
    || assistant.syntheticObservationId !== tool.syntheticObservationId
    || typeof assistant.syntheticObservationId !== 'string'
    || !assistant.syntheticObservationId.trim()
    || assistant.__episodeId !== tool.__episodeId
    || assistant.syntheticObservationProvenance?.branchType !== 'memory'
    || tool.syntheticObservationProvenance?.branchType !== 'memory'
    || typeof assistantBranchId !== 'string'
    || !assistantBranchId.trim()
    || typeof toolBranchId !== 'string'
    || !toolBranchId.trim()
    || assistantBranchId !== toolBranchId
  ) return false;
  let source: unknown;
  try {
    source = JSON.parse(call.function.arguments).source;
  } catch {
    return false;
  }
  if (source !== 'memory') return false;
  const digest = createHash('sha256')
    .update(call.function.arguments)
    .update('\0')
    .update(tool.content)
    .digest('hex')
    .slice(0, 20);
  return assistant.__context.event.id === `synthetic_observation:memory:${digest}`
    && new RegExp(`^synthetic-memory-${digest}-[1-9][0-9]*$`).test(call.id)
    && assistant.providerContent === undefined
    && assistant.providerState === undefined
    && tool.providerContent === undefined
    && tool.providerState === undefined;
}

function record(ids: Set<string>, value: unknown): void {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!validId(id)) return;
  ids.add(id);
}

function validId(value: unknown): value is string {
  return typeof value === 'string'
    && /^synthetic_observation:[a-z_]+:[a-f0-9]{20}$/.test(value);
}

function hasDurableEventContext(message: Message): boolean {
  return message.__syntheticObservation === true
    && message.__cacheScope === 'dynamic'
    && message.__context?.schema === 'xiaoba.context_lifecycle.v1'
    && message.__context?.source === 'synthetic_observation'
    && message.__context.lifecycle === 'episode'
    && message.__context.cacheScope === 'epoch'
    && message.__context.persistence === 'durable'
    && message.__context.placement === 'transcript'
    && message.__context.retention === 'append';
}
