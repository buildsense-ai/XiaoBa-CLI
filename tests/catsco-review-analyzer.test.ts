import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { analyzeReviewData, classifyReviewText } from '../src/utils/catsco-review-analyzer';
import type { ReviewData } from '../src/utils/catsco-review-agent-client';

describe('catsco review analyzer', () => {
  test('classifies common review failure text', () => {
    assert.equal(classifyReviewText('HTTP 401 unauthorized token missing'), 'permission_or_auth');
    assert.equal(classifyReviewText('unknown tool: image_editor'), 'missing_skill_or_tool');
    assert.equal(classifyReviewText('tool failed with traceback'), 'tool_failure');
    assert.equal(classifyReviewText('用户反复澄清，Agent 没理解'), 'prompt_confusion');
    assert.equal(classifyReviewText('connection timeout'), 'network_or_timeout');
    assert.equal(classifyReviewText('token usage is high'), 'general_failure');
    assert.equal(classifyReviewText('review_fetch_error: could not fetch session entries'), 'review_data_quality');
  });

  test('finds failures, latency, prompt confusion, and token usage', () => {
    const data: ReviewData = {
      summary: {
        upload_count: 1,
        parsed_upload_count: 1,
        failed_upload_count: 0,
        session_count: 1,
        turn_count: 1,
        ai_call_count: 1,
        tool_call_count: 1,
        prompt_tokens: 9000,
        completion_tokens: 4000,
        total_tokens: 13000,
      },
      failures: [
        {
          failure_type: 'log_entry',
          upload_id: 'upload-1',
          session_record_id: 'session-1',
          event_category: 'tool',
          message: 'tool failed because permission denied',
        },
      ],
      sessions: [
        {
          session_record_id: 'session-1',
          upload_id: 'upload-1',
          user_key: 'user',
          device_key: 'device',
          session_key: 'session',
          session_type: 'cli',
          entry_count: 1,
          runtime_count: 0,
          turn_count: 1,
          ai_call_count: 1,
          tool_call_count: 1,
          prompt_tokens: 9000,
          completion_tokens: 4000,
          total_tokens: 13000,
          summary_status: 'pending',
          created_at: '2026-05-20 00:00:00',
        },
      ],
      sessionEntries: {
        'session-1': [
          {
            entry_id: 'entry-1',
            line_no: 1,
            entry_type: 'runtime',
            level: 'warning',
            message: 'timeout while calling tool',
            event_category: 'tool',
            duration_ms: 20000,
          },
        ],
      },
      sessionTurns: {
        'session-1': [
          {
            turn_record_id: 'turn-1',
            turn_no: 1,
            user_text: '这个需求不清楚吗',
            assistant_text: '我需要澄清一下',
          },
        ],
      },
    };

    const findings = analyzeReviewData(data);
    const categories = findings.map(finding => finding.category);
    assert.ok(categories.includes('permission_or_auth'));
    assert.ok(categories.includes('network_or_timeout'));
    assert.ok(categories.includes('latency'));
    assert.ok(categories.includes('prompt_confusion'));
    assert.ok(categories.includes('token_usage'));
  });

  test('groups repeated failures by normalized pattern and ranks by impact', () => {
    const data: ReviewData = {
      summary: {
        upload_count: 2,
        parsed_upload_count: 2,
        failed_upload_count: 0,
        session_count: 2,
        turn_count: 0,
        ai_call_count: 0,
        tool_call_count: 2,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
      failures: [
        {
          failure_type: 'log_entry',
          upload_id: 'upload-1',
          session_record_id: 'session-1',
          event_category: 'tool_result',
          message: 'tool failed with HTTP 500 for request 12345',
        },
        {
          failure_type: 'log_entry',
          upload_id: 'upload-2',
          session_record_id: 'session-2',
          event_category: 'tool_result',
          message: 'tool failed with HTTP 500 for request 67890',
        },
      ],
      sessions: [],
      sessionEntries: {},
      sessionTurns: {},
    };

    const findings = analyzeReviewData(data);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].count, 2);
    assert.deepEqual(findings[0].affectedSessions, ['session-1', 'session-2']);
    assert.match(findings[0].patternKey || '', /<num>/);
    assert.equal(findings[0].proposalType, 'tool');
    assert.ok((findings[0].impactScore || 0) > findings[0].count);
  });
});
