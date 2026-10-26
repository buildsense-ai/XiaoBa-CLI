import type { Message } from '../types';

export interface SessionForkIdentity {
  requestId: string;
  sourceSessionKey: string;
  targetSessionKey: string;
  sourceLastSeq: number;
}

export interface SessionForkSnapshot extends SessionForkIdentity {
  version: 1;
  messages: Message[];
  currentDirectory?: string;
  materialized?: boolean;
}

/**
 * Markers that make a `user`-role message something other than the user speaking.
 *
 * Compaction summaries, runtime observations and injected context all carry the
 * user role, so counting turns by role alone overstates the transcript. This is
 * one exported list on purpose: adding a new synthetic message type without
 * touching it would silently shift every later turn, and the resulting cut has no
 * error to catch it.
 */
export const SYNTHETIC_USER_MESSAGE_FLAGS = [
  '__injected',
  '__runtimeFeedback',
  '__runtimeObservation',
  '__syntheticObservation',
  '__internalErrorArtifact',
  '__checkpointSummary',
] as const;

export function isSyntheticUserMessage(message: Message): boolean {
  if (message.role !== 'user') return false;
  const flags = message as unknown as Record<string, unknown>;
  return SYNTHETIC_USER_MESSAGE_FLAGS.some(flag => Boolean(flags[flag]));
}

/** A message that opens a real user turn in the transcript. */
export function isUserTurnStart(message: Message | undefined): boolean {
  return Boolean(message) && message!.role === 'user' && !isSyntheticUserMessage(message!);
}

/**
 * Cuts the transcript after the last message of the Nth complete turn.
 *
 * The rule is the server's, applied here step for step: a turn opens on a user
 * message and closes once an assistant reply arrives, consecutive user messages
 * fold into the turn already open, and a trailing unanswered turn does not count.
 * Anything else would let the two sides cut in different places, which produces a
 * copy whose visible history and model context disagree.
 *
 * `undefined` means the server sent no bound, so the copy is the whole
 * conversation. An explicit `0` is a disagreement, not "unbounded": the server
 * includes the field only for a bounded copy, so a zero reaching here means one
 * side believes there is a bound and the other cannot establish it. Copying
 * everything at that point is exactly the failure this guard exists to prevent.
 */
export function truncateAtTurn(messages: Message[], turnCount: number | undefined): Message[] {
  if (turnCount === undefined) return messages;
  if (!Number.isSafeInteger(turnCount) || turnCount <= 0) {
    throw new Error('session_fork_source_turn_mismatch');
  }
  let open = false;
  let answered = false;
  let turns = 0;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (isUserTurnStart(message)) {
      if (open && answered) {
        turns++;
        if (turns === turnCount) return boundedForkMessages(messages.slice(0, index));
      }
      open = true;
      answered = false;
    } else if (message?.role === 'assistant' && open) {
      answered = true;
    }
  }
  if (open && answered) {
    turns++;
    if (turns === turnCount) return boundedForkMessages(messages);
  }
  throw new Error('session_fork_source_turn_mismatch');
}

/**
 * A bounded copy keeps the turns before the cut, but a compaction summary in that
 * range may already describe turns beyond it. Dropping summaries loses some older
 * detail; keeping them would leak the future into the branch, which is the worse
 * of the two.
 */
function boundedForkMessages(messages: Message[]): Message[] {
  return messages.filter(message => !message.__checkpointSummary);
}

/** Copy durable context, never an execution queue or provider continuation handle. */
export function prepareForkMessages(messages: Message[], idMap: Record<string, number>): Message[] {
  const pending = new Set<string>();
  const used = new Set<string>();
  const result: Message[] = [];
  const mappedWatermark = (old: number): number => Object.entries(idMap).reduce((highest, [id, mapped]) =>
    Number(id) <= old && Number.isSafeInteger(mapped) && mapped > highest ? mapped : highest, 0);

  for (const source of messages) {
    if (!source || !['user', 'assistant', 'system', 'tool'].includes(source.role)
      || !(source.content === null || typeof source.content === 'string' || Array.isArray(source.content))) {
      throw new Error('Invalid message in source context');
    }
    if (source.role === 'system' || source.__injected || source.__syntheticObservation
      || source.__runtimeFeedback || source.__internalErrorArtifact) continue;
    const message: Message = {
      role: source.role,
      content: structuredClone(source.content),
    };
    for (const key of ['name', 'tool_calls', 'tool_call_id', '__episodeId', '__episodeInputKind',
      '__checkpointSummary', '__checkpointBoundary', '__checkpointPhase', '__runtimeObservation',
      'runtimeObservationSource'] as const) {
      if (source[key] !== undefined) (message as any)[key] = structuredClone(source[key]);
    }
    if (message.role === 'tool') {
      if (!message.tool_call_id || !pending.delete(message.tool_call_id)) throw new Error('Orphan tool result at fork boundary');
    } else {
      if (pending.size) throw new Error('Incomplete tool exchange at fork boundary');
      for (const call of message.tool_calls || []) {
        if (message.role !== 'assistant' || !call.id || call.type !== 'function'
          || !call.function?.name || typeof call.function.arguments !== 'string') {
          throw new Error('Invalid tool call at fork boundary');
        }
        if (used.has(call.id)) throw new Error('Duplicate tool call at fork boundary');
        pending.add(call.id);
        used.add(call.id);
      }
    }
    if (source.__remoteContextSource === 'catscompany.agent_context') {
      const mapped = idMap[String(source.__remoteContextId)];
      if (Number.isSafeInteger(mapped) && mapped > 0) {
        message.__remoteContextSource = source.__remoteContextSource;
        message.__remoteContextId = mapped;
      }
    }
    const oldWatermark = source.__remoteContextWatermarks?.['catscompany.agent_context'];
    if (oldWatermark) {
      const mapped = mappedWatermark(oldWatermark);
      if (mapped) message.__remoteContextWatermarks = { 'catscompany.agent_context': mapped };
    }
    result.push(message);
  }
  if (pending.size) throw new Error('Incomplete tool exchange at fork boundary');
  return result;
}
