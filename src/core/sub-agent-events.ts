import { randomUUID } from 'crypto';

export type SubAgentEventType =
  | 'agent_spawned'
  | 'agent_progress'
  | 'agent_tool_start'
  | 'agent_tool_end'
  | 'agent_waiting'
  | 'agent_completed'
  | 'agent_failed'
  | 'agent_stopped'
  | 'artifact_update';

export interface SubAgentRuntimeEvent {
  id: string;
  parentSessionKey: string;
  subAgentId: string;
  subAgentName?: string;
  type: SubAgentEventType;
  timestamp: number;
  seq: number;
  summary: string;
  payload?: Record<string, unknown>;
}

export interface AppendSubAgentEventInput {
  parentSessionKey: string;
  subAgentId: string;
  subAgentName?: string;
  type: SubAgentEventType;
  summary: string;
  payload?: Record<string, unknown>;
  timestamp?: number;
}

export interface SubAgentEventStoreOptions {
  maxEventsPerParent?: number;
  maxEventsPerAgent?: number;
  retentionMs?: number;
}

const DEFAULT_MAX_EVENTS_PER_PARENT = 120;
const DEFAULT_RETENTION_MS = 30 * 60 * 1000;

export class SubAgentEventStore {
  private eventsByParent = new Map<string, SubAgentRuntimeEvent[]>();
  private seqByAgent = new Map<string, number>();
  private maxEventsPerParent: number;
  private maxEventsPerAgent: number;
  private retentionMs: number;

  constructor(options: SubAgentEventStoreOptions = {}) {
    this.maxEventsPerParent = options.maxEventsPerParent ?? DEFAULT_MAX_EVENTS_PER_PARENT;
    this.maxEventsPerAgent = options.maxEventsPerAgent ?? 0;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  }

  append(input: AppendSubAgentEventInput): SubAgentRuntimeEvent {
    const timestamp = input.timestamp ?? Date.now();
    const seqKey = `${input.parentSessionKey}:${input.subAgentId}`;
    const seq = (this.seqByAgent.get(seqKey) ?? 0) + 1;
    this.seqByAgent.set(seqKey, seq);

    const event: SubAgentRuntimeEvent = {
      id: `evt-${randomUUID()}`,
      parentSessionKey: input.parentSessionKey,
      subAgentId: input.subAgentId,
      subAgentName: input.subAgentName,
      type: input.type,
      timestamp,
      seq,
      summary: input.summary,
      payload: input.payload,
    };

    const events = this.eventsByParent.get(input.parentSessionKey) ?? [];
    events.push(event);
    this.eventsByParent.set(input.parentSessionKey, events);
    this.prune(input.parentSessionKey, timestamp);
    return event;
  }

  listByParent(parentSessionKey: string, limit?: number): SubAgentRuntimeEvent[] {
    this.prune(parentSessionKey, Date.now());
    const events = this.eventsByParent.get(parentSessionKey) ?? [];
    if (!limit || events.length <= limit) return [...events];
    return events.slice(-limit);
  }

  listByAgent(parentSessionKey: string, subAgentId: string, limit?: number): SubAgentRuntimeEvent[] {
    const events = this.listByParent(parentSessionKey).filter(event => event.subAgentId === subAgentId);
    if (!limit || events.length <= limit) return events;
    return events.slice(-limit);
  }

  removeAgent(parentSessionKey: string, subAgentId: string): void {
    const events = this.eventsByParent.get(parentSessionKey);
    if (!events) return;
    this.eventsByParent.set(
      parentSessionKey,
      events.filter(event => event.subAgentId !== subAgentId),
    );
    this.seqByAgent.delete(`${parentSessionKey}:${subAgentId}`);
  }

  clearParent(parentSessionKey: string): void {
    this.eventsByParent.delete(parentSessionKey);
    for (const key of this.seqByAgent.keys()) {
      if (key.startsWith(`${parentSessionKey}:`)) {
        this.seqByAgent.delete(key);
      }
    }
  }

  private prune(parentSessionKey: string, now: number): void {
    const events = this.eventsByParent.get(parentSessionKey);
    if (!events || events.length === 0) return;

    const cutoff = now - this.retentionMs;
    let pruned = events.filter(event => event.timestamp >= cutoff);
    const dynamicLimit = this.effectiveLimit(pruned);
    if (pruned.length > dynamicLimit) {
      pruned = pruned.slice(-dynamicLimit);
    }

    if (pruned.length === 0) {
      this.eventsByParent.delete(parentSessionKey);
    } else {
      this.eventsByParent.set(parentSessionKey, pruned);
    }
  }

  private effectiveLimit(events: SubAgentRuntimeEvent[]): number {
    if (this.maxEventsPerAgent <= 0 || events.length === 0) {
      return this.maxEventsPerParent;
    }
    const agentCount = new Set(events.map(event => event.subAgentId)).size;
    return Math.max(this.maxEventsPerParent, agentCount * this.maxEventsPerAgent);
  }
}

export function formatSubAgentEventLine(event: SubAgentRuntimeEvent): string {
  const label = eventTypeLabel(event.type);
  const age = formatEventAge(Date.now() - event.timestamp);
  const agentLabel = event.subAgentName || event.subAgentId;
  return `- [${agentLabel} #${event.seq}] ${label}: ${event.summary} (${age})`;
}

function eventTypeLabel(type: SubAgentEventType): string {
  switch (type) {
    case 'agent_spawned':
      return '已派遣';
    case 'agent_progress':
      return '进度';
    case 'agent_tool_start':
      return '工具开始';
    case 'agent_tool_end':
      return '工具完成';
    case 'agent_waiting':
      return '等待输入';
    case 'agent_completed':
      return '已完成';
    case 'agent_failed':
      return '失败';
    case 'agent_stopped':
      return '已停止';
    case 'artifact_update':
      return '产物更新';
    default:
      return type;
  }
}

function formatEventAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
