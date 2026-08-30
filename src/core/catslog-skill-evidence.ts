import {
  isSafeCatsLogOpaqueIdentifier,
  isSafeCatsLogSkillHandle,
} from '../utils/catsco-log-agent-client';
import { isMemoryCitationRef } from '../tools/memory-branch-tools';

/**
 * Safe, model-independent evidence collected at the branch seam.
 *
 * This deliberately stores only projected citations and bounded metadata. In
 * particular, a CatsLog retrieval receipt is never copied into this object or
 * any observation built from it.
 */
export interface CatsLogSkillProvenance {
  schema: 'catslog.branch.provenance.v1';
  toolsUsed: string[];
  candidateRefs: string[];
  activeRefs: string[];
  bodyReadRefs: string[];
  receiptEligibleRefs: string[];
  lineage: Array<{
    type?: string;
    targetRef?: string;
  }>;
  routes: Array<{
    routeId: string;
    hop?: number;
    edgeKey?: string;
  }>;
  catalogRevision?: number;
  bodyReadCount: number;
  outcomeAttempts: number;
  outcomeAccepted: number;
  outcomeRejected: number;
  outcomeStatus: 'not_attempted' | 'pending' | 'accepted' | 'rejected';
  /** The receipt itself stays provider-private; this is only a safe inference. */
  receiptState: 'not_observed' | 'inferred_from_body_read';
  versionStatus: 'verified' | 'mismatch' | 'unknown';
}

export function hasCatsLogSkillCitation(refs: readonly string[]): boolean {
  return catsLogSkillCitations(refs).length > 0;
}

export function catsLogSkillCitations(refs: readonly string[]): string[] {
  if (!Array.isArray(refs)) return [];
  return Array.from(new Set(refs.map(skillRef).filter((value): value is string => Boolean(value))));
}

interface ToolStartRecord {
  name: string;
  includeContent: boolean;
  /** Exact Skill target when a tool call names one. */
  skillRef?: string;
}

const MAX_TOOLS = 24;
const MAX_REFS = 64;
const MAX_LINEAGE = 64;
const MAX_ROUTES = 32;
const MAX_TEXT = 256;

/**
 * Collates evidence from the actual CatsLog tool seam. The branch model may
 * choose which tools to call, but it cannot fabricate the values returned by
 * this tracker.
 */
export class CatsLogSkillEvidenceTracker {
  private readonly tools = new Set<string>();
  private readonly candidateRefs = new Set<string>();
  private readonly activeRefs = new Set<string>();
  private readonly bodyReadRefs = new Set<string>();
  private readonly receiptEligibleRefs = new Set<string>();
  private readonly lineage: Array<{ type?: string; targetRef?: string }> = [];
  private readonly routes = new Map<string, { routeId: string; hop?: number; edgeKey?: string }>();
  private readonly starts = new Map<string, ToolStartRecord>();
  private readonly outcomeStatusByRef = new Map<string, 'pending' | 'accepted' | 'rejected'>();
  private catalogRevision?: number;
  private bodyReadCount = 0;
  private outcomeAttempts = 0;
  private outcomeAccepted = 0;
  private outcomeRejected = 0;
  private outcomePending = 0;
  private lastOutcomeStatus: 'pending' | 'accepted' | 'rejected' | null = null;

  recordToolStart(name: string, toolUseId: string, input: unknown): void {
    if (isCatsLogTool(name)) addBounded(this.tools, name, MAX_TOOLS);
    if (name === 'catslog_skill_memory' || name === 'catslog_skill_catalog') {
      const source = asRecord(input);
      this.observeRoute(source);
      this.starts.set(toolUseId, {
        name,
        includeContent: source?.include_content === true,
        skillRef: skillRefFromInput(source),
      });
    }
    if (name === 'catslog_skill_outcome') {
      const source = asRecord(input);
      this.observeRoute(source);
      this.outcomeAttempts++;
      this.outcomePending++;
      this.lastOutcomeStatus = 'pending';
      this.starts.set(toolUseId, {
        name,
        includeContent: false,
        skillRef: skillRefFromInput(source),
      });
    }
  }

  recordToolEnd(name: string, toolUseId: string, result: string): void {
    const start = this.starts.get(toolUseId);
    this.starts.delete(toolUseId);
    const parsed = parseJSON(result);
    if (name === 'catslog_skill_outcome') {
      const status = parsed && parsed.status === 'accepted' ? 'accepted' : 'rejected';
      if (status === 'accepted') {
        this.outcomeAccepted++;
        this.outcomePending = Math.max(0, this.outcomePending - 1);
        this.lastOutcomeStatus = 'accepted';
      } else {
        this.outcomeRejected++;
        this.outcomePending = Math.max(0, this.outcomePending - 1);
        this.lastOutcomeStatus = 'rejected';
      }
      // Prefer the start input, but recover the target from the projected
      // accepted response when an adapter dropped the callback correlation.
      // This keeps outcome status scoped to the cited Skill instead of letting
      // an unrelated global success satisfy the delivery gate.
      const resultSkillRef = skillRef(parsed?.ref)
        || skillRefFromParts(parsed?.handle, parsed?.revision);
      const targetRef = start?.skillRef || resultSkillRef;
      if (targetRef && (this.outcomeStatusByRef.has(targetRef) || this.outcomeStatusByRef.size < MAX_REFS)) {
        this.outcomeStatusByRef.set(targetRef, status);
      }
      return;
    }
    if (!parsed) return;

    this.observeCatalogRevision(parsed);
    this.observeRoute(asRecord(parsed.route));
    if (name === 'catslog_skill_catalog') {
      this.observeCatalog(parsed.skills, Boolean(start?.includeContent), false);
      return;
    }
    if (name === 'catslog_skill_graph') {
      this.observeGraph(parsed);
      return;
    }
    if (name === 'catslog_skill_memory') {
      this.observeCatalog(parsed.items, Boolean(start?.includeContent), true);
      if (asRecord(parsed.graph)) this.observeGraph(parsed.graph as Record<string, unknown>);
    }
  }

