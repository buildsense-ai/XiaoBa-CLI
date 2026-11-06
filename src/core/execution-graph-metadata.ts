import { createHash, randomUUID } from 'node:crypto';
import type { Message, ChatResponse } from '../types';
import type { ToolDefinition } from '../types/tool';
import { collectExecutionMemoryInputs } from './execution-memory-bindings';

export const EXECUTION_GRAPH_CONTRACT = 'execution-graph/1';
export const EXECUTION_IDENTITY_CONTRACT = 'execution-identity/1';
const MAX_ITEMS = 512;
const MAX_OUTPUTS = 512;
const MAX_BYTES = 64 * 1024;
const MAX_ID_BYTES = 512;
const MAX_NAME_BYTES = 256;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function contentDigest(content: Message['content']): string { return digest(content); }
function utf8Bytes(value: string): number { return Buffer.byteLength(value, 'utf8'); }

interface MessageExecutionRef { kind: string; ref: string; identity_state: string; source_kind?: string }

/** Expand one transcript record to its actual graph identities. An assistant
 * wrapper containing sibling calls has one node per call plus an independent
 * message node when it carries content. */
export function executionRefsForMessage(
  message: Message,
  sessionId: string,
  episodeId: string | undefined,
  index: number,
): MessageExecutionRef[] {
  if (message.__syntheticObservation && message.syntheticObservationId) {
    const part = message.role === 'tool' ? 'result' : 'call';
    return [{ kind: 'message', ref: `runtime-observation:${message.syntheticObservationId}:${part}`, identity_state: 'programmatic_observation' }];
  }
  if (message.role === 'tool' && message.tool_call_id) {
    return [{ kind: 'turn_result', ref: `provider-result:${message.tool_call_id}`, identity_state: 'provider_result_identity' }];
  }
  if (message.__checkpointSummary && message.__checkpointId) {
    return [{
      kind: 'checkpoint_summary', ref: message.__checkpointId,
      identity_state: message.__checkpointPersisted ? 'client_checkpoint' : 'unknown',
    }];
  }
  if (message.role === 'system' && !message.__injected && !message.__runtimeObservation) {
    const sha = digest({ role: message.role, content: message.content, tool_calls: message.tool_calls, tool_call_id: message.tool_call_id });
    return [{ kind: 'prompt', ref: `prompt:${sessionId}:${episodeId ?? 'unknown'}:${sha.slice(0, 24)}`, identity_state: 'client_prompt_material' }];
  }
  if (message.__injected || message.__runtimeObservation) {
    const sha = digest({ role: message.role, content: message.content, tool_calls: message.tool_calls, tool_call_id: message.tool_call_id });
    const sourceKind = message.__runtimeObservation
      ? (message.runtimeObservationSource || 'unknown')
      : message.__injected ? 'injected_context' : undefined;
    return [{ kind: 'runtime_material', ref: `runtime-material:${sessionId}:${episodeId ?? 'unknown'}:${sha.slice(0, 24)}`, identity_state: 'client_runtime_material', ...(sourceKind ? { source_kind: sourceKind } : {}) }];
  }
  const refs: MessageExecutionRef[] = [];
  if (message.role === 'assistant' && message.tool_calls?.length) {
    for (const call of message.tool_calls) {
      refs.push({ kind: 'tool_call', ref: `provider-call:${call.id}`, identity_state: 'provider_call_identity' });
    }
  }
  if (message.role !== 'assistant' || !message.tool_calls?.length || message.content) {
    const known = message.__executionNodeRef;
    const unknown = `unknown-session-node:${sessionId}:${episodeId ?? 'unknown'}:${index}:${contentDigest(message.content).slice(0, 16)}`;
    refs.push({
      kind: message.role === 'user' ? 'query' : 'message',
      ref: known || unknown,
      identity_state: known ? 'client_session_node' : 'unknown',
    });
  }
  return refs;
}

function projectionObservations(messages: readonly Message[], consumerCallId: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 12 || found.length >= 128 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 512)) visit(item, depth + 1); return; }
    const record = value as Record<string, any>;
    if (record.observation && record.observation.hit && record.observation.read) {
      found.push({ ...record.observation, consumer_model_call_id: consumerCallId, submitted_to_provider: true });
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  for (const message of messages) {
    if (typeof message.content !== 'string' || utf8Bytes(message.content) > MAX_BYTES) continue;
    try { visit(JSON.parse(message.content), 0); } catch { /* not a structured projection observation */ }
  }
  return found;
}

export interface ExecutionGraphOrigin {
  session_id: string;
  episode_id: string;
  model_call_id: string;
}

