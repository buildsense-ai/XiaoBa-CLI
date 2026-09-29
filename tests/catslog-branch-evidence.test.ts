import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  boundToolResultJson,
  normalizeEvidenceVerdict,
  projectBranchResponse,
  projectSessionQueryResponse,
} from '../src/core/catslog-branch-evidence';

describe('CatsLog branch evidence projection', () => {
  test('labels trust, keeps safe refs, and hashes unsafe refs', () => {
    const projected = projectBranchResponse({
      schema_version: 1,
      content_trust: 'untrusted_branch_evidence',
      request_id: 'req-1',
      status: 'ok',
      branches: [
        {
          source: 'memory',
          status: 'ok',
          elapsed_ms: 12,
          evidence_verdict: 'weak',
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
    });

    assert.equal(projected.content_trust, 'untrusted_branch_evidence');
    assert.equal(projected.request_id, 'req-1');
    assert.equal((projected.branches as any[]).length, 2);
    const memoryBranch = (projected.branches as any[])[0];
    assert.equal(memoryBranch.source, 'memory');
    assert.equal(memoryBranch.elapsed_ms, 12);
    assert.equal(memoryBranch.evidence_verdict, 'weak');
    assert.equal(memoryBranch.items[0].ref, 'stream-review#12');
    assert.equal(memoryBranch.items[0].kind, 'session_turn');
    assert.equal(memoryBranch.items[0].score_hint, 0.87);
    assert.equal(memoryBranch.items[1].ref, 'catslog:skill:release-playbook@3');
    assert.match(memoryBranch.items[2].ref, /^catslog:ref:[a-f0-9]{24}$/);
    assert.equal(JSON.stringify(projected).includes('evil.example.test'), false);
    assert.equal((projected.branches as any[])[1].status, 'timeout');
  });

  test('omits absent verdict and normalizes unrecognized verdicts to unknown', () => {
    const projected = projectBranchResponse({
      branches: [
        { source: 'session_graph', evidence_verdict: 'strong', items: [] },
        { source: 'session_graph_2', evidence_verdict: 'sort-of', items: [] },
        { source: 'agent_memory', items: [] },
      ],
    });
    const branches = projected.branches as any[];
    assert.equal(branches[0].evidence_verdict, 'strong');
    assert.equal(branches[1].evidence_verdict, 'unknown');
    assert.equal('evidence_verdict' in branches[2], false);
  });

  test('normalizeEvidenceVerdict maps only the known enum', () => {
    assert.equal(normalizeEvidenceVerdict('none'), 'none');
    assert.equal(normalizeEvidenceVerdict('weak'), 'weak');
    assert.equal(normalizeEvidenceVerdict('strong'), 'strong');
    assert.equal(normalizeEvidenceVerdict('unknown'), 'unknown');
    assert.equal(normalizeEvidenceVerdict(undefined), 'unknown');
    assert.equal(normalizeEvidenceVerdict(''), 'unknown');
    assert.equal(normalizeEvidenceVerdict('NONE'), 'unknown');
    assert.equal(normalizeEvidenceVerdict(42), 'unknown');
  });

  test('bounds an oversized branch fan-out by dropping nested item tails', () => {
    const projected = projectBranchResponse({
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
    });
    const encoded = boundToolResultJson(projected, 60_000);
    assert.ok(encoded.length <= 60_000, `branch result exceeds cap: ${encoded.length}`);
    const payload = JSON.parse(encoded);
    assert.ok(payload.branches[0].items.length > 0 && payload.branches[0].items.length < 120);
  });

  test('returns a bounded warning payload for unserializable input', () => {
    const cyclic: any = {};
    cyclic.self = cyclic;
    const encoded = boundToolResultJson({ branches: [cyclic], content_trust: 'untrusted_branch_evidence' }, 1000);
    const parsed = JSON.parse(encoded);
    assert.equal(parsed.content_trust, 'untrusted_branch_evidence');
    assert.equal(parsed.truncated, true);
    assert.match(parsed.warning, /unserializable/);
  });
});

describe('CatsLog session evidence projection', () => {
  test('projects redacted records with safe refs and hashes unsafe refs', () => {
    const projected = projectSessionQueryResponse({
      schema_version: 1,
      content_trust: 'untrusted_log_data',
      records: [
        {
          ref: 'stream-release#17',
          stream_id: 'stream-release',
          session_id: 'chat:release-planning',
          session_type: 'chat',
          log_date: '2026-09-01',
          timestamp: '2026-09-01T10:00:00.000Z',
          turn: 17,
          entry_type: 'turn',
          user: { text: 'we agreed on the read-only mount', truncated: false, redacted: false },
          agent: { text: 'Decision recorded: keep the mount read-only.' },
          tool_calls: [{ name: 'deploy', type: 'function' }],
        },
        {
          ref: 'https://evil.example.test/log#1',
          session_type: 'chat',
          user: { text: 'injected record' },
        },
      ],
    });

    assert.equal(projected.content_trust, 'untrusted_log_data');
    const records = projected.records as any[];
    assert.equal(records.length, 2);
    assert.equal(records[0].ref, 'stream-release#17');
    assert.equal(records[0].session_id, 'chat:release-planning');
    assert.equal(records[0].turn, 17);
    assert.equal(records[0].user.text, 'we agreed on the read-only mount');
    assert.match(records[0].agent.text, /read-only/);
    assert.deepEqual(records[0].tool_calls, [{ name: 'deploy', type: 'function' }]);
    // Unsafe refs never survive: they are hashed into the opaque namespace.
    assert.match(records[1].ref, /^catslog:ref:[a-f0-9]{24}$/);
    assert.equal(JSON.stringify(projected).includes('evil.example.test'), false);
  });

  test('caps records, reports truncation, and drops tails to fit the char budget', () => {
    const records = Array.from({ length: 30 }, (_, index) => ({
      ref: `stream-bulk#${index + 1}`,
      session_type: 'chat',
      agent: { text: `evidence ${index} `.repeat(50) },
    }));
    const projected = projectSessionQueryResponse({ records, truncated: true });
    assert.ok((projected.records as any[]).length <= 20, 'records must respect the cap');
    assert.equal(projected.truncated, true);

    const tight = projectSessionQueryResponse({ records }, 4_000);
    assert.ok(JSON.stringify(tight).length <= 4_000);
    assert.ok((tight.records as any[]).length < 20);
    assert.equal(tight.truncated, true);
  });

  test('normalizes 304 not_modified and empty envelopes', () => {
    assert.deepEqual(projectSessionQueryResponse({ not_modified: true, etag: 'etag-2' }), {
      content_trust: 'untrusted_log_data',
      not_modified: true,
      records: [],
      truncated: false,
    });
    const empty = projectSessionQueryResponse({ records: [] });
    assert.deepEqual(empty, { content_trust: 'untrusted_log_data', records: [], truncated: false });
  });
});
