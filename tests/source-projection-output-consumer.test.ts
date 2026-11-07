import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSourceProjectionSemanticView, expandSourceReferences, validateSourceMemoryProjectionDocument,
} from '../src/core/catslog-projection-reference';
import { collectExecutionMemoryInputs } from '../src/core/execution-memory-bindings';
import { startCatsLogProjectionFixture, ROOT_REVISION, ROOT_STREAM, opaqueRef, digest } from './helpers/catslog-projection-fixture';
import { runActualFlow } from './helpers/catslog-projection-harness';

// Failure matrix is declared before the implementation assertions below:
// missing/foreign/duplicate/orphan output alignment, kind mismatch, source
// withdrawal, and whole-view over-budget must never promote semantic evidence.
const outputMessageA = 'scoped-output-message-a';
const outputMessageB = 'scoped-output-message-b';
const outputTool = 'scoped-output-tool';
const hyperedgeOutputs = [outputMessageA, outputMessageB, outputTool];
const sourceBasis = 'b'.repeat(64);
const parentAnchor = { kind: 'session_result', stream_id: 'session-stream', id: 'parent-result' };
const nodeMessage = digest('cleaned-message');
const nodeMessageReuse = digest('cleaned-message-reuse');
const nodeTool = digest('cleaned-tool');
const nodeToolSibling = digest('cleaned-tool-sibling');
const nodeOmission = digest('cleaned-omission');

function proof(ref: string, kind: 'message' | 'tool_call', extra: Record<string, unknown> = {}) {
  return {
    ref, kind, ...(kind === 'tool_call' ? { subtype: 'tool_call', provider_call_id: 'provider-tool-1', name: 'lookup' } : {}),
    source_ref: `raw-producer-output:${ref}`,
    body_sha256: digest(`body-${ref}`),
    source_session_id: 'source-session-1', source_episode_id: 'episode-1', source_model_call_id: 'model-call-1',
    output_position: kind === 'tool_call' ? 1 : 0, body_path: `assistant.outputs[${kind === 'tool_call' ? 1 : 0}].body`,
    source_revision: ROOT_REVISION, source_basis: sourceBasis, parent_anchor: parentAnchor,
    parent_digest: 'c'.repeat(64), generation_hyperedge_ref: 'model-call-1', hyperedge_output_refs: hyperedgeOutputs,
    ...extra,
  };
}

function outputDocument(overrides: Record<string, unknown> = {}): any {
  return {
    schema_version: 1, goal: 'Output identity retention', summary: 'Cleaned outputs retain generation context.',
    provenance: 'derived', model_steps: 'unknown', causality: 'unknown', overall_coverage: 'complete',
    conditions: ['Only use the message after the condition is checked.'],
    omissions: ['The withheld metric remains unknown.'],
    nodes: [
      { id: nodeMessage, kind: 'message', text: 'Use the approved message.', output_evidence_refs: [outputMessageA, outputMessageB] },
      { id: nodeMessageReuse, kind: 'message', text: 'The same message also supports this cleaned meaning.', output_evidence_refs: [outputMessageA] },
      { id: nodeTool, kind: 'tool_call', text: 'Call lookup with the preserved arguments.', output_evidence_refs: [outputTool] },
      { id: nodeToolSibling, kind: 'tool_call', text: 'The tool output also supports this sibling meaning.', output_evidence_refs: [outputTool] },
      { id: nodeOmission, kind: 'omission', text: 'The withheld metric remains unknown.' },
    ],
    edges: [
      { from: nodeMessage, to: nodeMessageReuse, kind: 'supports' },
      { from: nodeMessage, to: nodeTool, kind: 'qualifies' },
      { from: nodeOmission, to: nodeMessage, kind: 'omits' },
    ],
    mappings: [
      { node_id: nodeMessage, output_refs: [outputMessageA, outputMessageB] },
      { node_id: nodeMessageReuse, output_refs: [outputMessageA] },
      { node_id: nodeTool, output_refs: [outputTool] },
      { node_id: nodeToolSibling, output_refs: [outputTool] },
      { node_id: nodeOmission, source_ref: 'legacy-source-ref', source_digest: 'd'.repeat(64) },
    ],
    output_proofs: [proof(outputMessageA, 'message'), proof(outputMessageB, 'message', { output_position: 2, body_path: 'assistant.outputs[2].body' }), proof(outputTool, 'tool_call')],
    ...overrides,
  };
}