export interface ExecutionGraphCallOptions {
  sessionId: string;
  episodeId?: string;
  attempt: number;
  modelCallId?: string;
  outputMessageRef?: string;
  tools?: readonly ToolDefinition[];
}

/** Build content-free metadata for the exact post-trim request and successful response. */
export function buildExecutionGraphCallEvent(
  messages: readonly Message[],
  response: ChatResponse,
  options: ExecutionGraphCallOptions,
): Record<string, any> {
  const modelCallId = options.modelCallId || randomUUID();
  const reason = (value: string) => { completenessReason ??= value; };
  let completenessReason: string | undefined;
  const outputs: Array<Record<string, any>> = [];
  let outputsComplete = true;
  const toolCalls = response.toolCalls ?? [];
  for (let index = 0; index < toolCalls.length; index++) {
    const call = toolCalls[index];
    if (outputs.length >= MAX_OUTPUTS) { outputsComplete = false; reason('output_item_limit'); continue; }
    if (!call.id || utf8Bytes(call.id) > MAX_ID_BYTES || !call.function?.name || utf8Bytes(call.function.name) > MAX_NAME_BYTES) {
      outputsComplete = false; reason('output_identity_overbound'); continue;
    }
    outputs.push({
      kind: 'tool_call', node_ref: `provider-call:${call.id}`, provider_call_id: call.id,
      output_position: index, name: call.function.name,
    });
  }
  if (response.content) {
    if (outputs.length >= MAX_OUTPUTS) { outputsComplete = false; reason('output_item_limit'); }
    else outputs.push({
      kind: 'message',
      node_ref: options.outputMessageRef || `session:${options.sessionId}:episode:${options.episodeId ?? 'unknown'}:model-call:${modelCallId}:output:0`,
      output_position: outputs.length, content_sha256: contentDigest(response.content),
    });
  }
  outputsComplete &&= toolCalls.length + (response.content ? 1 : 0) <= MAX_OUTPUTS;

  const sourceOrigin = (message: Message) => {
    const sessionId = message.__executionSourceSessionId;
    const episodeId = message.__executionSourceEpisodeId;
    const sourceModelCallId = message.__executionSourceModelCallId;
    if (!sessionId || !episodeId || !sourceModelCallId) return undefined;
    return { source_session_id: sessionId, source_episode_id: episodeId, source_model_call_id: sourceModelCallId };
  };

  const rawItems: Array<Record<string, any>> = messages.flatMap((message, index) => {
    const wrapper = { role: message.role, content: message.content, tool_calls: message.tool_calls, tool_call_id: message.tool_call_id };
    const shared = { sha256: digest(wrapper), content_sha256: contentDigest(message.content), visibility: 'submitted' };
    return executionRefsForMessage(message, options.sessionId, options.episodeId, index).map(ref => {
      const checkpoint = message.__checkpointSummary && message.__checkpointPersisted && message.__checkpointId
        ? {
          checkpoint_id: message.__checkpointId,
          identity_contract: EXECUTION_IDENTITY_CONTRACT,
          version: message.__checkpointVersion,
          summary_sha256: message.__checkpointSummarySHA256,
          covered_node_refs: message.__checkpointCoveredNodeRefs ?? [],
          covered_node_origins: message.__checkpointCoveredNodeOrigins ?? [],
          covered_node_refs_complete: message.__checkpointCoveredRefsComplete === true,
          covered_unknown_ref_count: message.__checkpointUnknownRefCount ?? 0,
          coverage_complete: message.__checkpointCoverageComplete === true,
          coverage_reason: message.__checkpointCoverageReason ?? null,
          previous_checkpoint_id: message.__checkpointPreviousId ?? null,
          previous_last_message_ref: message.__checkpointPreviousLastMessageRef ?? null,
          previous_frontier_ref: message.__checkpointPreviousFrontierRef ?? [],
        }
        : undefined;
      const origin = sourceOrigin(message);
      const programmaticScope = ref.identity_state === 'programmatic_observation'
        ? { source_session_id: options.sessionId, source_episode_id: options.episodeId ?? 'unknown' }
        : undefined;
      return { ...shared, kind: ref.kind, ref: ref.ref, identity_state: ref.identity_state,
        ...(ref.source_kind ? { source_kind: ref.source_kind } : {}),
        ...(programmaticScope ?? (origin && (ref.kind === 'tool_call' || ref.kind === 'turn_result' || ref.ref === message.__executionNodeRef) ? origin : {})),
        ...(checkpoint ? { checkpoint } : {}) };
    });
  });

  const toolDefinitions = (options.tools ?? []).map(tool => {
    if (utf8Bytes(tool.name) > MAX_NAME_BYTES) reason('tool_name_overbound');
    return { name: tool.name.slice(0, MAX_NAME_BYTES), schema_sha256: digest({ description: tool.description, parameters: tool.parameters }) };
  });
  let items = rawItems.slice(0, MAX_ITEMS);
  let tools = toolDefinitions.slice(0, MAX_ITEMS);
  let itemsComplete = rawItems.length <= MAX_ITEMS;
  let toolsComplete = toolDefinitions.length <= MAX_ITEMS && !completenessReason?.startsWith('tool_name_');
  if (!itemsComplete) reason('input_item_limit');
  if (!toolsComplete) reason('tool_schema_limit');
  const manifest: Record<string, any> = { items, complete: false, tools, tools_complete: toolsComplete };
  const recalcComplete = () => {
    manifest.complete = itemsComplete && toolsComplete && items.every(item => item.identity_state !== 'unknown');
  };
  recalcComplete();
  if (items.some(item => item.identity_state === 'unknown')) reason('historical_input_identity_unknown');

  while (utf8Bytes(JSON.stringify(manifest)) > MAX_BYTES && tools.length) {
    tools = tools.slice(0, -1);
    manifest.tools = tools;
    toolsComplete = false;
    manifest.tools_complete = false;
    recalcComplete();
    reason('manifest_byte_limit');
  }
  while (utf8Bytes(JSON.stringify(manifest)) > MAX_BYTES && items.length) {
    items = items.slice(0, -1);
    manifest.items = items;
    itemsComplete = false;
    recalcComplete();
    reason('manifest_byte_limit');
  }
  // Even a tool-list-only overflow becomes an explicitly incomplete bounded prefix.
  if (utf8Bytes(JSON.stringify(manifest)) > MAX_BYTES) {
    manifest.tools = [];
    manifest.items = [];
    manifest.tools_complete = false;
    manifest.complete = false;
    reason('manifest_byte_limit');
  }

  const checkpointConsumptions = items
    .filter(item => item.checkpoint && item.ref === item.checkpoint.checkpoint_id
      && item.content_sha256 === item.checkpoint.summary_sha256)
    .map(item => item.checkpoint);
  if (!manifest.complete) reason('incomplete_input_manifest');
  const memoryNodeInputs = collectExecutionMemoryInputs(messages, { sessionId: options.sessionId, episodeId: options.episodeId })
    .filter(binding => items.some(candidate => {
      if (candidate.ref !== binding.input_node_ref || candidate.sha256 !== binding.input_sha256) return false;
      if (binding.carrier === 'programmatic_observation') {
        return candidate.identity_state === 'programmatic_observation'
          && candidate.source_session_id === binding.source_session_id
          && candidate.source_episode_id === binding.source_episode_id
          && !candidate.source_model_call_id;
      }
      if (binding.identity_state === 'producer_origin_unknown') return true;
      return candidate.source_session_id === binding.source_session_id
        && candidate.source_episode_id === binding.source_episode_id
        && candidate.source_model_call_id === binding.source_model_call_id;
    }));

  return {
    contract_version: EXECUTION_GRAPH_CONTRACT,
    identity_contract: EXECUTION_IDENTITY_CONTRACT,
    event_id: randomUUID(), session_id: options.sessionId, episode_id: options.episodeId ?? null,
    type: 'successful_model_call', model_call_id: modelCallId,
    model_call_attempt_id: `${modelCallId}:attempt:${Math.max(1, Math.floor(options.attempt))}`,
    attempt: Math.max(1, Math.floor(options.attempt)), status: 'succeeded',
    input_manifest: manifest, input_manifest_sha256: digest(manifest), input_manifest_complete: manifest.complete,
    checkpoint_consumptions: checkpointConsumptions,
    projection_observations: projectionObservations(messages, modelCallId),
    memory_node_inputs: memoryNodeInputs,
    outputs, outputs_complete: outputsComplete, completeness_reason: completenessReason ?? null,
    evidence_claim: 'client_recorded_provider_request_and_response',
  };
}

