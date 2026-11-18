import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { SharedInputManifestEncoder } from '../src/utils/shared-input-manifest';

test('shared input manifest emits ordered refs and definitions with stable content hashes', () => {
  const encoder = new SharedInputManifestEncoder();
  const item = { kind: 'query', ref: 'session:s:e:q', sha256: 'a'.repeat(64), content_sha256: 'b'.repeat(64), visibility: 'submitted', identity_state: 'client_session_node' };
  const mk = (id: string, items: unknown[]) => ({ type: 'execution_graph', payload: { type: 'successful_model_call', model_call_id: id, input_manifest_sha256: 'f'.repeat(64), input_manifest: { items, complete: true, tools: [], tools_complete: true } } });
  const first = encoder.encodeEvent(mk('m1', [item])) as any;
  const second = encoder.encodeEvent(mk('m2', [item, { ...item, ref: 'session:s:e:q2' }])) as any;
  assert.deepEqual(first.payload.input_manifest.items, [{ definition: item }]);
  assert.equal(first.payload.input_manifest_reset, true);
  assert.equal(second.payload.input_manifest_reset, false);
  assert.deepEqual(second.payload.input_manifest.items, [
    { ref: createHash('sha256').update(JSON.stringify(item)).digest('hex') },
    { definition: { ...item, ref: 'session:s:e:q2' } },
  ]);
  assert.equal(first.payload.input_manifest_sha256, 'f'.repeat(64));
  assert.equal(second.payload.input_manifest.complete, true);
});

test('tool schema changes and checkpoint metadata changes remain visible and do not alias definitions', () => {
  const encoder = new SharedInputManifestEncoder();
  const checkpoint = { kind: 'checkpoint_summary', ref: 'checkpoint:1', sha256: 'a'.repeat(64), content_sha256: 'b'.repeat(64), identity_state: 'client_checkpoint', checkpoint: { checkpoint_id: 'checkpoint:1', version: 1, summary_sha256: 'b'.repeat(64), covered_node_refs: ['q1'], coverage_complete: false } };
  const make = (version: number, schema: string) => encoder.encodeEvent({ type: 'execution_graph', payload: { type: 'successful_model_call', input_manifest_sha256: 'c'.repeat(64), input_manifest: { items: [{ ...checkpoint, checkpoint: { ...checkpoint.checkpoint, version } }], complete: true, tools: [{ name: 'lookup', schema_sha256: schema }], tools_complete: true } } }) as any;
  const first = make(1, 'd'.repeat(64));
  const next = make(2, 'e'.repeat(64));
  assert.ok(first.payload.input_manifest.items[0].definition);
  assert.ok(next.payload.input_manifest.items[0].definition, 'changed checkpoint metadata has a distinct content address');
  assert.notEqual(first.payload.input_manifest.items[0].definition.checkpoint.version, next.payload.input_manifest.items[0].definition.checkpoint.version);
  assert.notDeepEqual(first.payload.input_manifest.tools, next.payload.input_manifest.tools, 'changed tool schema remains represented');
});

test('cache exhaustion emits a fresh epoch reset and logger restart begins with reset', () => {
  const encoder = new SharedInputManifestEncoder();
  let previousEpoch = '';
  for (let batch = 0; batch < 8; batch++) {
    const items = Array.from({ length: 512 }, (_, index) => ({ ref: `q-${batch}-${index}` }));
    const output = encoder.encodeEvent({ type: 'execution_graph', payload: { type: 'successful_model_call', input_manifest_sha256: 'a'.repeat(64), input_manifest: { items, complete: true, tools: [], tools_complete: true } } }) as any;
    assert.equal(output.payload.input_manifest_reset, batch === 0);
    previousEpoch = output.payload.input_manifest_epoch;
  }
  const reset = encoder.encodeEvent({ type: 'execution_graph', payload: { type: 'successful_model_call', input_manifest_sha256: 'b'.repeat(64), input_manifest: { items: [{ ref: 'after-reset' }], complete: true, tools: [], tools_complete: true } } }) as any;
  assert.equal(reset.payload.input_manifest_reset, true);
  assert.notEqual(reset.payload.input_manifest_epoch, previousEpoch);
  const following = encoder.encodeEvent({ type: 'execution_graph', payload: { type: 'successful_model_call', input_manifest_sha256: 'c'.repeat(64), input_manifest: { items: [{ ref: 'after-reset' }], complete: true, tools: [], tools_complete: true } } }) as any;
  assert.equal(following.payload.input_manifest_reset, false);
  assert.deepEqual(following.payload.input_manifest.items, [{ ref: createHash('sha256').update(JSON.stringify({ ref: 'after-reset' })).digest('hex') }]);
  const restarted = new SharedInputManifestEncoder().encodeEvent({ type: 'execution_graph', payload: { type: 'successful_model_call', input_manifest_sha256: 'd'.repeat(64), input_manifest: { items: [{ ref: 'after-reset' }], complete: true, tools: [], tools_complete: true } } }) as any;
  assert.equal(restarted.payload.input_manifest_reset, true);
  assert.notEqual(restarted.payload.input_manifest_epoch, reset.payload.input_manifest_epoch);
});

test('legacy full fallback clears definitions and next shared event starts a reset epoch', () => {
  const encoder = new SharedInputManifestEncoder();
  const oversized = Array.from({ length: 512 }, (_, index) => ({ ref: `q-${index}`, padding: 'x'.repeat(180) }));
  const full = { type: 'execution_graph', payload: { type: 'successful_model_call', input_manifest_sha256: 'e'.repeat(64), input_manifest: { items: oversized, complete: false, tools: [], tools_complete: true } } };
  const fallback = encoder.encodeEvent(full) as any;
  assert.equal(fallback.payload.input_manifest_encoding, undefined);
  assert.equal(fallback.payload.input_manifest.items.length, 512);
  const next = encoder.encodeEvent({ type: 'execution_graph', payload: { type: 'successful_model_call', input_manifest_sha256: 'f'.repeat(64), input_manifest: { items: [{ ref: 'next' }], complete: true, tools: [], tools_complete: true } } }) as any;
  assert.equal(next.payload.input_manifest_reset, true);
});

test('shared input manifest sends reordered/subset items in exact logical order', () => {
  const encoder = new SharedInputManifestEncoder();
  const a = { kind: 'query', ref: 'q-a', sha256: 'a'.repeat(64), identity_state: 'client_session_node' };
  const b = { kind: 'message', ref: 'm-b', sha256: 'b'.repeat(64), identity_state: 'client_session_node' };
  const call = (items: unknown[]) => encoder.encodeEvent({ type: 'execution_graph', payload: { type: 'successful_model_call', input_manifest_sha256: 'c'.repeat(64), input_manifest: { items, complete: true, tools: [], tools_complete: true } } }) as any;
  call([a, b]);
  const encoded = call([b]);
  assert.deepEqual(encoded.payload.input_manifest.items, [{ ref: createHash('sha256').update(JSON.stringify(b)).digest('hex') }]);
});
