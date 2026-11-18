import { createHash, randomUUID } from 'node:crypto';
import type { ContentBlock } from '../types';
import { Logger } from '../utils/logger';
import { SyntheticObservation, SyntheticObservationQueue } from './synthetic-observation';

/**
 * Session-scoped Memory Branch state.
 *
 * The Branch no longer writes into a turn-local queue that the next turn
 * drains unconditionally. It publishes claims into this session store, and a
 * provider request may only consume a claim when two mechanical checks hold:
 *
 * 1. the claim's access scope covers the current input's sender and session;
 * 2. the claim was verified against the latest admitted user input.
 *
 * A new user input therefore never waits, and an older finding is held until
 * the Branch either reconfirms it for the new input or withdraws it. No model
 * call sits on the provider path: both checks are field comparisons.
 */

/** Who could see the turn that produced an observation (and may receive it). */
export interface MemoryBranchScope {
  sessionKey: string;
  topicId: string;
  actorUserId: string;
}

export interface MemoryBranchUserInput {
  text: string | ContentBlock[] | null;
  scope: MemoryBranchScope;
  turn: number;
  turnId: string;
  /** Runtime observation turns are not user input: they keep the sequence unchanged. */
  runtimeObservation?: boolean;
}

export type MemoryBranchSessionEventKind = 'user_input' | 'tool_result';

export interface MemoryBranchSessionEvent {
  sequence: number;
  kind: MemoryBranchSessionEventKind;
  turn: number;
  turnId: string;
  actorUserId: string;
  text: string;
  toolName?: string;
}

export interface MemoryBranchFinding {
  subject: string;
  claim: string;
  sourceRefs: string[];
  /** A qualification that changes how the claim can be used. */
  qualification?: string;
  /** Observation ids or claim keys this finding corrects. */
  supersedes?: string[];
}

export interface MemoryBranchPublicationRequest extends MemoryBranchFinding {
  scope: MemoryBranchScope;
  originTurn: number;
  originTurnId: string;
  verifiedThroughInput: number;
  branchId: string;
  /** Finish-time publications keep their fully built observation (retained evidence). */
  observation?: SyntheticObservation;
}

export type MemoryBranchObservationStatus =
  | 'queued'
  | 'held'
  | 'delivered'
  | 'withdrawn'
  | 'expired'
  | 'superseded';

export interface SessionMemoryObservationEntry {
  id: string;
  claimKey: string;
  subject: string;
  claim: string;
  qualification?: string;
  sourceRefs: string[];
  scope: MemoryBranchScope;
  originTurn: number;
  originTurnId: string;
  branchId: string;
  verifiedThroughInput: number;
  status: MemoryBranchObservationStatus;
  publishedAt: number;
  deliveredAt?: number;
  deliveredTurn?: number;
  withdrawnReason?: string;
  supersededBy?: string;
  supersedes: string[];
  /** One audit row per input sequence the entry was held for. */
  heldThroughInputs: number[];
  holdReasons: Record<string, string>;
  observation: SyntheticObservation;
}

export interface MemoryBranchPublishResult {
  ok: boolean;
  observationId?: string;
  claimKey?: string;
  verifiedThroughInput?: number;
  reason?: string;
  existingObservationId?: string;
}

export interface MemoryBranchDeliveryInput {
  sequence: number;
  scope: MemoryBranchScope;
  turn: number;
}

export interface SessionMemoryBranchSnapshot {
  inputSequence: number;
  providerDrains: number;
  closed: boolean;
  entries: Array<Pick<SessionMemoryObservationEntry,
    'id' | 'claimKey' | 'subject' | 'claim' | 'qualification' | 'sourceRefs' | 'scope'
    | 'originTurn' | 'originTurnId' | 'branchId' | 'verifiedThroughInput' | 'status'
    | 'publishedAt' | 'deliveredAt' | 'deliveredTurn' | 'withdrawnReason' | 'supersededBy' | 'supersedes'
    | 'heldThroughInputs' | 'holdReasons'>>;
  pendingEvents: MemoryBranchSessionEvent[];
}

