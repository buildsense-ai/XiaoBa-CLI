import { randomUUID } from 'crypto';
import { Message } from '../types';

export type SyntheticObservationSource = 'memory' | 'web' | 'runtime' | 'subagent' | 'skill_context';
export type SyntheticObservationStatus = 'completed' | 'partial' | 'failed' | 'cancelled';
export type SyntheticObservationRelevance = 'high' | 'medium' | 'low';

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

export interface SyntheticObservation {
  id?: string;
  source: SyntheticObservationSource;
  status: SyntheticObservationStatus;
  relevance: SyntheticObservationRelevance;
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
  createdAt?: number;
}

export interface SyntheticObservationQueue {
  push(observation: SyntheticObservation): boolean;
  drain(): SyntheticObservation[];
  cancel(): void;
  size(): number;
}

export const SYNTHETIC_OBSERVATION_TOOL_NAME = 'runtime_observation';
const MAX_SYNTHETIC_OBSERVATION_CHARS = 8000;

export class InMemorySyntheticObservationQueue implements SyntheticObservationQueue {
  private observations: SyntheticObservation[] = [];
  private seen = new Set<string>();
  private cancelled = false;

  push(observation: SyntheticObservation): boolean {
    if (this.cancelled) return false;
    const id = observation.id || stableObservationId(observation);
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.observations.push({
      ...observation,
      id,
      createdAt: observation.createdAt ?? Date.now(),
    });
    return true;
  }

  drain(): SyntheticObservation[] {
    if (this.cancelled || this.observations.length === 0) return [];
    const drained = this.observations;
    this.observations = [];
    return drained;
  }

  cancel(): void {
    this.cancelled = true;
    this.observations = [];
  }

  size(): number {
    return this.observations.length;
  }
}

export function buildSyntheticObservationMessages(
  observations: SyntheticObservation[],
): Message[] {
  const messages: Message[] = [];
  for (const observation of observations) {
    const id = observation.id || stableObservationId(observation);
    const toolCallId = `synthetic-${observation.source}-${id}`;
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: toolCallId,
        type: 'function',
        function: {
          name: SYNTHETIC_OBSERVATION_TOOL_NAME,
          arguments: JSON.stringify({
            source: observation.source,
            status: observation.status,
            relevance: observation.relevance,
            confidence: observation.confidence,
          }),
        },
      }],
      __syntheticObservation: true,
      syntheticObservationId: id,
    });
    messages.push({
      role: 'tool',
      name: SYNTHETIC_OBSERVATION_TOOL_NAME,
      tool_call_id: toolCallId,
      content: formatSyntheticObservation(observation),
      __syntheticObservation: true,
      syntheticObservationId: id,
    });
  }
  return messages;
}

export function formatSyntheticObservation(observation: SyntheticObservation): string {
  const lines: string[] = [
    `[runtime_observation:${observation.source}]`,
    `status: ${observation.status}`,
    `relevance: ${observation.relevance}`,
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

  return truncate(lines.join('\n'), MAX_SYNTHETIC_OBSERVATION_CHARS);
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
