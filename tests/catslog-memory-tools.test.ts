import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { CatsLogBranchTool } from '../src/tools/catslog-memory-tools';
import { FinishMemorySearchTool } from '../src/tools/memory-branch-tools';
import type {
  CatscoBranchQuery,
  CatscoBranchResponse,
} from '../src/utils/catsco-log-agent-client';
import type { CatsLogMemoryBackend } from '../src/utils/catslog-memory-provider';

const context = {
  workingDirectory: '/tmp/xiaoba-catslog-memory-test',
  conversationHistory: [],
};

class FakeCatsLogMemory implements CatsLogMemoryBackend {
  branchQueries: CatscoBranchQuery[] = [];
  branchResponse: CatscoBranchResponse = {
    schema_version: 1,
    content_trust: 'untrusted_branch_evidence',
    request_id: 'req-1',
    status: 'ok',
    branches: [
      {
        source: 'memory',
        status: 'ok',
        elapsed_ms: 12,
        items: [
          {
            source: 'session',
            ref: 'stream-review#12',
            kind: 'session_turn',
            text: 'rollback decision: keep nginx read-only mount',
            score_hint: 0.87,
          },
          {
            source: 'skill',
            ref: 'catslog:skill:release-playbook@3',
            kind: 'skill',
            score_hint: 0.9,
          },
          { source: 'session', ref: 'https://evil.example.test/log#1', kind: 'session_turn' },
        ],
      },
      { source: 'graph', status: 'timeout' },
    ],
  };

  async branch(query: CatscoBranchQuery): Promise<CatscoBranchResponse> {
    this.branchQueries.push(query);
    return this.branchResponse;
  }
}

describe('CatsLog branch memory tools', () => {
  test('describes the single fused remote retrieval probe', () => {
    const description = new CatsLogBranchTool(new FakeCatsLogMemory()).definition.description;
    assert.match(description, /跨会话、跨 scope 召回/);
    assert.match(description, /唯一的远端检索工具/);
    assert.match(description, /最多只做一次收窄重试/);
  });

  test('fans out a branch query and projects TypedEvidence without unsafe refs', async () => {
    const backend = new FakeCatsLogMemory();
    const tool = new CatsLogBranchTool(backend);
    const result = await tool.execute({
      query_text: 'nginx upload mount rollback',
      sources: ['memory', 'skill', 'memory'],
      session_type: 'cli',
      tags: ['deploy'],
      per_branch_max_items: 10,
      total_deadline_ms: 4_000,
      principal_id: 'must-be-ignored',
    }, context);

    assert.equal(result.ok, true);
    assert.deepEqual(backend.branchQueries, [{
      queryText: 'nginx upload mount rollback',
      sources: ['memory', 'skill'],
      scopeHints: { sessionType: 'cli', tags: ['deploy'] },
      budgets: { perBranchMaxItems: 10, totalDeadlineMs: 4_000 },
    }]);
    const payload = JSON.parse(String(result.content));
    assert.equal(payload.content_trust, 'untrusted_branch_evidence');
    assert.equal(payload.request_id, 'req-1');
    assert.equal(payload.branches.length, 2);
    const memoryBranch = payload.branches[0];
    assert.equal(memoryBranch.source, 'memory');
    assert.equal(memoryBranch.elapsed_ms, 12);
    assert.equal(memoryBranch.items[0].ref, 'stream-review#12');
    assert.equal(memoryBranch.items[0].kind, 'session_turn');
    assert.equal(memoryBranch.items[0].score_hint, 0.87);
    assert.equal(memoryBranch.items[1].ref, 'catslog:skill:release-playbook@3');
    assert.match(memoryBranch.items[2].ref, /^catslog:ref:[a-f0-9]{24}$/);
    assert.equal(JSON.stringify(payload).includes('evil.example.test'), false);
    assert.equal(payload.branches[1].status, 'timeout');
  });

  test('rejects branch calls without a query or scope hint and unsafe budgets', async () => {
    const backend = new FakeCatsLogMemory();
    const tool = new CatsLogBranchTool(backend);

    const empty = await tool.execute({}, context);
    assert.equal(empty.ok, false);

    const badBudget = await tool.execute({ query_text: 'x', total_deadline_ms: 0 }, context);
    assert.equal(badBudget.ok, false);

    const unsafeSource = await tool.execute({ query_text: 'x', sources: ['../etc'] }, context);
    assert.equal(unsafeSource.ok, false);

    const tooManyTags = await tool.execute({
      query_text: 'x',
      tags: Array.from({ length: 9 }, (_, index) => `tag-${index}`),
    }, context);
    assert.equal(tooManyTags.ok, false);

    assert.equal(backend.branchQueries.length, 0);
  });

  test('bounds an oversized branch fan-out by dropping nested item tails', async () => {
    const backend = new FakeCatsLogMemory();
    backend.branchResponse = {
      content_trust: 'untrusted_branch_evidence',
      branches: [{
        source: 'memory',
        status: 'ok',
        items: Array.from({ length: 120 }, (_, index) => ({
          source: 'session',
          ref: `stream-x#${index + 1}`,
          kind: 'session_turn',
          text: `evidence ${index} `,
          score_hint: index / 120,
        })),
      }],
    };
    const result = await new CatsLogBranchTool(backend).execute({ query_text: 'x' }, context);
    assert.equal(result.ok, true);
    const encoded = String(result.content);
    assert.ok(encoded.length <= 60_000, `branch result exceeds cap: ${encoded.length}`);
    const payload = JSON.parse(encoded);
    assert.ok(payload.branches[0].items.length > 0 && payload.branches[0].items.length < 120);
  });

  test('finish accepts generated CatsLog citations but still rejects arbitrary refs', async () => {
    let captured: any;
    const tool = new FinishMemorySearchTool(payload => {
      captured = payload;
    });

    const valid = await tool.execute({
      summary: 'Remote skill and session evidence are relevant.',
      refs: ['catslog:skill:release-playbook@3', 'stream-release#17'],
    }, context);
    assert.equal(valid.ok, true);
    assert.deepEqual(captured.refs, ['catslog:skill:release-playbook@3', 'stream-release#17']);

    const invalid = await tool.execute({
      summary: 'bad',
      refs: ['https://evil.example.test/#1'],
    }, context);
    assert.equal(invalid.ok, false);
  });
});