function readFor(document: any): any {
  return {
    schema_version: 1, content_trust: 'derived_memory_projection',
    projection: { Revision: ROOT_REVISION, StreamID: ROOT_STREAM, Document: document },
    sources: [{ text: 'server-authenticated source proof material must not enter model context', status: 'read' }],
  };
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }

const invalidCases: Array<[string, (document: any) => void]> = [
  ['foreign output ref', document => { document.nodes[0].output_evidence_refs = ['foreign-output']; document.mappings[0].output_refs = ['foreign-output']; }],
  ['missing output mapping', document => { document.mappings = document.mappings.filter((mapping: any) => mapping.node_id !== nodeTool); }],
  ['duplicate proof definition', document => { document.output_proofs.push(clone(document.output_proofs[0])); }],
  ['orphan proof', document => { document.output_proofs.push(proof('orphan-output', 'message')); }],
  ['duplicate output ref in node declaration', document => { document.nodes[0].output_evidence_refs = [outputMessageA, outputMessageA]; }],
  ['message/tool-call kind mismatch', document => { document.nodes[2].output_evidence_refs = [outputMessageA]; document.mappings[2].output_refs = [outputMessageA]; }],
  ['empty evidence refs with absent proofs', document => {
    for (const node of document.nodes) if (node.kind === 'message' || node.kind === 'tool_call') node.output_evidence_refs = [];
    for (const mapping of document.mappings) delete mapping.output_refs;
    delete document.output_proofs;
  }],
  ['empty evidence refs with empty proofs', document => {
    for (const node of document.nodes) if (node.kind === 'message' || node.kind === 'tool_call') node.output_evidence_refs = [];
    for (const mapping of document.mappings) delete mapping.output_refs;
    document.output_proofs = [];
  }],
  ['malformed output body path', document => { document.output_proofs[0].body_path = 'assistant.outputs[0]'; }],
  ['mismatched hyperedge identity', document => { document.output_proofs[0].generation_hyperedge_ref = 'different-call'; }],
  ['divergent metadata for one call identity', document => { document.output_proofs[1].input_refs = ['conflicting-input']; }],
  ['output meaning without proof', document => { document.output_proofs = document.output_proofs.filter((candidate: any) => candidate.ref !== outputTool); }],
  ['cross-projection output alignment', document => { document.mappings[0].output_refs = ['other-projection-output']; }],
];
for (const [name, mutate] of invalidCases) {
  test(`consumer rejects ${name} before semantic promotion`, () => {
    const document = outputDocument(); mutate(document);
    assert.equal(validateSourceMemoryProjectionDocument(readFor(document), opaqueRef(ROOT_REVISION, ROOT_STREAM)).reason, 'invalid_response');
  });
}

test('valid output consumer preserves multiplicity, identity, generation context, and interpretation closure', () => {
  const document = outputDocument();
  document.output_proofs[1].source_session_id = 'source-session-2';
  document.output_proofs[1].hyperedge_output_refs = [outputMessageB];
  document.output_proofs[0].hyperedge_output_refs = [outputMessageA, outputTool];
  document.output_proofs[2].hyperedge_output_refs = [outputMessageA, outputTool];
  const validation = validateSourceMemoryProjectionDocument(readFor(document), opaqueRef(ROOT_REVISION, ROOT_STREAM));
  assert.equal(validation.ok, true);
  const view = buildSourceProjectionSemanticView(validation)!;
  assert.deepEqual(view.qualifiers, {
    conditions: [{ text: outputDocument().conditions[0] }],
    omissions: [{ node_id: nodeOmission }],
  });
  assert.deepEqual((view.nodes as any[]).find(node => node.id === nodeMessage).output_proof_refs, [outputMessageA, outputMessageB]);
  assert.deepEqual((view.nodes as any[]).find(node => node.id === nodeTool).output_proof_refs, [outputTool]);
  assert.deepEqual((view.mappings as any[]).find(mapping => mapping.node_id === nodeMessage).output_refs, [outputMessageA, outputMessageB]);
  assert.equal((view.output_proofs as any[]).length, 3);
  assert.equal(Object.keys(view.generation_contexts as object).length, 2, 'same call ID in distinct sessions remains distinct');
  const proofContext = Object.values(view.generation_contexts as Record<string, any>)[0];
  assert.equal(proofContext.source_model_call_id, 'model-call-1');
  assert.equal(proofContext.source_revision, ROOT_REVISION);
  assert.equal(proofContext.source_basis, sourceBasis);
  assert.deepEqual(proofContext.hyperedge_output_refs, [outputMessageA, outputTool]);
  const collisionContext = Object.values(view.generation_contexts as Record<string, any>)[1];
  assert.equal(collisionContext.source_session_id, 'source-session-2');
  assert.deepEqual(collisionContext.hyperedge_output_refs, [outputMessageB]);
  assert.equal(JSON.stringify(view).includes('parent-result'), false, 'authority-only parent anchor leaked');
});

