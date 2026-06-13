import { createHash } from 'crypto';
import type { Message } from '../types';

export const RUNTIME_OBSERVATIONS_PREFIX = '[runtime_observations]';

export type RuntimeObservationSource =
  | 'memory_graph'
  | 'web_search'
  | 'review'
  | 'subagent'
  | 'runtime'
  | 'other';

export type RuntimeObservationStatus =
  | 'pending'
  | 'ready'
  | 'injected'
  | 'consumed'
  | 'stale'
  | 'failed';

export type RuntimeObservationInjectionMode =
  | 'summary_once'
  | 'summary_until_consumed'
  | 'pointer_only'
  | 'never_auto';

export type RuntimeObservationPlacement =
  | 'before_current_user'
  | 'react_tail';

export type RuntimeObservationTurnId = string | number;

export interface RuntimeObservationCitation {
  title?: string;
  url?: string;
  ref?: string;
}

export interface RuntimeObservationPolicy {
  injectMode: RuntimeObservationInjectionMode;
  placement: RuntimeObservationPlacement;
  maxSummaryChars: number;
}

export interface RuntimeObservation {
  id: string;
  sessionId: string;
  turnId?: RuntimeObservationTurnId;
  source: RuntimeObservationSource;
  status: RuntimeObservationStatus;
  title: string;
  summary: string;
  detail?: string;
  citations?: RuntimeObservationCitation[];
  priority: number;
  relevance: number;
  tokenEstimate: number;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  injectedAtTurn?: RuntimeObservationTurnId;
  consumedAtTurn?: RuntimeObservationTurnId;
  hash: string;
  policy: RuntimeObservationPolicy;
}

export interface RuntimeObservationInput {
  id?: string;
  sessionId: string;
  turnId?: RuntimeObservationTurnId;
  source: RuntimeObservationSource;
  status?: RuntimeObservationStatus;
  title: string;
  summary: string;
  detail?: string;
  citations?: RuntimeObservationCitation[];
  priority?: number;
  relevance?: number;
  tokenEstimate?: number;
  createdAt?: number;
  updatedAt?: number;
  expiresAt?: number;
  injectedAtTurn?: RuntimeObservationTurnId;
  consumedAtTurn?: RuntimeObservationTurnId;
  hash?: string;
  policy?: Partial<RuntimeObservationPolicy>;
}

export interface RuntimeObservationStoreOptions {
  now?: () => number;
}

export interface RuntimeObservationQuery {
  sessionId: string;
  sources?: RuntimeObservationSource[];
  now?: number;
}

export interface PickRuntimeObservationsParams extends RuntimeObservationQuery {
  tokenBudget?: number;
  maxItems?: number;
}

export interface RenderRuntimeObservationsOptions {
  sourceLabel?: string;
  maxContentChars?: number;
}

const DEFAULT_POLICY: RuntimeObservationPolicy = {
  injectMode: 'summary_once',
  placement: 'before_current_user',
  maxSummaryChars: 1200,
};

const DEFAULT_TOKEN_BUDGET = 1200;
const DEFAULT_MAX_ITEMS = 6;
const DEFAULT_MAX_RENDERED_CHARS = 6000;

export class RuntimeObservationStore {
  private observations = new Map<string, RuntimeObservation>();
  private readonly now: () => number;