export const MAX_SESSION_MEMORY_OBSERVATIONS = 32;
export const MAX_SESSION_MEMORY_EVENTS = 32;
export const MAX_SESSION_MEMORY_EVENT_CHARS = 4_000;
const MAX_HELD_AUDIT_SEQUENCES = 32;

const EMPTY_SCOPE: MemoryBranchScope = { sessionKey: '', topicId: '', actorUserId: '' };

export function normalizeMemoryBranchScope(input: Partial<MemoryBranchScope> | undefined): MemoryBranchScope {
  return {
    sessionKey: String(input?.sessionKey || '').trim(),
    topicId: String(input?.topicId || '').trim(),
    actorUserId: String(input?.actorUserId || '').trim(),
  };
}

/** Strict scope comparison: a different sender never inherits another sender's evidence. */
export function memoryBranchScopeCovers(entry: MemoryBranchScope, current: MemoryBranchScope): boolean {
  return entry.sessionKey === current.sessionKey
    && entry.topicId === current.topicId
    && entry.actorUserId === current.actorUserId;
}

export function memoryBranchClaimKey(finding: Pick<MemoryBranchFinding, 'subject' | 'claim' | 'sourceRefs'>): string {
  const refs = [...new Set(finding.sourceRefs.map(ref => String(ref || '').trim()).filter(Boolean))].sort();
  return createHash('sha256')
    .update(JSON.stringify([finding.subject.trim(), finding.claim.trim(), refs]))
    .digest('hex')
    .slice(0, 32);
}

function contentToEventText(content: string | ContentBlock[] | null): string {
  if (!content) return '';
  if (typeof content === 'string') return content.slice(0, MAX_SESSION_MEMORY_EVENT_CHARS);
  if (!Array.isArray(content)) return '';
  return content
    .map(block => block.type === 'text' ? block.text : `[${block.type}]`)
    .join('\n')
    .slice(0, MAX_SESSION_MEMORY_EVENT_CHARS);
}

/**
 * Session-owned publication queue plus the user-input sequence that makes
 * delivery current. Also serves as the synthetic observation queue handed to
 * the Branch: finish-time publications reserve eligibility at the sequence the
 * Branch had consumed when it verified its claim.
 */
export class SessionMemoryBranchStore implements SyntheticObservationQueue {
  private inputSequence = 0;
  private readonly entries = new Map<string, SessionMemoryObservationEntry>();
  private readonly events: MemoryBranchSessionEvent[] = [];
  private readonly claimIndex = new Map<string, string>();
  private closed = false;
  private providerDrains = 0;
  private publishContext?: {
    scope: MemoryBranchScope;
    originTurn: number;
    originTurnId: string;
    branchId: string;
    verifiedThroughInput: () => number;
  };

