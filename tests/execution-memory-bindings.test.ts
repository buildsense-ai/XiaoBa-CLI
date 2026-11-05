import assert from 'node:assert/strict';
import test from 'node:test';
import { collectExecutionMemoryInputs } from '../src/core/execution-memory-bindings';
import type { Message } from '../src/types';

// Failure modes declared before implementation: metadata-only hits, prose refs,
// wrong node/ref/revision shape, clipped bodies, absent input, and oversized
// bundles cannot masquerade as a submitted exact node. This exercises the wire
// consumed by the successful-call producer; server reproof is a separate gate.
const anchor = { kind: 'source_memory_projection_node', source_projection_ref: 'ref_'+'a'.repeat(64), revision:'b'.repeat(64),id:'c'.repeat(64) };
const message=(body:unknown):Message=>({role:'tool',tool_call_id:'read-1',content:JSON.stringify(body)});
test('binds exact node and source mappings only from submitted structured body',()=>{
 const body={retained_remote_evidence:[{ref:anchor.source_projection_ref,semantic_view:{content_trust:'derived_memory_projection',nodes:[{id:anchor.id,text:'Preserve the lock.',anchor}],conditions:['Until commit.'],omissions:['No retry evidence.'],mappings:[]}}]};
 const bindings=collectExecutionMemoryInputs([message(body)]);
 assert.equal(bindings.length,1);
 assert.deepEqual(bindings[0].anchor,anchor);
 assert.equal(bindings[0].input_node_ref,'provider-result:read-1');
 assert.match(bindings[0].input_sha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(collectExecutionMemoryInputs([]),[]);
 assert.deepEqual(collectExecutionMemoryInputs([message({hits:[{anchor}]})]),[]);
 assert.deepEqual(collectExecutionMemoryInputs([message({text:JSON.stringify(body)})]),[]);
 assert.deepEqual(collectExecutionMemoryInputs([{role:'tool',tool_call_id:'read-1',content:'{"retained_remote_evidence":['}]),[]);
});
test('preserves separate producer origins for identical bodies and reused provider IDs', () => {
 const body={source:{status:'read',coverage:'complete',text:'Pinned node.',anchor}};
 const first={...message(body),__executionSourceSessionId:'s',__executionSourceEpisodeId:'e1',__executionSourceModelCallId:'producer-1'};
 const second={...message(body),__executionSourceSessionId:'s',__executionSourceEpisodeId:'e2',__executionSourceModelCallId:'producer-2'};
 const bindings=collectExecutionMemoryInputs([first,second]);
 assert.equal(bindings.length,2);
 assert.deepEqual(bindings.map(binding=>binding.source_model_call_id),['producer-1','producer-2']);
 assert.equal(bindings[0].input_node_ref,bindings[1].input_node_ref);
 assert.equal(bindings[0].input_sha256,bindings[1].input_sha256);
});

test('binds the MemorySourceReadTool expanded body delivered to the real model input',()=>{
 const response={status:'expanded',ref:anchor.source_projection_ref,semantic_view:{content_trust:'derived_memory_projection',nodes:[{id:anchor.id,text:'same node',anchor}]}};
 const result=collectExecutionMemoryInputs([message(response)]);
 assert.equal(result.length,1);
 assert.deepEqual(result[0].anchor,anchor);
});

test('binds MemorySourceReadTool node refs from the exact observed read without changing semantic view nodes',()=>{
 const response={status:'expanded',ref:anchor.source_projection_ref,
  semantic_view:{content_trust:'derived_memory_projection',nodes:[{id:anchor.id,text:'same node'}]},
  observation:{hit:{projection_ref:anchor.source_projection_ref},read:{projection_ref:anchor.source_projection_ref,
   revision:anchor.revision,node_refs:[anchor]},returned_to_branch:true,cited_node_refs:[],retained_node_refs:[]}};
 const result=collectExecutionMemoryInputs([message(response)]);
 assert.equal(result.length,1);
 assert.deepEqual(result[0].anchor,anchor);
});

test('binds an exact source node when the runner adds its structured tool target context',()=>{
 const source={status:'read',coverage:'complete',text:'Pinned node.',anchor};
 const prefixed=`[tool_target]
tool: catslog_knowledge_recall
operation: read
target: current_local_runtime
[/tool_target]

${JSON.stringify({source})}`;
 assert.equal(collectExecutionMemoryInputs([message({source})]).length,1);
 assert.equal(collectExecutionMemoryInputs([{role:'tool',tool_call_id:'read-1',content:prefixed}]).length,1);
});

test('native source requires complete readable body; malformed anchors do not bind',()=>{
 const source={status:'read',coverage:'complete',text:'Pinned node.',anchor};
 assert.equal(collectExecutionMemoryInputs([message({source})]).length,1);
 for(const changed of [{...source,status:'stale'},{...source,coverage:'partial'},{...source,text:''},{...source,anchor:{...anchor,revision:'latest'}}]){
  assert.deepEqual(collectExecutionMemoryInputs([message({source:changed})]),[]);
 }
});