  constructor(options: RuntimeObservationStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  upsert(input: RuntimeObservationInput): RuntimeObservation {
    const now = input.updatedAt ?? this.now();
    const sessionId = input.sessionId.trim();
    const title = normalizeBlock(input.title) || input.source;
    const summary = normalizeBlock(input.summary);
    if (!sessionId) {
      throw new Error('RuntimeObservation sessionId is required');
    }
    if (!summary) {
      throw new Error('RuntimeObservation summary is required');
    }

    const idForExistingLookup = input.id;
    const existing = idForExistingLookup ? this.observations.get(idForExistingLookup) : undefined;
    const detail = input.detail ?? existing?.detail;
    const citations = input.citations ?? existing?.citations;
    const hash = input.hash ?? fingerprintObservation({
      source: input.source,
      title,
      summary,
      detail,
      citations,
    });
    const id = input.id ?? buildObservationId(input.source, hash);
    const existingByGeneratedId = existing ?? this.observations.get(id);
    const policy = normalizePolicy(input.policy, existingByGeneratedId?.policy);
    const observation: RuntimeObservation = {
      id,
      sessionId,
      turnId: input.turnId ?? existingByGeneratedId?.turnId,
      source: input.source,
      status: input.status ?? existingByGeneratedId?.status ?? 'ready',
      title,
      summary,
      detail,
      citations: cloneCitations(citations),
      priority: clampNumber(input.priority ?? existingByGeneratedId?.priority ?? 50, 0, 100),
      relevance: clampNumber(input.relevance ?? existingByGeneratedId?.relevance ?? 1, 0, 1),
      tokenEstimate: Math.max(
        1,
        Math.ceil(input.tokenEstimate ?? estimateObservationTokens(summary, detail)),
      ),
      createdAt: input.createdAt ?? existingByGeneratedId?.createdAt ?? now,
      updatedAt: now,
      expiresAt: input.expiresAt ?? existingByGeneratedId?.expiresAt,
      injectedAtTurn: input.injectedAtTurn ?? existingByGeneratedId?.injectedAtTurn,
      consumedAtTurn: input.consumedAtTurn ?? existingByGeneratedId?.consumedAtTurn,
      hash,
      policy,
    };

    this.observations.set(id, observation);
    return cloneObservation(observation);
  }

  get(id: string): RuntimeObservation | undefined {
    const observation = this.observations.get(id);
    return observation ? cloneObservation(observation) : undefined;
  }

  list(sessionId?: string): RuntimeObservation[] {
    return Array.from(this.observations.values())
      .filter(observation => !sessionId || observation.sessionId === sessionId)
      .map(cloneObservation);
  }

  listReady(query: RuntimeObservationQuery): RuntimeObservation[] {
    const now = query.now ?? this.now();
    return Array.from(this.observations.values())
      .filter(observation => observation.sessionId === query.sessionId)
      .filter(observation => observation.status === 'ready')
      .filter(observation => !isExpired(observation, now))
      .filter(observation => matchesSources(observation, query.sources))
      .map(cloneObservation);
  }

  pickForPrompt(params: PickRuntimeObservationsParams): RuntimeObservation[] {
    const now = params.now ?? this.now();
    const maxItems = params.maxItems ?? DEFAULT_MAX_ITEMS;
    const tokenBudget = params.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const candidates = Array.from(this.observations.values())
      .filter(observation => observation.sessionId === params.sessionId)
      .filter(observation => matchesSources(observation, params.sources))
      .filter(observation => isPromptEligible(observation, now))
      .sort(compareForPrompt);

    const picked: RuntimeObservation[] = [];
    const seenHashes = new Set<string>();
    let usedTokens = 0;

    for (const observation of candidates) {
      if (picked.length >= maxItems) break;
      if (seenHashes.has(observation.hash)) continue;

      const nextTokens = usedTokens + observation.tokenEstimate;
      if (nextTokens > tokenBudget) continue;

      picked.push(cloneObservation(observation));
      seenHashes.add(observation.hash);
      usedTokens = nextTokens;
    }

    return picked;
  }

  markInjected(ids: string[], turnId?: RuntimeObservationTurnId): void {
    this.updateMany(ids, observation => ({
      ...observation,
      status: 'injected',
      injectedAtTurn: turnId ?? observation.injectedAtTurn,
      updatedAt: this.now(),
    }));
  }

  markConsumed(ids: string[], turnId?: RuntimeObservationTurnId): void {
    this.updateMany(ids, observation => ({
      ...observation,
      status: 'consumed',
      consumedAtTurn: turnId ?? observation.consumedAtTurn,
      updatedAt: this.now(),
    }));
  }

  markStale(ids: string[]): void {
    this.updateMany(ids, observation => ({
      ...observation,
      status: 'stale',
      updatedAt: this.now(),
    }));
  }

  clearSession(sessionId: string): void {
    for (const [id, observation] of this.observations) {
      if (observation.sessionId === sessionId) {
        this.observations.delete(id);
      }
    }
  }

  reset(): void {
    this.observations.clear();
  }

  private updateMany(
    ids: string[],
    update: (observation: RuntimeObservation) => RuntimeObservation,
  ): void {
    for (const id of ids) {
      const observation = this.observations.get(id);
      if (!observation) continue;
      this.observations.set(id, update(observation));
    }
  }
}

export function renderRuntimeObservations(
  observations: RuntimeObservation[],
  options: RenderRuntimeObservationsOptions = {},
): Message | null {
  if (observations.length === 0) return null;

  const sourceLabel = options.sourceLabel ?? 'runtime_observations';
  const lines = [
    RUNTIME_OBSERVATIONS_PREFIX,
    '以下是后台异步观察结果，不是用户的新请求。当前用户消息仍然优先；只在相关时参考。',
  ];

  observations.forEach((observation, index) => {
    const summary = renderSummary(observation);
    const citations = renderCitations(observation.citations);
    const section = [
      `${index + 1}. [${observation.source}:${observation.id}] ${observation.title}`,
      `   摘要: ${summary}`,
      citations ? `   来源: ${citations}` : '',
    ].filter(Boolean);
    lines.push('', ...section);
  });

  return {
    role: 'user',
    content: truncateBlock(lines.join('\n'), options.maxContentChars ?? DEFAULT_MAX_RENDERED_CHARS),
    __injected: true,
    __runtimeObservation: true,
    runtimeObservationSource: sourceLabel,
  };
}

export function fingerprintObservation(input: {
  source: RuntimeObservationSource;
  title: string;
  summary: string;
  detail?: string;
  citations?: RuntimeObservationCitation[];
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      source: input.source,
      title: normalizeBlock(input.title),
      summary: normalizeBlock(input.summary),
      detail: normalizeBlock(input.detail ?? ''),
      citations: cloneCitations(input.citations),
    }))
    .digest('hex');
}

