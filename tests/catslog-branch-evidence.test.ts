import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  boundToolResultJson,
  normalizeEvidenceVerdict,
  projectBranchResponse,
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
