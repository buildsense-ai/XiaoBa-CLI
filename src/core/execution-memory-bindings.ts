import { createHash } from 'node:crypto';
import type { Message } from '../types';
import { validateCanonicalSourceToolBody } from './canonical-memory-graph';
import { stripToolTargetContextForDisplay } from '../tools/tool-target-context';

interface ProjectionNodeAnchor {
  kind: 'source_memory_projection_node'; source_projection_ref: string; revision: string; id: string;
}
export interface ExecutionMemoryInput {
  anchor: ProjectionNodeAnchor;
  input_node_ref: string;
  input_sha256: string;
  observation: 'submitted_node_body';
  identity_state: 'producer_origin_resolved' | 'producer_origin_unknown' | 'programmatic_observation';
  carrier?: 'programmatic_observation';
  source_session_id?: string;
  source_episode_id?: string;
  source_model_call_id?: string;
}
const SHA = /^[a-f0-9]{64}$/;
const NODE_ID = /^(?:output-)?[a-f0-9]{64}$/;
function nodeAnchor(value: unknown): ProjectionNodeAnchor | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const a=value as Record<string,unknown>;
  if(a.kind!=='source_memory_projection_node'||typeof a.source_projection_ref!=='string'||!/^ref_[a-f0-9]{64}$/.test(a.source_projection_ref)
    ||typeof a.revision!=='string'||!SHA.test(a.revision)||typeof a.id!=='string'||!NODE_ID.test(a.id)) return undefined;
  return {kind:'source_memory_projection_node',source_projection_ref:a.source_projection_ref,revision:a.revision,id:a.id};
}

/** Records membership at the actual submitted-message boundary. Server source
 * proof still owns authorization/currentness. This never labels a read or a
 * matching reference in prose as semantic use, citation, or task success. */
export function collectExecutionMemoryInputs(
  messages: readonly Message[],
  scope?: { sessionId: string; episodeId?: string },
): ExecutionMemoryInput[] {
  const out:ExecutionMemoryInput[]=[];
  const seen=new Set<string>();
  for(const [messageIndex,message] of messages.slice(0,512).entries()) {
    if(message.role!=='tool'||!message.tool_call_id||typeof message.content!=='string'||Buffer.byteLength(message.content)>256*1024) continue;
    let body:any;
    try {body=JSON.parse(message.content);} catch {
      try {body=JSON.parse(stripToolTargetContextForDisplay(message.content));} catch {continue;}
    }
    if(!body||typeof body!=='object'||Array.isArray(body)) continue;
    const add = (value: unknown) => {
      const anchor = nodeAnchor(value);
      if (!anchor || out.length >= 128) return;
      const programmatic = message.__syntheticObservation === true
        && message.name === 'runtime_observation'
        && typeof message.syntheticObservationId === 'string'
        && /^[A-Za-z0-9._-]{1,200}$/.test(message.syntheticObservationId)
        && body.source === 'memory';
      if (programmatic && (!scope?.sessionId || !scope.episodeId)) return;
      const sourceSessionId=programmatic ? scope!.sessionId : message.__executionSourceSessionId;
      const sourceEpisodeId=programmatic ? scope!.episodeId : message.__executionSourceEpisodeId;
      const sourceModelCallId=programmatic ? undefined : message.__executionSourceModelCallId;
      const hasOrigin=Boolean(sourceSessionId&&sourceEpisodeId&&sourceModelCallId);
      const key=programmatic
        ? JSON.stringify(['programmatic_observation', message.syntheticObservationId, anchor])
        : hasOrigin
          ? JSON.stringify([message.tool_call_id,sourceSessionId,sourceEpisodeId,sourceModelCallId,anchor])
          : JSON.stringify([messageIndex,message.tool_call_id,anchor]);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        anchor,
        input_node_ref: programmatic
          ? `runtime-observation:${message.syntheticObservationId}:result`
          : `provider-result:${message.tool_call_id}`,
        input_sha256: createHash('sha256').update(JSON.stringify({ role: message.role, content: message.content, tool_calls: message.tool_calls, tool_call_id: message.tool_call_id })).digest('hex'),
        observation: 'submitted_node_body',
        identity_state: programmatic ? 'programmatic_observation' : hasOrigin ? 'producer_origin_resolved' : 'producer_origin_unknown',
        ...(programmatic ? { carrier: 'programmatic_observation' as const } : {}),
        ...(sourceSessionId ? { source_session_id: sourceSessionId } : {}),
        ...(sourceEpisodeId ? { source_episode_id: sourceEpisodeId } : {}),
        ...(sourceModelCallId ? { source_model_call_id: sourceModelCallId } : {}),
      });
    };
    const addNode = (node: any, expectedProjectionRef?: string, readObservation?: any) => {
      const observedRef = Array.isArray(readObservation?.node_refs)
        ? readObservation.node_refs.find((candidate: any) => candidate?.id === node?.id) : undefined;
      const anchor = nodeAnchor(node?.anchor) ?? nodeAnchor(observedRef);
      if (!anchor || !expectedProjectionRef || anchor.source_projection_ref !== expectedProjectionRef
        || (readObservation && (readObservation.projection_ref !== expectedProjectionRef || readObservation.revision !== anchor.revision))
        || node.id !== anchor.id || typeof node.text !== 'string' || !node.text.length) return;
      add(anchor);
    };
    const source=body.source;
    if (source?.anchor?.kind === 'source_memory_projection_node'
      && source.projection_context?.contract_version === 'memory-graph/3') {
      if (validateCanonicalSourceToolBody(body)) add(source.anchor);
    } else if(source?.status==='read'&&source.coverage==='complete'&&typeof source.text==='string'&&source.text.length&&!source.truncated) add(source.anchor);
    const directView=body.semantic_view;
    const directRead = body.observation?.read;
    if(body.status==='expanded'&&directView?.content_trust==='derived_memory_projection'&&Array.isArray(directView.nodes)
      &&directView.nodes.length<=32&&typeof body.ref==='string') {
      for(const node of directView.nodes) addNode(node,body.ref,directRead);
    }
    const bundles=Array.isArray(body.retained_remote_evidence)?body.retained_remote_evidence.slice(0,8):[];
    for(const bundle of bundles){
      const view=bundle?.semantic_view;
      if(view?.content_trust!=='derived_memory_projection'||!Array.isArray(view.nodes)||view.nodes.length>32)continue;
      const readObservation=bundle?.observation?.read;
      for(const node of view.nodes) addNode(node,bundle.ref,readObservation);
    }
  }
  return out;
}
