import {
  isSessionTurnEntry,
  type ParsedSessionLogEntry,
  type SessionAttachmentLog,
  type SessionTranscriptLogEntry,
  type SessionTurnLogEntry,
} from './session-log-schema';

export interface SessionLogProjection {
  /** Existing turn ordinals never change. New records use immutable event/run IDs. */
  ref: string;
  entry: SessionTurnLogEntry;
  transcript?: string;
  searchable: boolean;
}

/** Shared local-memory/report projection. Raw JSONL remains the source of truth. */
export function projectSessionLog(entries: ParsedSessionLogEntry[]): SessionLogProjection[] {
  const events = entries.filter(isTranscriptEntry);
  const uniqueEvents = [...new Map(events.map(entry => [entry.event_id, entry])).values()];
  const runs = new Map<string, SessionTranscriptLogEntry[]>();
  const receipts = new Map<string, SessionTranscriptLogEntry>();
  const consumed = new Set<string>();
  for (const entry of uniqueEvents) {
    if (entry.event.type === 'input_received') receipts.set(entry.event.input_id, entry);
    if (entry.event.type === 'input_consumed') entry.event.input_ids.forEach(id => consumed.add(id));
    if (entry.run_id) {
      const run = runs.get(entry.run_id) || [];
      run.push(entry);
      runs.set(entry.run_id, run);
    }
  }
  const summaries = new Map<string, SessionTurnLogEntry>();
  const projections: SessionLogProjection[] = [];
  let ordinal = 0;
  let legacyOrdinal = 0;
  for (const entry of entries) {
    if (!isSessionTurnEntry(entry)) continue;
    if (entry.entry_type === 'turn') ordinal++;
    else legacyOrdinal++;
    const normalized: SessionTurnLogEntry = { ...entry, entry_type: 'turn' };
    if (entry.run_id) summaries.set(entry.run_id, normalized);
    projections.push({ ref: entry.entry_type === 'turn' ? String(ordinal) : `legacy:${legacyOrdinal}`, entry: normalized, searchable: !entry.run_id || !runs.has(entry.run_id) });
  }
  for (const [inputId, receipt] of receipts) {
    if (receipt.event.type !== 'input_received') continue;
    const entry = emptyTurn(receipt);
    entry.user.text = receipt.event.text;
    projections.push({
      ref: `input:${inputId}`, entry, searchable: !consumed.has(inputId),
      transcript: `INPUT_STATUS: ${consumed.has(inputId) ? 'consumed' : 'received; no consumption recorded'}\n${formatReceipt(receipt)}`,
    });
  }
  for (const [runId, run] of runs) {
    const entry = emptyTurn(run[0]);
    const summary = summaries.get(runId);
    if (summary) {
      entry.tokens = summary.tokens;
      entry.prompt = summary.prompt;
    }
    const lines: string[] = [];
    let status = 'unfinished_or_unknown';
    for (const record of run) {
      const event = record.event;
      switch (event.type) {
        case 'input_consumed': {
          const inputReceipts = event.input_ids.map(id => receipts.get(id)).filter((value): value is SessionTranscriptLogEntry => !!value);
          if (event.kind === 'runtime_observation') {
            entry.user.runtime_observation_source = event.source || 'runtime_observation';
            lines.push(`[RUNTIME_OBSERVATION source=${event.source || 'unknown'}]\n${event.text}${formatAttachments(event.attachments)}`);
          } else {
            const originals = inputReceipts.filter(receipt => receipt.event.type === 'input_received');
            const text = originals.length ? originals.map(receipt => receipt.event.type === 'input_received' ? receipt.event.text : '').join('\n') : event.text;
            entry.user.text += (entry.user.text ? '\n' : '') + text;
            if (originals.length) lines.push(...originals.map(formatReceipt));
            else lines.push(`[USER_INPUT ${event.kind}]\n${event.text}${formatAttachments(event.attachments)}`);
            if (originals.length && text !== event.text) lines.push(`[MODEL_INPUT ${event.kind}]\n${event.text}${formatAttachments(event.attachments)}`);
          }
          break;
        }
        case 'runtime_observation':
          lines.push(`[RUNTIME_OBSERVATION source=${event.source}]\n${event.text}`);
          break;
        case 'model_failed':
          lines.push(`[MODEL_FAILED model_call=${event.model_call} error=${event.error_name}]`);
          break;
        case 'assistant_message':
          entry.assistant.text += (entry.assistant.text ? '\n' : '') + event.text;
          lines.push(`[ASSISTANT ${event.phase}; model_call=${event.model_call}; delivery_unconfirmed]\n${event.text}`);
          break;
        case 'tool_started':
          entry.assistant.tool_calls.push({ id: event.call_id, name: event.name, arguments: event.arguments, result: '' });
          lines.push(`[TOOL_STARTED ${event.name} id=${event.call_id}]\n${event.arguments}`);
          break;
        case 'tool_finished': {
          const tool = entry.assistant.tool_calls.find(call => call.id === event.call_id);
          if (tool) { tool.result = event.result; tool.duration_ms = event.duration_ms; }
          else entry.assistant.tool_calls.push({ id: event.call_id, name: event.name, arguments: '', result: event.result, duration_ms: event.duration_ms });
          lines.push(`[TOOL_RESULT ${event.name} id=${event.call_id}]\n${event.result}${formatAttachments(event.attachments)}`);
          break;
        }
        case 'input_deferred':
          lines.push(`[INPUT_DEFERRED ${event.reason}] ${event.input_ids.join(',')}`);
          break;
        case 'run_finished':
          status = event.status;
          lines.push(`[RUN_FINISHED ${event.status}${event.error_name ? ` ${event.error_name}` : ''}]`);
          break;
      }
    }
    projections.push({ ref: `run:${runId}`, entry, searchable: true, transcript: `RUN_STATUS: ${status}\n\n${lines.join('\n\n')}` });
  }
  return projections;
}

