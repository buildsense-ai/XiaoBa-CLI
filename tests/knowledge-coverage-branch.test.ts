import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { consolidateMemoryEvidencePack } from '../src/core/branch-evidence-pack';
import { MemorySearchBranchSession } from '../src/core/memory-search-branch-session';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import { hashedRecallRef } from '../src/core/native-recall-attribution';
import type { CatsLogKnowledgeAnchor } from '../src/utils/catslog-knowledge-types';

// Diary documents are read by the main agent (docs/catslog-recall-layering.md);
// these Branch checks cover local KB packing and the finish guard only.
const sourceAnchor = (n: number): CatsLogKnowledgeAnchor => ({ kind: 'session_query', id: `ref_${createHash('sha256').update(`source-stream\0${n * 100}`).digest('hex')}`, session_id: 'source-session', stream_id: 'source-stream', byte_offset: n * 100, revision: String(n).padStart(64, '0') });

test('secondary KB packing retains metadata before excerpts and reports actual prefix coordinates/counters', () => {
  const entries = [1, 2].map(n => ({ ref: `kb:entry-${n}`, title: `metadata-${n}`, revision: 'revision-pin', excerpt: {
    ref: `kb:entry-${n}`, revision: 'revision-pin', text: '\"\\🙂'.repeat(500), char_start: 10, char_end: 2010, omitted_after: false, truncated: false,
  } }));
  const full = consolidateMemoryEvidencePack({ remoteBranch: {}, sessionRecords: {}, localKnowledge: { entries, excerpts_requested: 2, excerpts_retained: 2, excerpts_projected: 2 } });
  const raw = JSON.stringify(full);
  for (let cap = 400; cap <= 1200; cap += 50) {
    const refine = consolidateMemoryEvidencePack({ remoteBranch: {}, sessionRecords: {}, localKnowledge: full.evidencePack.local_knowledge as any }, { maxKnowledgeChars: cap, refineView: { knowledgeExcerptTextChars: 500 } });
    const kb = refine.evidencePack.local_knowledge as any;
    assert.equal(kb.entries.length, 2);
    assert.ok(JSON.stringify(kb).length <= cap);
    assert.equal(kb.excerpts_projected, kb.entries.filter((e: any) => e.excerpt).length);
    for (const entry of kb.entries) {
      assert.equal(entry.revision, 'revision-pin');
      if (entry.excerpt) {
        const text = entry.excerpt.text.replace(/\n\.\.\.\[truncated\]$/, '');
        assert.equal(entry.excerpt.char_end, 10 + text.length);
        assert.equal(entry.excerpt.projection_shortened, true);
      }
    }
    assert.ok(refine.presentedRefs.every(r => full.presentedRefs.includes(r)));
  }
  assert.equal(JSON.stringify(full), raw);
});

// The current Branch uses explicit in-loop reads. Source/context replay is
// an explicit native operation; source hashes alone never pass its finish guard.
test('current Branch rejects an unissued source hash instead of treating metadata as body', () => {
  const session: any = new MemorySearchBranchSession({ sessionKey: 'source-omission-guard', input: 'release', recentMessages: [],
    workingDirectory: os.tmpdir(), aiService: {} as any, queue: new InMemorySyntheticObservationQueue(), logEnabled: false });
  const seenRef = hashedRecallRef('source', [sourceAnchor(1), 'hash']);
  const disposition = session.getObservationDisposition({ summary: 'unseen source body', refs: [seenRef], inject: true });
  // The parser is the primary fence for non-pool/non-local refs.
  const finish = session.buildTools().find((tool: any) => tool.definition.name === 'finish_memory_search');
  return finish.execute({ summary: 'unseen source', evidence: [seenRef], inject: true }).then((result: any) => {
    assert.equal(result.ok, false);
  });
});
