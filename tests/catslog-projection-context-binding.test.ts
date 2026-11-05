import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NativeRecallTracker, canonicalRecallJSON, nativeRecallAttribution, recallTextHash, sourceRecallRef,
} from '../src/core/native-recall-attribution';

test('projection graph context is included in the ref and verified against submitted tool input', () => {
  const anchor = { kind: 'source_memory_projection_node' as const, id: 'a'.repeat(64), revision: 'b'.repeat(64), source_projection_ref: `ref_${'c'.repeat(64)}` };
  const context = {
    selected_node_id: anchor.id,
    nodes: [
      { id: anchor.id, kind: 'assertion', text: 'The deployment is ready.' },
      { id: 'd'.repeat(64), kind: 'condition', text: 'Only after the health check succeeds.' },
      { id: 'e'.repeat(64), kind: 'omission', text: 'Rollback behavior was not observed.' },
    ],
    edges: [
      { from: 'd'.repeat(64), to: anchor.id, kind: 'qualifies' },
      { from: 'e'.repeat(64), to: anchor.id, kind: 'omits' },
    ],
    mappings: [],
  };
  const contentHash = `sha256:${'f'.repeat(64)}`;
  const ref = sourceRecallRef(anchor, contentHash, context);
  const read = { tool_call_id: 'call-projection', role: 'tool', name: 'catslog_knowledge_recall', ok: true,
    content: JSON.stringify({ source: { ref, anchor, text: context.nodes[0].text, content_hash: contentHash, projection_context: context },
      recall_attribution: nativeRecallAttribution([{ ref, anchor, ref_content_hash: contentHash,
        disclosed_context_hash: recallTextHash(canonicalRecallJSON(context)), disclosure: 'text',
        disclosed_text_hash: recallTextHash(context.nodes[0].text) }]) }) };
  const tracker = new NativeRecallTracker();
  tracker.observe(read as any);
  tracker.deliver([read as any]);
  assert.deepEqual(tracker.finish([read as any], ref)[0].delivered, [{ ref, disclosure: 'text' }]);

  const alteredContext = { ...context, nodes: context.nodes.map((node, index) => index === 1 ? { ...node, text: 'Qualifier removed.' } : node) };
  assert.notEqual(sourceRecallRef(anchor, contentHash, context), sourceRecallRef(anchor, contentHash, alteredContext));
  const altered = { ...read, content: JSON.stringify({ ...JSON.parse(read.content), source: { ref, anchor, text: context.nodes[0].text, content_hash: contentHash, projection_context: alteredContext } }) };
  const tamperTracker = new NativeRecallTracker();
  tamperTracker.observe(read as any);
  tamperTracker.deliver([altered as any]);
  assert.deepEqual(tamperTracker.finish([altered as any], ref)[0].delivered, [], 'changed graph context must not satisfy original input binding');
});