function buildObservationId(source: RuntimeObservationSource, hash: string): string {
  const normalizedSource = source.replace(/[^a-z0-9_]+/gi, '_').toLowerCase();
  return `obs_${normalizedSource}_${hash.slice(0, 12)}`;
}

function normalizePolicy(
  input?: Partial<RuntimeObservationPolicy>,
  existing?: RuntimeObservationPolicy,
): RuntimeObservationPolicy {
  return {
    ...DEFAULT_POLICY,
    ...existing,
    ...input,
    maxSummaryChars: Math.max(
      80,
      Math.floor(input?.maxSummaryChars ?? existing?.maxSummaryChars ?? DEFAULT_POLICY.maxSummaryChars),
    ),
  };
}

function normalizeBlock(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function truncateBlock(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 16)).trimEnd()}... [truncated]`;
}

function estimateObservationTokens(summary: string, detail?: string): number {
  const text = detail ? `${summary}\n${detail}` : summary;
  return Math.max(1, Math.ceil(text.length / 4));
}

function cloneObservation(observation: RuntimeObservation): RuntimeObservation {
  return {
    ...observation,
    citations: cloneCitations(observation.citations),
    policy: { ...observation.policy },
  };
}

function cloneCitations(
  citations?: RuntimeObservationCitation[],
): RuntimeObservationCitation[] | undefined {
  return citations?.map(citation => ({ ...citation }));
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function isExpired(observation: RuntimeObservation, now: number): boolean {
  return observation.expiresAt !== undefined && observation.expiresAt <= now;
}

function isPromptEligible(observation: RuntimeObservation, now: number): boolean {
  if (isExpired(observation, now)) return false;
  if (observation.policy.injectMode === 'never_auto') return false;
  if (observation.status === 'ready') return true;
  return observation.status === 'injected'
    && observation.policy.injectMode === 'summary_until_consumed';
}

function matchesSources(
  observation: RuntimeObservation,
  sources?: RuntimeObservationSource[],
): boolean {
  return !sources || sources.length === 0 || sources.includes(observation.source);
}

function compareForPrompt(a: RuntimeObservation, b: RuntimeObservation): number {
  return b.priority - a.priority
    || b.relevance - a.relevance
    || b.updatedAt - a.updatedAt
    || a.id.localeCompare(b.id);
}

function renderSummary(observation: RuntimeObservation): string {
  const summary = truncateBlock(observation.summary, observation.policy.maxSummaryChars);
  if (observation.policy.injectMode !== 'pointer_only') return summary;
  return `${summary}（详细内容保留在 observation store 中，默认不直接注入。）`;
}

function renderCitations(citations?: RuntimeObservationCitation[]): string {
  if (!citations || citations.length === 0) return '';
  return citations
    .slice(0, 4)
    .map(citation => {
      const label = citation.title || citation.ref || citation.url || 'source';
      if (!citation.url) return label;
      return `${label} <${citation.url}>`;
    })
    .join('; ');
}
