import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { CatsLogObservedRefsTracker } from '../src/core/catslog-skill-evidence';

describe('CatsLogObservedRefsTracker', () => {
  test('collects citation-shaped refs from projected tool results only', () => {
    const tracker = new CatsLogObservedRefsTracker();
    tracker.recordToolResult('catslog_branch', JSON.stringify({
      content_trust: 'untrusted_branch_evidence',
      branches: [
        {
          source: 'memory',
          status: 'ok',
          items: [
            { source: 'session', ref: 'stream-review#12', kind: 'session_turn', score_hint: 0.4 },
            { source: 'skill', ref: 'catslog:skill:review-checklist@2', kind: 'skill', score_hint: 0.9 },
            { source: 'session', ref: 'https://evil.example.test/log#1', text: 'ignored unsafe item' },
            'not-an-object',
          ],
        },
        { source: 'graph', status: 'timeout', items: [{ ref: 'stream-review#12', score_hint: 0.6 }] },
      ],
    }));
    tracker.recordToolResult('catslog_sessions', JSON.stringify({
      content_trust: 'untrusted_log_data',
      records: [
        { ref: 'chat/2026-01-01/session.jsonl#42', session_type: 'chat' },
        { ref: 'stream-legacy#7', session_type: 'cli' },
      ],
    }));
    tracker.recordToolResult('catslog_branch', 'not-json-at-all');
    tracker.recordToolResult('finish_memory_search', JSON.stringify({ ok: true }));

    assert.deepEqual(tracker.unobservedRefs(['stream-review#12', 'chat/2026-01-01/session.jsonl#42']), []);
    assert.deepEqual(tracker.unobservedRefs(['stream-fabricated#99']), ['stream-fabricated#99']);
    // Unsafe refs are never recorded as observed evidence.
    assert.deepEqual(tracker.unobservedRefs(['https://evil.example.test/log#1']), ['https://evil.example.test/log#1']);
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.schema, 'catslog.branch.observed-refs.v1');
    assert.equal(snapshot.observedRefs.length, 4);
    assert.equal(JSON.stringify(snapshot).includes('untrusted branch evidence'), false);
  });
});
