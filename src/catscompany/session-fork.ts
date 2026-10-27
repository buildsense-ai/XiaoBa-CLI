import type { Message } from '../types';
import type { SessionRoute } from '../types/session-identity';
import type { SessionRuntimeState } from '../utils/session-store';
import { prepareForkMessages, truncateAtTurn, type SessionForkIdentity, type SessionForkSnapshot } from '../core/session-fork';
import { createCatsCoSessionRoute } from '../core/session-router';
import { createCatsCoMessageEnvelope } from './message-envelope';

export interface CatsSessionForkControl {
  request_id: string;
  source_topic_id: string;
  target_topic_id: string;
  actor_user_id: string;
  agent_uid: string;
  source_last_seq: number;
  /**
   * Complete turns in the copied range.
   *
   * Absent means the server copied the whole conversation, so the runtime must
   * not cut at all. The field is only present on a bounded copy, so an explicit
   * `0` is a disagreement between the two sides rather than "unbounded" — see
   * truncateAtTurn, which fails closed on it instead of copying everything.
   */
  source_turn_count?: number;
  /**
   * Complete turns in the whole conversation.
   *
   * A runtime that compacted its transcript holds only a summarized prefix plus
   * a retained tail. The total lets it subtract the compacted turns and place a
   * range boundary inside the part it still holds, so a compacted conversation
   * stays branchable.
   */
  source_total_turns?: number;
  message_id_map: Record<string, number>;
}

export interface CatsSessionForkStatus {
  request_id: string;
  source_topic_id: string;
  target_topic_id: string;
  state: 'pending' | 'ready' | 'failed';
  error?: string;
}

export interface CatsSessionForkCompletion {
  request_id: string;
  target_topic_id: string;
  state: 'ready' | 'failed';
  error?: string;
}

export function normalizeForkUid(value: unknown): string | undefined {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const raw = String(value).replace(/^usr/, '');
  return /^[1-9]\d*$/.test(raw) ? `usr${raw}` : undefined;
}

export function normalizeSessionForkControl(value: unknown): CatsSessionForkControl | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const actor = normalizeForkUid(v.actor_user_id);
  const agent = normalizeForkUid(v.agent_uid);
  if (!actor || !agent || actor === agent
    || typeof v.request_id !== 'string' || !v.request_id.trim() || v.request_id.length > 128
    || /[\x00-\x1f\x7f]/.test(v.request_id)
    || typeof v.source_topic_id !== 'string' || !/^(?:grp_[1-9]\d*|p2p_[1-9]\d*_[1-9]\d*)$/.test(v.source_topic_id)
    || typeof v.target_topic_id !== 'string' || !/^grp_[1-9]\d*$/.test(v.target_topic_id)
    || v.source_topic_id === v.target_topic_id
    || !Number.isSafeInteger(v.source_last_seq) || Number(v.source_last_seq) < 0
    || (v.source_turn_count !== undefined
      && (!Number.isSafeInteger(v.source_turn_count) || Number(v.source_turn_count) < 0))
    || (v.source_total_turns !== undefined
      && (!Number.isSafeInteger(v.source_total_turns) || Number(v.source_total_turns) < 0))
    || !v.message_id_map || typeof v.message_id_map !== 'object' || Array.isArray(v.message_id_map)) return undefined;
  if (v.source_topic_id.startsWith('p2p_')) {
    const members = v.source_topic_id.slice(4).split('_').map(normalizeForkUid);
    if (!members.includes(actor) || !members.includes(agent)) return undefined;
  }
  const map: Record<string, number> = Object.create(null);
  const targets = new Set<number>();
  for (const [id, mapped] of Object.entries(v.message_id_map)) {
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) > Number(v.source_last_seq)
      || !Number.isSafeInteger(mapped) || mapped <= 0 || targets.has(mapped)) return undefined;
    map[id] = mapped;
    targets.add(mapped);
  }
  return { request_id: v.request_id, source_topic_id: v.source_topic_id, target_topic_id: v.target_topic_id,
    actor_user_id: actor, agent_uid: agent, source_last_seq: Number(v.source_last_seq),
    // Preserve absence: it is the only signal for "no bound". Collapsing an
    // explicit 0 into it would turn a mismatch into a silent full copy.
    source_turn_count: v.source_turn_count === undefined ? undefined : Number(v.source_turn_count),
    source_total_turns: v.source_total_turns === undefined ? undefined : Number(v.source_total_turns),
    message_id_map: map };
}

export function forkSessionRoute(topic: string, actor: string, agent: string): SessionRoute {
  return createCatsCoSessionRoute(createCatsCoMessageEnvelope({
    topic, isGroup: topic.startsWith('grp_'), senderId: actor, botUid: agent, text: '',
  }));
}

interface ForkSession {
  exportForkContext(idMap: Record<string, number>, turnCount?: number, totalTurns?: number): { messages: Message[]; currentDirectory?: string };
}