function emptyTurn(entry: SessionTranscriptLogEntry): SessionTurnLogEntry {
  return {
    entry_type: 'turn', turn: 0, timestamp: entry.timestamp,
    session_id: entry.session_id, session_type: entry.session_type,
    ...(entry.run_id && { run_id: entry.run_id }),
    ...(entry.agent_identity && { agent_identity: entry.agent_identity }),
    user: { text: '' }, assistant: { text: '', tool_calls: [] }, tokens: { prompt: 0, completion: 0 },
  };
}

function formatReceipt(receipt: SessionTranscriptLogEntry): string {
  if (receipt.event.type !== 'input_received') return '';
  const event = receipt.event;
  return `[USER_INPUT id=${event.input_id}${event.source ? ` source=${event.source}` : ''}${event.message_id ? ` message=${event.message_id}` : ''}${event.sender_id ? ` sender=${event.sender_id}` : ''}]\n${event.text}${formatAttachments(event.attachments)}`;
}

function formatAttachments(attachments?: SessionAttachmentLog[]): string {
  if (!Array.isArray(attachments) || !attachments.length) return '';
  return '\nATTACHMENTS:\n' + attachments.map(item => JSON.stringify(item)).join('\n');
}

function isTranscriptEntry(entry: ParsedSessionLogEntry): entry is SessionTranscriptLogEntry {
  if (entry.entry_type !== 'transcript' || entry.schema_version !== 1
    || typeof entry.event_id !== 'string' || typeof entry.timestamp !== 'string'
    || typeof entry.session_id !== 'string' || typeof entry.session_type !== 'string'
    || !entry.event || typeof entry.event !== 'object') return false;
  const event = entry.event;
  switch (event.type) {
    case 'input_received': return typeof event.input_id === 'string' && typeof event.text === 'string';
    case 'input_consumed': return typeof event.text === 'string' && Array.isArray(event.input_ids) && event.input_ids.every(id => typeof id === 'string') && ['root', 'pending', 'runtime_observation'].includes(event.kind);
    case 'input_deferred': return Array.isArray(event.input_ids) && event.input_ids.every(id => typeof id === 'string');
    case 'runtime_observation': return typeof event.text === 'string' && typeof event.source === 'string';
    case 'model_failed': return typeof event.model_call === 'number' && typeof event.error_name === 'string';
    case 'assistant_message': return typeof event.text === 'string' && ['reply', 'tool_prelude', 'partial', 'runtime_reply'].includes(event.phase);
    case 'tool_started': return typeof event.call_id === 'string' && typeof event.name === 'string' && typeof event.arguments === 'string';
    case 'tool_finished': return typeof event.call_id === 'string' && typeof event.name === 'string' && typeof event.result === 'string';
    case 'run_started': return true;
    case 'run_finished': return ['completed', 'failed', 'cancelled'].includes(event.status);
    default: return false;
  }
}
