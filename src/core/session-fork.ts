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
 * A user-role message that did not come from the user.
 *
 * Compaction summaries, runtime observations and injected context all use the
 * user role, so counting turns by role alone would overstate the transcript.
 * The server only stores real chat messages, so it counts every `user` row;
 * the runtime has to exclude these to reach the same number.
 */
export function isSyntheticUserMessage(message: Message): boolean {
  return message.role === 'user' && Boolean(message.__injected || message.__runtimeFeedback
    || message.__runtimeObservation || message.__syntheticObservation
    || message.__internalErrorArtifact || message.__checkpointSummary);
}

/**
 * Cuts the transcript after the last message of the Nth complete turn.
 *
 * `turnCount` comes from the server, which counts a turn only once it has an
 * assistant reply and does not count a trailing unanswered user turn. The same
 * rule applies here, and a disagreement fails closed: cutting somewhere else
 * would produce a copy whose history and model context disagree.
 *
 * `turnCount <= 0` means "unbounded" and returns the transcript untouched.
 */
export function truncateAtTurn(messages: Message[], turnCount: number): Message[] {
  if (!Number.isSafeInteger(turnCount) || turnCount <= 0) return messages;
  const starts: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    if (messages[index]?.role === 'user' && !isSyntheticUserMessage(messages[index])) starts.push(index);
  }
  if (starts.length < turnCount) {
    throw new Error('session_fork_source_turn_mismatch');
  }
  const start = starts[turnCount - 1];
  const end = turnCount < starts.length ? starts[turnCount] : messages.length;
  let answered = false;
  for (let index = start + 1; index < end; index++) {
    if (messages[index]?.role === 'assistant') answered = true;
  }
  if (!answered) {
    throw new Error('session_fork_source_turn_mismatch');
  }
  // A bounded copy keeps the turns before the cut, but a compaction summary in
  // that range may already describe turns beyond it. Dropping summaries loses
  // some older detail; keeping them would leak the future into the branch, which
  // is the worse of the two.
  return messages.slice(0, end).filter(message => !message.__checkpointSummary);
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
