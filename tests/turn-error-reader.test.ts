import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readTurnErrorReport } from '../src/observability/turn-error-reader';

describe('turn error reader', () => {
  let root = '';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-turn-errors-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('aggregates only final turn interruptions and tolerates malformed JSONL lines', () => {
    const logDir = path.join(root, 'catscompany', '2026-08-02');
    fs.mkdirSync(logDir, { recursive: true });
    const filePath = path.join(logDir, 'session.jsonl');
    const entries = [
      runtimeEntry('2026-08-02T10:00:00.000Z', {
        category: 'provider_rejected',
        error_code: 'provider_rejected_400',
        classification_confidence: 'low',
        phase: 'model_request',
        error_origin: 'provider',
        recovery_action: 'retry_later',
        model: 'deepseek-v4-flash',
        provider: 'openai',
        http_status: 400,
        error_fingerprint: 'fingerprint400',
        stack_fingerprint: 'stack400',
        top_frame: 'src/providers/openai-provider.ts:123:4',
        error_summary: 'Request failed with status code 400',
        attempt_count: 3,
        retry_count: 2,
        retry_stop_reason: 'retry_limit_exhausted',
        partial_progress_preserved: true,
        episode_id: 'episode-reader',
        model_call_id: 'call-reader',
        model_attempt_id: 'call-reader:3',
        model_attempt_number: 3,
      }),
      runtimeEntry('2026-08-02T11:00:00.000Z', {
        category: 'provider_rejected',
        error_code: 'provider_rejected_400',
        classification_confidence: 'low',
        phase: 'model_request',
        error_origin: 'provider',
        recovery_action: 'retry_later',
        model: 'deepseek-v4-flash',
        provider: 'openai',
        http_status: 400,
        error_fingerprint: 'fingerprint400',
        stack_fingerprint: 'stack400',
        top_frame: 'src/providers/openai-provider.ts:123:4',
        error_summary: 'Request failed with status code 400',
      }),
      JSON.stringify({
        entry_type: 'runtime',
        timestamp: '2026-08-02T12:00:00.000Z',
        event: { type: 'model_retry', payload: { category: 'transient' } },
      }),
      '{"entry_type":"runtime","event":{"type":"turn_error"},broken',
      runtimeEntry('2026-06-01T10:00:00.000Z', {
        category: 'unexpected',
        error_code: 'old_error',
      }),
    ];
    fs.writeFileSync(filePath, `${entries.join('\n')}\n`);

    const report = readTurnErrorReport({
      logsRoot: root,
      days: 7,
      limit: 2,
      now: new Date('2026-08-03T00:00:00.000Z'),
    });

    assert.equal(report.totals.interruptions, 2);
    assert.equal(report.totals.needs_investigation, 2);
    assert.equal(report.totals.retried_before_interrupt, 1);
    assert.equal(report.totals.partial_progress_preserved, 1);
    assert.equal(report.totals.files_scanned, 1);
    assert.equal(report.totals.malformed_lines, 1);
    assert.deepStrictEqual(report.by_category[0], {
      key: 'provider_rejected',
      count: 2,
      latest_at: '2026-08-02T11:00:00.000Z',
    });
    assert.equal(report.by_fingerprint[0].key, 'fingerprint400');
    assert.equal(report.by_fingerprint[0].count, 2);
    assert.equal(report.by_origin[0].key, 'provider');
    assert.equal(report.by_top_frame[0].key, 'src/providers/openai-provider.ts:123:4');
    assert.equal(report.recent.length, 2);
    assert.equal(report.recent[0].source_line, 2);
    assert.equal(report.recent[0].model_attempt_id, '');
    assert.equal(report.recent[0].model_attempt_number, 0);
    assert.equal(report.recent[1].model_call_id, 'call-reader');
    assert.equal(report.recent[1].model_attempt_id, 'call-reader:3');
    assert.equal(report.recent[1].model_attempt_number, 3);
    assert.equal(report.recent[1].episode_id, 'episode-reader');
  });

  test('returns an empty report when the log root does not exist', () => {
    const report = readTurnErrorReport({ logsRoot: path.join(root, 'missing') });
    assert.equal(report.totals.interruptions, 0);
    assert.deepStrictEqual(report.recent, []);
  });

  test('flags legacy status-only classifications as needing investigation', () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'legacy.jsonl'), `${runtimeEntry(
      '2026-08-02T10:00:00.000Z',
      {
        category: 'request_invalid',
        error_code: 'request_invalid',
        http_status: 400,
        error_summary: 'Request failed with status code 400',
      },
    )}\n`);

    const report = readTurnErrorReport({
      logsRoot: root,
      days: 7,
      now: new Date('2026-08-03T00:00:00.000Z'),
    });

    assert.equal(report.totals.interruptions, 1);
    assert.equal(report.totals.needs_investigation, 1);
  });
});

function runtimeEntry(timestamp: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    entry_type: 'runtime',
    timestamp,
    session_id: 'cc_group:grp_1',
    session_type: 'catscompany',
    level: 'ERROR',
    message: 'interrupted',
    event: { type: 'turn_error', payload },
  });
}