  /**
   * Return a bounded snapshot. `refs` are the citations the branch intends to
   * publish; version status is computed against observed active graph heads.
   */
  snapshot(refs: string[] = []): CatsLogSkillProvenance {
    const safeRefs = uniqueSkillRefs(refs);
    const versionStatus = this.resolveVersionStatus(safeRefs);
    const outcomeStatus = this.resolveOutcomeStatus(safeRefs);
    const receiptRefs = safeRefs.length > 0 ? safeRefs : Array.from(this.receiptEligibleRefs);

    return {
      schema: 'catslog.branch.provenance.v1',
      toolsUsed: Array.from(this.tools).slice(0, MAX_TOOLS),
      candidateRefs: Array.from(this.candidateRefs).slice(0, MAX_REFS),
      activeRefs: Array.from(this.activeRefs).slice(0, MAX_REFS),
      bodyReadRefs: Array.from(this.bodyReadRefs).slice(0, MAX_REFS),
      receiptEligibleRefs: Array.from(this.receiptEligibleRefs).slice(0, MAX_REFS),
      lineage: this.lineage.slice(0, MAX_LINEAGE),
      routes: Array.from(this.routes.values()).slice(0, MAX_ROUTES),
      ...(this.catalogRevision !== undefined ? { catalogRevision: this.catalogRevision } : {}),
      bodyReadCount: this.bodyReadCount,
      outcomeAttempts: this.outcomeAttempts,
      outcomeAccepted: this.outcomeAccepted,
      outcomeRejected: this.outcomeRejected,
      outcomeStatus,
      receiptState: receiptRefs.some(ref => this.receiptEligibleRefs.has(ref))
        ? 'inferred_from_body_read'
        : 'not_observed',
      versionStatus,
    };
  }

  private observeCatalog(
    value: unknown,
    includeContent: boolean,
    receiptEligible: boolean,
  ): void {
    if (!Array.isArray(value)) return;
    for (const item of value.slice(0, MAX_REFS)) {
      const source = asRecord(item);
      if (!source) continue;
      // A response may carry attribution on each item rather than at the
      // envelope level. Keep only the path-free projection used to correlate
      // later outcome calls.
      this.observeRoute(asRecord(source.route));
      const ref = skillRef(source.ref) || skillRefFromParts(source.handle, source.revision);
      if (!ref) continue;
      addBounded(this.candidateRefs, ref, MAX_REFS);
      if (includeContent && typeof source.content === 'string' && source.content.length > 0) {
        addBounded(this.bodyReadRefs, ref, MAX_REFS);
        this.bodyReadCount++;
        if (receiptEligible) addBounded(this.receiptEligibleRefs, ref, MAX_REFS);
      }
      // A catalog/memory item is only a candidate. Active-head status is
      // trusted exclusively from the graph's explicit node state; catalog
      // caches can be stale and must not satisfy the version guard.
    }
  }

  private observeGraph(value: Record<string, unknown>): void {
    this.observeCatalogRevision(value);
    if (Array.isArray(value.nodes)) {
      for (const node of value.nodes.slice(0, MAX_REFS)) {
        const source = asRecord(node);
        if (!source) continue;
        const ref = skillRef(source.ref) || skillRefFromParts(source.handle, source.revision);
        if (!ref) continue;
        addBounded(this.candidateRefs, ref, MAX_REFS);
        if (source.active === true && source.status !== 'inactive') addBounded(this.activeRefs, ref, MAX_REFS);
      }
    }
    if (Array.isArray(value.edges)) {
      for (const edge of value.edges.slice(0, MAX_LINEAGE)) {
        const source = asRecord(edge);
        if (!source) continue;
        const targetRef = skillRefFromParts(source.target_handle, source.target_revision);
        const type = safeText(source.type);
        if (!targetRef && !type) continue;
        if (this.lineage.length >= MAX_LINEAGE) continue;
        this.lineage.push({
          ...(type ? { type } : {}),
          ...(targetRef ? { targetRef } : {}),
        });
      }
    }
  }

  private observeCatalogRevision(value: Record<string, unknown>): void {
    const revision = positiveInteger(value.catalog_revision);
    if (revision !== undefined && (this.catalogRevision === undefined || revision > this.catalogRevision)) {
      this.catalogRevision = revision;
    }
  }