export function ensureExecutionNodeRefs(messages: Message[], sessionId: string, episodeId?: string): void {
  const episode = episodeId ?? 'unknown';
  messages.forEach(message => {
    if (!message.__executionNodeRef && message.__episodeId === episode
      && (message.__episodeInputKind === 'root' || message.__episodeInputKind === 'pending')) {
      message.__executionNodeRef = `session:${sessionId}:episode:${episode}:message:${randomUUID()}`;
    }
  });
}

export function checkpointMetadata(input: {
  sessionId: string; episodeId?: string; summary: Message; covered: Message[]; previous?: Message;
  lastMessage?: Message; frontier?: Message[]; frontierRefs?: string[]; lastMessageRef?: string; coverageComplete: boolean;
}): Record<string, unknown> {
  const cpId = `checkpoint:${randomUUID()}`;
  const summarySha = contentDigest(input.summary.content);
  const refRows = input.covered.flatMap((message, index) => executionRefsForMessage(message, input.sessionId, input.episodeId, index).map(ref => ({ ref, message })));
  const refs = refRows.map(row => row.ref);
  const coveredNodeRefs = refs.map(ref => ref.ref).slice(0, 4096);
  const originsComplete = refRows.every(({ ref, message }) => {
    const needsOrigin = ref.kind === 'tool_call' || ref.kind === 'turn_result'
      || (ref.kind === 'message' && ref.ref.includes(':model-call:'));
    return !needsOrigin || Boolean(message.__executionSourceSessionId && message.__executionSourceEpisodeId && message.__executionSourceModelCallId);
  });
  const coveredRefsComplete = refs.length <= 4096 && refs.every(ref => ref.identity_state !== 'unknown') && originsComplete;
  return {
    checkpoint_id: cpId, identity_contract: EXECUTION_IDENTITY_CONTRACT, version: 1, session_id: input.sessionId, episode_id: input.episodeId ?? null,
    summary_sha256: summarySha, covered_node_refs: coveredNodeRefs,
    covered_node_origins: refRows.flatMap(({ ref, message }) => {
      const sessionId = message.__executionSourceSessionId;
      const episodeId = message.__executionSourceEpisodeId;
      const modelCallId = message.__executionSourceModelCallId;
      return sessionId && episodeId && modelCallId ? [{ ref: ref.ref, source_session_id: sessionId, source_episode_id: episodeId, source_model_call_id: modelCallId }] : [];
    }).slice(0, 4096),
    covered_node_refs_complete: coveredRefsComplete,
    covered_unknown_ref_count: refs.filter(ref => ref.identity_state === 'unknown').length,
    coverage_complete: input.coverageComplete && coveredRefsComplete,
    previous_checkpoint_id: input.previous?.__checkpointId ?? null,
    previous_last_message_ref: input.lastMessageRef ?? input.lastMessage?.__executionNodeRef
      ?? (input.lastMessage ? `unknown-session-node:${input.sessionId}:${input.episodeId ?? 'unknown'}:last:${contentDigest(input.lastMessage.content).slice(0, 16)}` : null),
    previous_frontier_ref: (input.frontierRefs ?? (input.frontier ?? []).map(message => message.__executionNodeRef || '')).filter(Boolean).slice(0, 512),
    coverage_reason: input.coverageComplete && coveredRefsComplete ? null : refs.length > 4096 ? 'covered_node_ref_limit' : 'unknown_or_partial_summary_source',
    completeness_reason: input.coverageComplete && coveredRefsComplete ? null : 'covered_node_ref_incomplete_or_overbound',
  };
}

