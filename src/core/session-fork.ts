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