  private observeRoute(value: Record<string, unknown> | undefined): void {
    if (!value) return;
    const routeId = typeof (value.route_id ?? value.routeId) === 'string'
      ? String(value.route_id ?? value.routeId).trim()
      : '';
    if (!routeId || !isSafeCatsLogOpaqueIdentifier(routeId, 128)) return;
    const hop = positiveIntegerOrZero(value.hop);
    if (hop !== undefined && hop > 2) return;
    const edgeKeyValue = value.edge_key ?? value.edgeKey;
    const edgeKey = typeof edgeKeyValue === 'string' ? edgeKeyValue.trim() : undefined;
    if (edgeKey && !isSafeCatsLogOpaqueIdentifier(edgeKey, 256)) return;
    const route = {
      routeId,
      ...(hop !== undefined ? { hop } : {}),
      ...(edgeKey ? { edgeKey } : {}),
    };
    const key = `${route.routeId}|${route.hop ?? ''}|${route.edgeKey ?? ''}`;
    if (this.routes.has(key) || this.routes.size < MAX_ROUTES) this.routes.set(key, route);
  }

  private resolveVersionStatus(refs: string[]): CatsLogSkillProvenance['versionStatus'] {
    const skillRefs = refs.map(parseSkillRef).filter((value): value is SkillRef => Boolean(value));
    if (skillRefs.length === 0) return 'unknown';
    for (const ref of skillRefs) {
      const activeCandidates = Array.from(this.activeRefs)
        .map(parseSkillRef)
        .filter((candidate): candidate is SkillRef => candidate?.handle === ref.handle);
      // Verification is all-or-nothing: one cited Skill with no observed
      // active head must not be hidden by another cited Skill that happened to
      // have a graph response.
      if (activeCandidates.length === 0) return 'unknown';
      if (new Set(activeCandidates.map(candidate => candidate.revision)).size > 1) return 'unknown';
      if (activeCandidates[0].revision !== ref.revision) return 'mismatch';
    }
    return 'verified';
  }

  private resolveOutcomeStatus(refs: string[]): CatsLogSkillProvenance['outcomeStatus'] {
    const scoped = refs
      .map(ref => this.outcomeStatusByRef.get(ref))
      .filter((value): value is 'pending' | 'accepted' | 'rejected' => Boolean(value));
    // If the target was known, report only that target's lifecycle. This
    // prevents an outcome for an unrelated Skill from making a citation look
    // complete.
    if (scoped.length > 0) {
      if (scoped.includes('pending')) return 'pending';
      if (scoped.includes('rejected')) return 'rejected';
      return scoped.length === refs.length ? 'accepted' : 'pending';
    }
    if (this.lastOutcomeStatus === 'pending' || this.outcomePending > 0) return 'pending';
    if (refs.length > 0 && this.outcomeStatusByRef.size > 0) return 'not_attempted';
    // A completed outcome with no attributable target is not evidence for a
    // cited Skill. Do not let a callback mismatch turn an unrelated success
    // into an implicit reward.
    if (refs.length > 0 && this.outcomeAttempts > 0) return 'not_attempted';
    if (this.lastOutcomeStatus === 'accepted') return 'accepted';
    if (this.lastOutcomeStatus === 'rejected') return 'rejected';
    return 'not_attempted';
  }
}

interface SkillRef {
  handle: string;
  revision: number;
}

function isCatsLogTool(name: string): boolean {
  return name.startsWith('catslog_');
}

function parseJSON(value: unknown): Record<string, any> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return asRecord(parsed) as Record<string, any> | undefined;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

function skillRef(value: unknown): string | undefined {
  if (typeof value !== 'string' || !isMemoryCitationRef(value)) return undefined;
  return parseSkillRef(value) ? value.trim() : undefined;
}

function skillRefFromParts(handle: unknown, revision: unknown): string | undefined {
  if (typeof handle !== 'string' || !isSafeCatsLogSkillHandle(handle)) return undefined;
  const number = positiveInteger(revision);
  return number === undefined ? undefined : `catslog:skill:${handle}@${number}`;
}

function skillRefFromInput(source: Record<string, any> | undefined): string | undefined {
  if (!source) return undefined;
  return skillRef(source.ref)
    || skillRefFromParts(source.handle, source.revision);
}

function parseSkillRef(value: unknown): SkillRef | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.trim().match(/^catslog:skill:(.+)@([1-9][0-9]*)$/);
  if (!match || !isSafeCatsLogSkillHandle(match[1])) return undefined;
  const revision = Number(match[2]);
  return Number.isSafeInteger(revision) ? { handle: match[1], revision } : undefined;
}

function uniqueSkillRefs(values: unknown[]): string[] {
  const list = Array.isArray(values) ? values : [];
  return Array.from(new Set(list.map(skillRef).filter((value): value is string => Boolean(value))));
}

function addBounded<T>(set: Set<T>, value: T, limit: number): void {
  if (set.has(value) || set.size < limit) set.add(value);
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function positiveIntegerOrZero(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function safeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT) : undefined;
}