export function attachCheckpointMetadata(summary: Message, metadata: Record<string, any>): void {
  summary.__checkpointId = metadata.checkpoint_id;
  summary.__checkpointVersion = metadata.version;
  summary.__checkpointSummarySHA256 = metadata.summary_sha256;
  summary.__checkpointCoveredNodeRefs = metadata.covered_node_refs;
  summary.__checkpointCoveredNodeOrigins = metadata.covered_node_origins ?? [];
  summary.__checkpointCoveredRefsComplete = metadata.covered_node_refs_complete;
  summary.__checkpointUnknownRefCount = metadata.covered_unknown_ref_count;
  summary.__checkpointCoverageReason = metadata.coverage_reason;
  summary.__checkpointCoverageComplete = metadata.coverage_complete;
  summary.__checkpointPreviousId = metadata.previous_checkpoint_id;
  summary.__checkpointPreviousLastMessageRef = metadata.previous_last_message_ref;
  summary.__checkpointPreviousFrontierRef = metadata.previous_frontier_ref;
  summary.__executionNodeRef = metadata.checkpoint_id;
}

export function checkpointSummarySha256(content: Message['content']): string { return contentDigest(content); }
export function executionMessageSha256(message: Message): string {
  return digest({ role: message.role, content: message.content, tool_calls: message.tool_calls, tool_call_id: message.tool_call_id });
}