test('valid output projection expands through the actual client and reaches native execution-memory input', async () => {
  const fixture = await startCatsLogProjectionFixture({ document: outputDocument() });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-output-e2e-'));
  try {
    const run = await runActualFlow({
      targetRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), root, baseUrl: fixture.baseUrl,
      token: fixture.token, question: 'What output and condition should be retained?', keyword: 'output',
    });
    assert.ok(run.delivered.size > 0);
    const retainedView = [...run.delivered.values()][0];
    assert.equal((retainedView.nodes as any[]).some(node => node.kind === 'message'), true);
    assert.equal((retainedView.nodes as any[]).some(node => node.kind === 'tool_call'), true);
    assert.deepEqual(retainedView.qualifiers, {
      conditions: [{ text: outputDocument().conditions[0] }],
      omissions: [{ node_id: nodeOmission }],
    });
    assert.ok(run.observations.length > 0);
    assert.ok(run.mainCalls.length > 0);
    const bindings = collectExecutionMemoryInputs([{
      role: 'tool', tool_call_id: 'memory-observation', content: run.observations[0].formattedContent,
    }] as any);
    assert.ok(bindings.some(binding => binding.anchor.id === nodeMessage), 'native input binding lost output node anchor');
    assert.ok(run.mainResponse.includes(fixture.identities[0].ref), 'main model did not receive retained evidence');
    const artifactPath = process.env.CATSLOG_CONSUMER_ARTIFACT;
    if (artifactPath) {
      const nodeCounts = (retainedView.nodes as any[]).reduce((counts: Record<string, number>, node: any) => {
        counts[node.kind] = (counts[node.kind] ?? 0) + 1;
        return counts;
      }, {});
      const actualBindingIds = bindings.map(binding => binding.anchor.id).sort();
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
      fs.writeFileSync(artifactPath, JSON.stringify({
        schema_version: 1,
        provenance: {
          source: 'local deterministic HTTP fixture',
          server: 'simulated source/read response; Go source reproof not invoked',
          production: false,
        },
        fixture_input_sha256: digest(JSON.stringify(outputDocument())),
        projection_ref_sha256: digest(fixture.identities[0].ref),
        retained_view_sha256: digest(JSON.stringify(retainedView)),
        node_counts: nodeCounts,
        output_proof_count: (retainedView.output_proofs as any[]).length,
        binding_ids_sha256: {
          expected: digest(JSON.stringify([nodeMessage])),
          actual: digest(JSON.stringify(actualBindingIds)),
        },
        checks: {
          output_nodes_retained: true,
          conditions_and_omissions_retained: true,
          observation_delivered: run.observations.length > 0,
          native_binding_contains_expected_node: actualBindingIds.includes(nodeMessage),
          passed: true,
        },
      }, null, 2) + '\n', 'utf8');
    }
  } finally {
    await fixture.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source withdrawal remains typed reference_only and never becomes semantic evidence', async () => {
  const response = { branches: [{ source: 'agent_memory', items: [{ source: 'agent_memory', kind: 'source_reference', ref: opaqueRef(ROOT_REVISION, ROOT_STREAM) }] }] };
  const result = await expandSourceReferences(response, async () => { throw Object.assign(new Error('withdrawn'), { status: 404 }); });
  assert.equal(result[0].status, 'reference_only');
  assert.equal(result[0].expansion_error, 'http_404');
  assert.equal(result[0].semantic_view, undefined);
});

test('proof context is whole-view bounded; it becomes reference_only rather than silently clipped', async () => {
  const document = outputDocument();
  for (const proof of document.output_proofs) {
    proof.input_refs = Array.from({ length: 512 }, (_, index) => `input-${index}-${'x'.repeat(80)}`);
  }
  const response = { branches: [{ source: 'agent_memory', items: [{ source: 'agent_memory', kind: 'source_reference', ref: opaqueRef(ROOT_REVISION, ROOT_STREAM) }] }] };
  const result = await expandSourceReferences(response, async () => readFor(document));
  assert.equal(result[0].status, 'reference_only');
  assert.equal(result[0].expansion_error, 'semantic_view_over_budget');
  assert.equal(result[0].semantic_view, undefined);
});
