import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { matchBranchCitations } from '../src/core/branch-citation-reporter';
import type { SyntheticObservation } from '../src/core/synthetic-observation';

const REF_A = `ref_${'a'.repeat(64)}`;
const REF_B = `ref_${'b'.repeat(64)}`;
const KB_REF = 'kb:KB-11111111-2222-4333-8444-555555555555';
const FILE_REF = 'file:documents/rollback-notes.md';

function observation(metadata: SyntheticObservation['metadata']): SyntheticObservation {
  return {
    id: 'obs-1',
    source: 'memory',
    status: 'completed',
    relevance: 'medium',
    summary: 's',
    metadata,
  };
}

describe('branch citation matcher', () => {
  test('matches reply text against the injected citation pool and unions per request', async () => {
    const match = matchBranchCitations([
      observation({ citation: { requestId: 'br-1', refs: [REF_A, REF_B] }, refs: [REF_A, REF_B] }),
      observation({ citation: { requestId: 'br-1', refs: [REF_B] } }),
      observation({ citation: { requestId: 'br-2', refs: [REF_B] } }),
    ], `根据 ${REF_A} 的结论，同时参考 ${REF_B}。`);

    assert.equal(match.reports.length, 2);
    const br1 = match.reports.find(report => report.requestId === 'br-1');
    assert.deepEqual(br1?.refs, [REF_A, REF_B]);
    const br2 = match.reports.find(report => report.requestId === 'br-2');
    assert.deepEqual(br2?.refs, [REF_B]);
  });

  test('reports only ref_-prefixed pool refs; kb and file refs stay local', async () => {
    const match = matchBranchCitations([
      observation({
        citation: { requestId: 'br-1', refs: [REF_A] },
        refs: [REF_A, KB_REF, FILE_REF],
      }),
    ], `cite ${KB_REF} and ${FILE_REF} but not the pool ref`);
    // The pool ref never appears in the reply: no server report.
    assert.deepEqual(match.reports, []);
    assert.deepEqual(match.knowledgeRefs, [KB_REF, FILE_REF]);
  });

  test('ignores malformed citation metadata and invalid request ids', async () => {
    const match = matchBranchCitations([
      observation({ citation: { requestId: '', refs: [REF_A] } }),
      observation({ citation: { requestId: 'br\u0000bad', refs: [REF_A] } }),
      observation({ citation: { requestId: 42 as unknown as string, refs: [REF_A] } }),
      observation({ citation: undefined, refs: [REF_A] }),
      observation(undefined),
    ], REF_A);
    assert.deepEqual(match.reports, []);
    assert.deepEqual(match.knowledgeRefs, []);
  });

  test('non-pool-shaped refs inside the citation pool are never reported', async () => {
    const match = matchBranchCitations([
      observation({
        citation: {
          requestId: 'br-1',
          refs: [REF_A, 'catslog:ref:aaaaaaaaaaaaaaaaaaaaaaaa', KB_REF, 'ref_short'],
        },
        refs: [KB_REF],
      }),
    ], `${REF_A} ${KB_REF} catslog:ref:aaaaaaaaaaaaaaaaaaaaaaaa ref_short`);
    assert.equal(match.reports.length, 1);
    assert.deepEqual(match.reports[0].refs, [REF_A]);
    assert.deepEqual(match.knowledgeRefs, [KB_REF]);
  });

  test('empty or missing reply text yields no reports', async () => {
    const observation1 = observation({ citation: { requestId: 'br-1', refs: [REF_A] } });
    assert.deepEqual(matchBranchCitations([observation1], '').reports, []);
    assert.deepEqual(matchBranchCitations([observation1], undefined).reports, []);
    assert.deepEqual(matchBranchCitations([], REF_A).reports, []);
  });
});

describe('collectAssistantCitationText', () => {
  test('kb refs match the bare KB-ID inside a tool_call file path', async () => {
    const { collectAssistantCitationText } = await import('../src/core/branch-citation-reporter');
    const corpus = collectAssistantCitationText([
      {
        role: 'assistant',
        content: '我先查一下知识库记录',
        tool_calls: [{
          id: 'c1', type: 'function',
          function: { name: 'read_file', arguments: '{"path":"/opt/xiaoba-cli/knowledge/documents/KB-11111111-2222-4333-8444-555555555555.md"}' },
        }],
      },
      { role: 'assistant', content: '最终答复文本', tool_calls: undefined },
    ], '最终答复文本');
    const match = matchBranchCitations([
      observation({ refs: [KB_REF, 'kb:KB-99999999-9999-4999-8999-999999999999'] }),
    ], corpus);
    assert.deepEqual(match.knowledgeRefs, [KB_REF]);
  });

  test('assistant tool_call arguments carrying a pool ref count as citations', async () => {
    const { collectAssistantCitationText } = await import('../src/core/branch-citation-reporter');
    const corpus = collectAssistantCitationText([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'c2', type: 'function',
          function: { name: 'context_fetch', arguments: `{"ref":"${REF_A}"}` },
        }],
      },
    ], '答复未提及 ref');
    const match = matchBranchCitations([
      observation({ citation: { requestId: 'br-3', refs: [REF_A, REF_B] }, refs: [REF_A] }),
    ], corpus);
    assert.deepEqual(match.reports, [{ requestId: 'br-3', refs: [REF_A] }]);
  });

  test('injection evidence in user/tool messages never counts as a citation', async () => {
    const { collectAssistantCitationText } = await import('../src/core/branch-citation-reporter');
    const corpus = collectAssistantCitationText([
      { role: 'user', content: `injected evidence mentions ${REF_A}` },
      { role: 'tool', content: `tool result echoes ${REF_B}`, tool_call_id: 't1' },
      { role: 'assistant', content: 'clean reply' },
    ], 'clean reply');
    const match = matchBranchCitations([
      observation({ citation: { requestId: 'br-4', refs: [REF_A, REF_B] }, refs: [REF_A, REF_B] }),
    ], corpus);
    assert.deepEqual(match.reports, []);
    assert.deepEqual(match.knowledgeRefs, []);
  });
});
