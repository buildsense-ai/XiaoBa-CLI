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
      globalThis.fetch = (async (input: any) => {
        const url = new URL(String(input));
        if (url.pathname === '/catsco/review/summary') {
          summaryCalled = true;
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
          return jsonResponse({
            page: { limit: 100, offset: 0, count: 1, has_more: false },
            sessions: [sessionFixture()],
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
        max_evidence_items: 5,
      }, {
        workingDirectory: root,
        conversationHistory: [],
        runtimeServices: {
          aiService: {
            chat: async (messages: any[]) => ({
              content: messages.map(message => String(message.content)).join('\n').includes('奖学金名单')
                ? '基于日志：老师询问奖学金名单整理。'
                : '没有证据',
            }),
          },
          skillManager: {} as any,
        },
      });

      assert.equal(result.ok, true);
      assert.match(String(result.content), /奖学金名单/);
      assert.equal(summaryCalled, true);
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
