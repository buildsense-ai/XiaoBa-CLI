import { randomUUID } from 'crypto';
import { Message } from '../types';

export type SyntheticObservationSource = 'memory' | 'web' | 'runtime' | 'subagent' | 'skill_context';
export type SyntheticObservationStatus = 'completed' | 'partial' | 'failed' | 'cancelled';
export type SyntheticObservationRelevance = 'high' | 'medium' | 'low';
export type SyntheticObservationTiming = 'current_turn' | 'late_previous_turn';

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
            timing: resolveObservationTiming(observation),
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

  return next;
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