export interface CatsSessionForkDependencies {
  agentUid(): string | null;
  isIdle(sessionKey: string): boolean;
  getSession(route: SessionRoute): ForkSession | null;
  store: {
    getForkIdentity(key: string): SessionForkIdentity | undefined;
    readContextForFork(key: string): Message[];
    loadRuntimeState(key: string): SessionRuntimeState;
    installFork(snapshot: SessionForkSnapshot): 'created' | 'existing';
  };
  complete(input: CatsSessionForkCompletion): Promise<CatsSessionForkStatus>;
}

/** Holds both endpoints through completion; it never creates or initializes an AgentSession. */
export class CatsSessionForkController {
  private locks = new Map<string, Promise<void>>();
  private requests = new Map<string, { fingerprint: string; promise: Promise<void> }>();

  constructor(private readonly deps: CatsSessionForkDependencies) {}

  isLocked(key: string): boolean { return this.locks.has(key); }
  waitForSession(key: string): Promise<void> | undefined { return this.locks.get(key); }

  handle(control: CatsSessionForkControl): Promise<void> {
    const fingerprint = JSON.stringify({ ...control, message_id_map: Object.entries(control.message_id_map).sort() });
    const running = this.requests.get(control.target_topic_id);
    if (running) {
      return running.fingerprint === fingerprint ? running.promise : Promise.reject(new Error('session_fork_request_conflict'));
    }
    const source = forkSessionRoute(control.source_topic_id, control.actor_user_id, control.agent_uid);
    const target = forkSessionRoute(control.target_topic_id, control.actor_user_id, control.agent_uid);
    if (this.isLocked(source.sessionKey) || this.isLocked(target.sessionKey)) {
      return this.reportFailure(control, 'session_fork_source_busy');
    }
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    this.locks.set(source.sessionKey, barrier);
    this.locks.set(target.sessionKey, barrier);
    const promise = this.initialize(control, source, target).finally(() => {
      this.locks.delete(source.sessionKey);
      this.locks.delete(target.sessionKey);
      this.requests.delete(control.target_topic_id);
      release();
    });
    this.requests.set(control.target_topic_id, { fingerprint, promise });
    return promise;
  }

  private async initialize(control: CatsSessionForkControl, source: SessionRoute, target: SessionRoute): Promise<void> {
    const { store } = this.deps;
    try {
      if (normalizeForkUid(this.deps.agentUid()) !== control.agent_uid) throw new Error('session_fork_agent_mismatch');
      const identity: SessionForkIdentity = { requestId: control.request_id, sourceSessionKey: source.sessionKey,
        targetSessionKey: target.sessionKey, sourceLastSeq: control.source_last_seq };
      const existing = store.getForkIdentity(target.sessionKey);
      if (existing) {
        if (Object.keys(identity).some(key => existing[key as keyof SessionForkIdentity] !== identity[key as keyof SessionForkIdentity])) {
          throw new Error('session_fork_request_conflict');
        }
        // Identity survives clear and materialization; verify context survived too, without recopying the source.
        store.readContextForFork(target.sessionKey);
      } else {
        if (!this.deps.isIdle(source.sessionKey) || !this.deps.isIdle(target.sessionKey)) throw new Error('session_fork_source_busy');
        if (this.deps.getSession(target)) throw new Error('session_fork_target_exists');
        const state = store.loadRuntimeState(source.sessionKey);
        if (state.interruptedTurn) throw new Error('session_fork_source_interrupted');
        // This strict read also rejects missing/corrupt sources when a live object exists.
        const durable = store.readContextForFork(source.sessionKey);
        const session = this.deps.getSession(source);
        // Both paths must cut identically: the live session and the durable
        // transcript are two views of the same conversation, and the copy must
        // not end in a different place depending on which one answered.
        // Pass absence through untouched: it is the only signal for "no bound".
        const turnCount = control.source_turn_count;
        const totalTurns = control.source_total_turns;
        const context = session ? session.exportForkContext(control.message_id_map, turnCount, totalTurns) : {
          messages: prepareForkMessages(truncateAtTurn(durable, turnCount, totalTurns), control.message_id_map),
          currentDirectory: state.currentDirectory,
        };
        store.installFork({ version: 1, ...identity, ...context });
      }
    } catch (error) {
      const publicErrors = new Set(['session_fork_agent_mismatch', 'session_fork_request_conflict',
        'session_fork_source_busy', 'session_fork_target_exists', 'session_fork_source_interrupted',
        'session_fork_source_turn_mismatch', 'session_fork_anchor_compacted']);
      const code = error instanceof Error && publicErrors.has(error.message) ? error.message : 'session_fork_initialization_failed';
      await this.reportFailure(control, code);
      return;
    }
    // A lost HTTP response is uncertain, not an initialization failure. Never send a compensating failed ACK.
    await this.deps.complete({ request_id: control.request_id, target_topic_id: control.target_topic_id, state: 'ready' });
  }

  private async reportFailure(control: CatsSessionForkControl, error: string): Promise<void> {
    await this.deps.complete({ request_id: control.request_id, target_topic_id: control.target_topic_id, state: 'failed', error: error.slice(0, 1000) });
  }
}