  get currentInputSequence(): number {
    return this.inputSequence;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** The Branch's publication context for its own finish-time observation. */
  setPublishContext(context: {
    scope: MemoryBranchScope;
    originTurn: number;
    originTurnId: string;
    branchId: string;
    verifiedThroughInput: () => number;
  }): void {
    this.publishContext = context;
  }

  /**
   * Front-of-line admission: the sequence advances when a real user input is
   * admitted, before any provider call. Runtime observation turns do not
   * advance it, so tool results and provider calls inside one input leave
   * delivery eligibility unchanged.
   */
  noteUserInput(input: MemoryBranchUserInput): number {
    if (input.runtimeObservation) return this.inputSequence;
    this.inputSequence += 1;
    this.pushEvent({
      sequence: this.inputSequence,
      kind: 'user_input',
      turn: input.turn,
      turnId: input.turnId,
      actorUserId: input.scope.actorUserId,
      text: contentToEventText(input.text),
    });
    this.audit('memory_branch_input_admitted', `input #${this.inputSequence} admitted`, {
      input_sequence: this.inputSequence,
      turn: input.turn,
      turn_id: input.turnId,
      actor_user_id: input.scope.actorUserId,
      topic_id: input.scope.topicId,
    });
    return this.inputSequence;
  }

  /** A main-agent tool result can wake the Branch; it never advances eligibility. */
  noteToolResult(input: {
    sequence?: number;
    turn: number;
    turnId: string;
    scope: MemoryBranchScope;
    toolName: string;
    text: string;
  }): void {
    if (this.closed) return;
    this.pushEvent({
      sequence: input.sequence ?? this.inputSequence,
      kind: 'tool_result',
      turn: input.turn,
      turnId: input.turnId,
      actorUserId: input.scope.actorUserId,
      toolName: input.toolName,
      text: String(input.text || '').slice(0, MAX_SESSION_MEMORY_EVENT_CHARS),
    });
  }

  /** Coalesced events the Branch has not consumed yet (destructive: one consumer). */
  takeEvents(actorUserId?: string): MemoryBranchSessionEvent[] {
    if (actorUserId === undefined) return this.events.splice(0);
    const eligible = this.events.filter(event => event.actorUserId === actorUserId);
    this.events.splice(0, this.events.length, ...this.events.filter(event => event.actorUserId !== actorUserId));
    return eligible;
  }

  pendingEvents(): MemoryBranchSessionEvent[] {
    return this.events.map(event => ({ ...event }));
  }

  /**
   * Publish one verified claim. A repeated claim (same subject, claim and
   * refs) is not queued twice. `supersedes` retires the earlier observation
   * and records the correction, so the main agent cannot see both.
   */
  publish(request: MemoryBranchPublicationRequest): MemoryBranchPublishResult {
    const finding: MemoryBranchFinding = {
      subject: String(request.subject || '').trim(),
      claim: String(request.claim || '').trim(),
      sourceRefs: [...new Set((request.sourceRefs || []).map(ref => String(ref || '').trim()).filter(Boolean))],
      ...(request.qualification ? { qualification: request.qualification } : {}),
      ...(request.supersedes?.length ? { supersedes: request.supersedes } : {}),
    };
    if (!finding.subject || !finding.claim) {
      this.audit('memory_branch_publication', 'publication rejected: empty claim', {
        branch_id: request.branchId, reason: 'empty_claim',
      });
      return { ok: false, reason: 'empty_claim' };
    }
    if (this.closed) {
      this.audit('memory_branch_publication', 'publication rejected: queue closed', {
        branch_id: request.branchId, reason: 'queue_closed',
      });
      return { ok: false, reason: 'queue_closed' };
    }
    const claimKey = memoryBranchClaimKey(finding);
    const existingId = this.claimIndex.get(claimKey);
    if (existingId && this.isCurrent(existingId)) {
      this.audit('memory_branch_publication', 'duplicate claim suppressed', {
        branch_id: request.branchId, observation_id: existingId, claim_key: claimKey, reason: 'duplicate',
      });
      return { ok: false, reason: 'duplicate', existingObservationId: existingId, claimKey };
    }

    if (this.entries.size >= MAX_SESSION_MEMORY_OBSERVATIONS && !this.evictTerminal()) {
      this.audit('memory_branch_publication', 'publication rejected: queue full', {
        branch_id: request.branchId, reason: 'queue_full',
      });
      return { ok: false, reason: 'queue_full' };
    }
    const observation = request.observation
      ? { ...request.observation }
      : this.buildObservation(finding, request);
    const id = String(observation.id || '').trim() || `memory-session-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const entry: SessionMemoryObservationEntry = {
      id,
      claimKey,
      subject: finding.subject,
      claim: finding.claim,
      ...(finding.qualification ? { qualification: finding.qualification } : {}),
      sourceRefs: finding.sourceRefs,
      scope: { ...request.scope },
      originTurn: request.originTurn,
      originTurnId: request.originTurnId,
      branchId: request.branchId,
      verifiedThroughInput: request.verifiedThroughInput,
      status: 'queued',
      publishedAt: Date.now(),
      supersedes: finding.supersedes || [],
      heldThroughInputs: [],
      holdReasons: {},
      observation: {
        ...observation,
        id,
        metadata: {
          ...(observation.metadata || {}),
          branchId: request.branchId,
          branchType: 'memory',
          refs: finding.sourceRefs,
          subject: finding.subject,
          claim: finding.claim,
          ...(finding.qualification ? { qualification: finding.qualification } : {}),
          ...(finding.supersedes?.length ? { supersedes: finding.supersedes } : {}),
          claimKey,
          verifiedThroughInput: request.verifiedThroughInput,
          memoryBranchScope: { ...request.scope },
          originTurn: request.originTurn,
          originTurnId: request.originTurnId,
        },
      },
    };
    this.entries.set(id, entry);
    this.claimIndex.set(claimKey, id);
    for (const target of finding.supersedes || []) this.supersede(target, id);
    this.audit('memory_branch_publication', `published ${id}`, {
      observation_id: id,
      claim_key: claimKey,
      subject: finding.subject,
      claim: finding.claim,
      qualification: finding.qualification,
      refs: finding.sourceRefs,
      origin_turn: request.originTurn,
      origin_turn_id: request.originTurnId,
      branch_id: request.branchId,
      verified_through_input: request.verifiedThroughInput,
      current_input_sequence: this.inputSequence,
      supersedes: finding.supersedes || [],
      status: 'published',
    });
    return { ok: true, observationId: id, claimKey, verifiedThroughInput: request.verifiedThroughInput };
  }

  /**
   * SyntheticObservationQueue compatibility: the Branch's finish path pushes
   * its fully built observation here, while the publish tool uses publish().
   * Eligibility is reserved at the Branch's consumed input sequence.
   */
  push(observation: SyntheticObservation): boolean {
    const metadata = (observation.metadata || {}) as Record<string, any>;
    const context = this.publishContext;
    const scope = normalizeMemoryBranchScope(metadata.memoryBranchScope ?? context?.scope);
    const verifiedThroughInput = typeof metadata.verifiedThroughInput === 'number'
      ? metadata.verifiedThroughInput
      : context?.verifiedThroughInput() ?? this.inputSequence;
    const result = this.publish({
      subject: String(metadata.subject ?? observation.userIntent ?? 'memory'),
      claim: String(metadata.claim ?? observation.summary ?? '').trim(),
      sourceRefs: Array.isArray(metadata.refs) ? metadata.refs : [],
      ...(metadata.qualification ? { qualification: String(metadata.qualification) } : {}),
      ...(Array.isArray(metadata.supersedes) && metadata.supersedes.length
        ? { supersedes: metadata.supersedes.map(String) }
        : {}),
      scope: scope.sessionKey || scope.topicId || scope.actorUserId ? scope : EMPTY_SCOPE,
      originTurn: Number.isFinite(metadata.originTurn) ? Number(metadata.originTurn) : context?.originTurn ?? 0,
      originTurnId: String(metadata.originTurnId ?? context?.originTurnId ?? ''),
      verifiedThroughInput,
      branchId: String(metadata.branchId ?? context?.branchId ?? ''),
      observation,
    });
    return result.ok;
  }

  /** Delivery may only leave the queue at the synthetic observation seam. */
  drain(): SyntheticObservation[] {
    return [];
  }

  cancel(): SyntheticObservation[] {
    return [];
  }

  size(): number {
    return [...this.entries.values()].filter(entry => entry.status === 'queued' || entry.status === 'held').length;
  }

  /**
   * The provider-call gate. Called synchronously right before a request is
   * built; every non-eligible entry is held (audited once per sequence) and
   * stays queued for a later reconfirmation.
   */
  drainEligible(input: MemoryBranchDeliveryInput): SyntheticObservation[] {
    this.providerDrains += 1;
    if (this.closed) return [];
    const drained: SyntheticObservation[] = [];
    for (const entry of this.entries.values()) {
      if (entry.status === 'delivered' || entry.status === 'withdrawn'
        || entry.status === 'expired' || entry.status === 'superseded') continue;
      if (!memoryBranchScopeCovers(entry.scope, input.scope)) {
        this.hold(entry, input.sequence, 'scope_mismatch');
        continue;
      }
      if (entry.verifiedThroughInput !== input.sequence) {
        this.hold(entry, input.sequence, 'stale_verified_through_input');
        continue;
      }
      entry.status = 'delivered';
      entry.deliveredAt = Date.now();
      entry.deliveredTurn = input.turn;
      drained.push({
        ...entry.observation,
        timing: entry.originTurn === input.turn ? 'current_turn' : 'late_previous_turn',
        metadata: {
          ...(entry.observation.metadata || {}),
          timing: entry.originTurn === input.turn ? 'current_turn' : 'late_previous_turn',
        },
      });
      this.audit('memory_branch_observation_delivered', `delivered ${entry.id}`, {
        observation_id: entry.id,
        claim_key: entry.claimKey,
        refs: entry.sourceRefs,
        origin_turn: entry.originTurn,
        origin_turn_id: entry.originTurnId,
        consumed_turn: input.turn,
        consumed_input_sequence: input.sequence,
        verified_through_input: entry.verifiedThroughInput,
        delivered: true,
      });
    }
    return drained;
  }

  /**
   * The Branch consumed a newer user input and still stands behind the claim.
   * Only this advances `verifiedThroughInput`; admission never does.
   */
  reconfirm(input: {
    observationId?: string;
    claimKey?: string;
    sequence: number;
    scope: MemoryBranchScope;
  }): MemoryBranchPublishResult {
    const entry = this.findEntry(input);
    if (!entry) return { ok: false, reason: 'unknown_observation' };
    if (entry.status === 'delivered') return { ok: false, reason: 'already_delivered' };
    if (entry.status === 'withdrawn' || entry.status === 'expired' || entry.status === 'superseded') {
      return { ok: false, reason: `inactive:${entry.status}` };
    }
    if (!memoryBranchScopeCovers(entry.scope, input.scope)) return { ok: false, reason: 'scope_mismatch' };
    if (input.sequence <= entry.verifiedThroughInput) return { ok: false, reason: 'already_current' };
    entry.verifiedThroughInput = input.sequence;
    entry.status = 'queued';
    this.audit('memory_branch_observation_reconfirmed', `reconfirmed ${entry.id}`, {
      observation_id: entry.id,
      claim_key: entry.claimKey,
      refs: entry.sourceRefs,
      verified_through_input: input.sequence,
      origin_turn: entry.originTurn,
      consumed_input_sequence: input.sequence,
      branch_id: entry.branchId,
    });
    return { ok: true, observationId: entry.id, claimKey: entry.claimKey, verifiedThroughInput: input.sequence };
  }

  withdraw(input: { observationId?: string; claimKey?: string; reason: string; scope?: MemoryBranchScope }): MemoryBranchPublishResult {
    const entry = this.findEntry(input);
    if (!entry) return { ok: false, reason: 'unknown_observation' };
    if (entry.status === 'delivered') return { ok: false, reason: 'already_delivered' };
    if (entry.status === 'withdrawn') return { ok: false, reason: 'already_withdrawn' };
    if (input.scope && !memoryBranchScopeCovers(entry.scope, input.scope)) return { ok: false, reason: 'scope_mismatch' };
    entry.status = 'withdrawn';
    entry.withdrawnReason = String(input.reason || 'withdrawn').slice(0, 200);
    this.audit('memory_branch_observation_withdrawn', `withdrew ${entry.id}`, {
      observation_id: entry.id,
      claim_key: entry.claimKey,
      refs: entry.sourceRefs,
      reason: entry.withdrawnReason,
      verified_through_input: entry.verifiedThroughInput,
      current_input_sequence: this.inputSequence,
      branch_id: entry.branchId,
    });
    return { ok: true, observationId: entry.id, claimKey: entry.claimKey };
  }

  /** Held-but-current entries the Branch must reconfirm or withdraw for this input. */
  heldFor(sequence: number, scope: MemoryBranchScope): Array<{
    observationId: string;
    claimKey: string;
    subject: string;
    claim: string;
    qualification?: string;
    refs: string[];
    verifiedThroughInput: number;
    originTurn: number;
    reason?: string;
  }> {
    return [...this.entries.values()]
      .filter(entry => (entry.status === 'queued' || entry.status === 'held')
        && entry.verifiedThroughInput !== sequence)
      .filter(entry => memoryBranchScopeCovers(entry.scope, scope) || entry.scope.actorUserId === scope.actorUserId)
      .map(entry => ({
        observationId: entry.id,
        claimKey: entry.claimKey,
        subject: entry.subject,
        claim: entry.claim,
        ...(entry.qualification ? { qualification: entry.qualification } : {}),
        refs: [...entry.sourceRefs],
        verifiedThroughInput: entry.verifiedThroughInput,
        originTurn: entry.originTurn,
        ...(entry.holdReasons[String(sequence)] ? { reason: entry.holdReasons[String(sequence)] } : {}),
      }));
  }

  deliveredInjections(): Array<{ summary: string; refs: string[] }> {
    return [...this.entries.values()]
      .filter(entry => entry.status === 'delivered')
      .map(entry => ({ summary: entry.claim, refs: [...entry.sourceRefs] }));
  }

  /** Budget exhaustion, scope loss, session closure: the same terminal path. */
  expire(reason: string): number {
    this.closed = true;
    let expired = 0;
    for (const entry of this.entries.values()) {
      if (entry.status !== 'queued' && entry.status !== 'held') continue;
      entry.status = 'expired';
      entry.withdrawnReason = reason;
      expired += 1;
      this.audit('memory_branch_observation_expired', `expired ${entry.id}`, {
        observation_id: entry.id, claim_key: entry.claimKey, reason,
        verified_through_input: entry.verifiedThroughInput, branch_id: entry.branchId,
      });
    }
    this.events.splice(0, this.events.length);
    return expired;
  }

  /** Session reset: expire the queue but keep the store usable for the next input. */
  reset(reason: string): number {
    const expired = this.expire(reason);
    this.closed = false;
    this.inputSequence = 0;
    this.entries.clear();
    this.claimIndex.clear();
    this.providerDrains = 0;
    this.events.splice(0, this.events.length);
    return expired;
  }

  /** One Branch investigation exhausted its budget: retire only its own queued claims. */
  expireBranch(branchId: string, reason: string): number {
    let expired = 0;
    for (const entry of this.entries.values()) {
      if (entry.branchId !== branchId) continue;
      if (entry.status !== 'queued' && entry.status !== 'held') continue;
      entry.status = 'expired';
      entry.withdrawnReason = reason;
      expired += 1;
      this.audit('memory_branch_observation_expired', `expired ${entry.id}`, {
        observation_id: entry.id, claim_key: entry.claimKey, reason,
        verified_through_input: entry.verifiedThroughInput, branch_id: entry.branchId,
      });
    }
    return expired;
  }

  snapshot(): SessionMemoryBranchSnapshot {
    return {
      inputSequence: this.inputSequence,
      providerDrains: this.providerDrains,
      closed: this.closed,
      entries: [...this.entries.values()].map(entry => ({
        id: entry.id,
        claimKey: entry.claimKey,
        subject: entry.subject,
        claim: entry.claim,
        qualification: entry.qualification,
        sourceRefs: [...entry.sourceRefs],
        scope: { ...entry.scope },
        originTurn: entry.originTurn,
        originTurnId: entry.originTurnId,
        branchId: entry.branchId,
        verifiedThroughInput: entry.verifiedThroughInput,
        status: entry.status,
        publishedAt: entry.publishedAt,
        deliveredAt: entry.deliveredAt,
        deliveredTurn: entry.deliveredTurn,
        withdrawnReason: entry.withdrawnReason,
        supersededBy: entry.supersededBy,
        supersedes: [...entry.supersedes],
        heldThroughInputs: [...entry.heldThroughInputs],
        holdReasons: { ...entry.holdReasons },
      })),
      pendingEvents: this.pendingEvents(),
    };
  }

  private buildObservation(finding: MemoryBranchFinding, request: MemoryBranchPublicationRequest): SyntheticObservation {
    return {
      source: 'memory',
      status: 'completed',
      relevance: finding.sourceRefs.length ? 'medium' : 'low',
      summary: finding.claim,
      ...(finding.qualification ? { keyFacts: [finding.qualification] } : {}),
      evidence: finding.sourceRefs.map(ref => ({
        sourceType: 'session' as const,
        title: finding.subject,
        snippet: finding.claim,
        relevanceReason: finding.qualification,
      })),
      formattedContent: JSON.stringify({
        source: 'memory',
        subject: finding.subject,
        claim: finding.claim,
        ...(finding.qualification ? { qualification: finding.qualification } : {}),
        refs: finding.sourceRefs,
        content_trust: 'untrusted_branch_evidence',
        verified_through_input: request.verifiedThroughInput,
      }),
    };
  }

  private pushEvent(event: MemoryBranchSessionEvent): void {
    if (this.closed) return;
    this.events.push(event);
    if (this.events.length > MAX_SESSION_MEMORY_EVENTS) this.events.splice(0, this.events.length - MAX_SESSION_MEMORY_EVENTS);
  }

  private hold(entry: SessionMemoryObservationEntry, sequence: number, reason: string): void {
    if (entry.status === 'queued') entry.status = 'held';
    const key = String(sequence);
    if (entry.holdReasons[key]) return;
    if (entry.heldThroughInputs.length >= MAX_HELD_AUDIT_SEQUENCES) {
      const oldest = entry.heldThroughInputs.shift();
      if (oldest !== undefined) delete entry.holdReasons[String(oldest)];
    }
    entry.heldThroughInputs.push(sequence);
    entry.holdReasons[key] = reason;
    this.audit('memory_branch_observation_held', `held ${entry.id} for input #${sequence}`, {
      observation_id: entry.id,
      claim_key: entry.claimKey,
      reason,
      verified_through_input: entry.verifiedThroughInput,
      current_input_sequence: sequence,
      origin_turn: entry.originTurn,
      branch_id: entry.branchId,
    });
  }

  private supersede(target: string, by: string): void {
    const entry = this.entries.get(target)
      ?? [...this.entries.values()].find(item => item.claimKey === target);
    if (!entry || entry.id === by) return;
    if (entry.status === 'delivered') {
      // Already consumed: the correction stays visible, and the delivered
      // record keeps pointing at the claim that replaced it.
      entry.supersededBy = by;
      this.audit('memory_branch_observation_supersedes_delivered', `correction supersedes delivered ${entry.id}`, {
        observation_id: entry.id, superseded_by: by, claim_key: entry.claimKey,
      });
      return;
    }
    if (entry.status === 'withdrawn' || entry.status === 'expired' || entry.status === 'superseded') return;
    entry.status = 'superseded';
    entry.supersededBy = by;
    this.audit('memory_branch_observation_superseded', `superseded ${entry.id}`, {
      observation_id: entry.id, superseded_by: by, claim_key: entry.claimKey, branch_id: entry.branchId,
    });
  }

  private findEntry(input: { observationId?: string; claimKey?: string }): SessionMemoryObservationEntry | undefined {
    if (input.observationId && this.entries.has(input.observationId)) return this.entries.get(input.observationId);
    if (input.claimKey) {
      const id = this.claimIndex.get(input.claimKey);
      if (id) return this.entries.get(id);
    }
    return undefined;
  }

  private isCurrent(id: string): boolean {
    const entry = this.entries.get(id);
    return Boolean(entry && entry.status !== 'withdrawn' && entry.status !== 'expired' && entry.status !== 'superseded');
  }

  /** Make room by retiring a terminal entry; never drop a live claim silently. */
  private evictTerminal(): boolean {
    const retired = [...this.entries.values()].find(entry =>
      entry.status === 'delivered' || entry.status === 'superseded' || entry.status === 'withdrawn' || entry.status === 'expired');
    if (!retired) return false;
    this.entries.delete(retired.id);
    if (this.claimIndex.get(retired.claimKey) === retired.id) this.claimIndex.delete(retired.claimKey);
    this.audit('memory_branch_observation_evicted', `evicted ${retired.id}`, {
      observation_id: retired.id, claim_key: retired.claimKey, reason: 'capacity', branch_id: retired.branchId,
    });
    return true;
  }


  private audit(type: string, message: string, payload: Record<string, unknown>): void {
    try {
      Logger.runtimeEvent('INFO', `[memory-branch] ${message}`, { type, payload });
    } catch {
      // Audit is authoritative elsewhere; logging must never break delivery.
    }
  }
}
