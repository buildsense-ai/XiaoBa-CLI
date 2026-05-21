import { describe, test, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReviewLogsQueryTool } from '../src/tools/review-logs-query-tool';

const originalFetch = globalThis.fetch;

describe('review_logs_query tool', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('answers from the Review API inside the normal tool surface', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-review-tool-'));
    try {
      fs.writeFileSync(path.join(root, '.env'), [
        'CATSCO_REVIEW_API_BASE_URL=http://127.0.0.1:18080',
        'CATSCO_REVIEW_TOKEN=review-token',
        'CATSCO_REVIEW_LOOKBACK_HOURS=168',
        '',
      ].join('\n'), 'utf-8');

      let summaryCalled = false;
      let promptText = '';
      const capturedParams: Record<string, string | null> = {};
      globalThis.fetch = (async (input: any) => {
        const url = new URL(String(input));
        if (url.pathname === '/catsco/review/summary') {
          summaryCalled = true;
          capturedParams.summaryUserId = url.searchParams.get('user_id');
          capturedParams.summaryOrgType = url.searchParams.get('org_type');
          return jsonResponse({
            upload_count: 1,
            parsed_upload_count: 1,
            failed_upload_count: 0,
            session_count: 1,
            turn_count: 1,
            ai_call_count: 1,
            tool_call_count: 0,
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          });
        }
        if (url.pathname === '/catsco/review/failures') {
          return jsonResponse({ page: { limit: 100, offset: 0, count: 0, has_more: false }, failures: [] });
        }
        if (url.pathname === '/catsco/review/sessions') {
          capturedParams.sessionsUserId = url.searchParams.get('user_id');
          capturedParams.sessionsOrgType = url.searchParams.get('org_type');
          return jsonResponse({
            page: { limit: 100, offset: 0, count: 1, has_more: false },
            sessions: [sessionFixture()],
          });
        }
        if (url.pathname === '/catsco/review/turns') {
          capturedParams.turnsUserId = url.searchParams.get('user_id');
          capturedParams.turnsOrgType = url.searchParams.get('org_type');
          return jsonResponse({
            page: { limit: 100, offset: 0, count: 1, has_more: false },
            turns: [{
              session_record_id: 'session-1',
              turn_record_id: 'turn-1',
              turn_no: 1,
              user_key: 'teacher-key',
              device_key: 'device-key',
              session_key: 'session-key',
              org_type: 'school',
              user_role: 'teacher',
              channel_type: 'desktop',
              user_text: '老师问奖学金名单怎么整理 user_id=catsco_116',
              assistant_text: '可以按公示格式整理。',
            }],
          });
        }
        if (url.pathname.endsWith('/entries')) {
          return jsonResponse({ page: { limit: 100, offset: 0, count: 0, has_more: false }, entries: [] });
        }
        if (url.pathname.endsWith('/turns')) {
          return jsonResponse({
            page: { limit: 100, offset: 0, count: 1, has_more: false },
            turns: [{
              turn_record_id: 'turn-1',
              turn_no: 1,
              user_text: '老师问奖学金名单怎么整理',
              assistant_text: '可以按公示格式整理。',
            }],
          });
        }
        return jsonResponse({ detail: 'not found' }, 404);
      }) as any;

      const tool = new ReviewLogsQueryTool();
      const result = await tool.execute({
        question: '老师主要问了什么？',
        user_id: 'catsco_116',
        org_type: 'school',
        max_evidence_items: 5,
        max_target_turns: 100,
      }, {
        workingDirectory: root,
        conversationHistory: [],
        runtimeServices: {
          aiService: {
            chat: async (messages: any[]) => {
              promptText = messages.map(message => String(message.content)).join('\n');
              return ({
              content: promptText.includes('奖学金名单')
                ? '基于日志：老师询问奖学金名单整理。'
                : '没有证据',
              });
            },
          },
          skillManager: {} as any,
        },
      });

      assert.equal(result.ok, true);
      assert.match(String(result.content), /奖学金名单/);
      assert.equal(summaryCalled, true);
      assert.equal(capturedParams.summaryUserId, 'catsco_116');
      assert.equal(capturedParams.sessionsUserId, 'catsco_116');
      assert.equal(capturedParams.turnsUserId, 'catsco_116');
      assert.equal(capturedParams.summaryOrgType, 'school');
      assert.equal(capturedParams.sessionsOrgType, 'school');
      assert.equal(capturedParams.turnsOrgType, 'school');
      assert.doesNotMatch(promptText, /catsco_116/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function sessionFixture() {
  return {
    session_record_id: 'session-1',
    upload_id: 'upload-1',
    user_key: 'teacher-key',
    device_key: 'device-key',
    session_key: 'session-key',
    session_type: 'chat',
    entry_count: 0,
    runtime_count: 0,
    turn_count: 1,
    ai_call_count: 1,
    tool_call_count: 0,
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    summary_status: 'ready',
    created_at: '2026-05-20T00:00:00Z',
  };
}
