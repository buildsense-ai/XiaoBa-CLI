import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  answerReviewQuestion,
  buildReviewQuestionEvidencePack,
} from '../src/utils/catsco-review-question-answerer';
import { analyzeReviewData } from '../src/utils/catsco-review-analyzer';
import { analyzeUsageData } from '../src/utils/catsco-review-usage-analyzer';
import type { ReviewData } from '../src/utils/catsco-review-agent-client';

describe('catsco review question answerer', () => {
  test('builds a flexible evidence pack from review data and redacts sensitive text', () => {
    const data = reviewDataFixture();
    const context = {
      reviewData: data,
      findings: analyzeReviewData(data),
      usageAnalysis: analyzeUsageData(data),
    };

    const pack = buildReviewQuestionEvidencePack('这个老师主要问了什么，使用频率如何？', context, {
      maxEvidenceItems: 20,
    });

    assert.equal(pack.summary.sessions, 1);
    assert.equal(pack.summary.bots, 1);
    assert.equal(pack.summary.people, 1);
    assert.equal(pack.summary.actors, 1);
    assert.ok(pack.evidence.some(item => item.kind === 'usage'));
    assert.ok(pack.evidence.some(item => item.kind === 'turn'));
    const serialized = JSON.stringify(pack);
    assert.match(serialized, /成绩/);
    assert.match(serialized, /actor-teacher/);
    assert.match(serialized, /person-teacher/);
    assert.match(serialized, /bot-school/);
    assert.doesNotMatch(serialized, /13812345678/);
    assert.doesNotMatch(serialized, /110101199003071234/);
    assert.doesNotMatch(serialized, /actor-external-raw/);
    assert.doesNotMatch(serialized, /张三/);
    assert.doesNotMatch(serialized, /Dirty Work/);
    assert.match(serialized, /\[PHONE_REDACTED\]/);
    assert.match(serialized, /\[ID_REDACTED\]/);
    assert.match(serialized, /\[STUDENT_REDACTED\]/);
    assert.match(serialized, /\[PATH_REDACTED\]/);
    assert.equal(pack.summary.possibly_truncated, false);

    const cappedPack = buildReviewQuestionEvidencePack('这个老师主要问了什么，使用频率如何？', context, {
      maxEvidenceItems: 2,
    });
    assert.equal(cappedPack.summary.possibly_truncated, true);
    assert.equal(cappedPack.summary.selected_evidence_items, 2);
  });

  test('asks the model with review evidence only', async () => {
    const data = reviewDataFixture();
    let capturedContent = '';
    const aiService = {
      chat: async (messages: any[]) => {
        capturedContent = messages.map(message => String(message.content)).join('\n');
        return { content: '基于日志：该老师主要询问成绩统计。' };
      },
    } as any;

    const answer = await answerReviewQuestion('老师主要用 Agent 做什么？', {
      reviewData: data,
      findings: analyzeReviewData(data),
      usageAnalysis: analyzeUsageData(data),
    }, aiService, {
      conversationHistory: [{
        question: '先看这个老师的使用频率',
        answer: '上一轮看到有 1 个 session。',
      }],
    });

    assert.match(answer, /成绩统计/);
    assert.match(capturedContent, /Evidence/);
    assert.match(capturedContent, /\/catsco\/review\/\*/);
    assert.match(capturedContent, /对话上下文/);
  });

  test('keeps arbitrary Chinese business terms searchable without fixed report topics', () => {
    const data = reviewDataFixture();
    const pack = buildReviewQuestionEvidencePack('有没有奖学金名单相关记录？', {
      reviewData: data,
      findings: analyzeReviewData(data),
      usageAnalysis: analyzeUsageData(data),
    }, {
      maxEvidenceItems: 3,
    });

    assert.ok(pack.evidence.some(item => item.text.includes('奖学金名单')));
  });
});

function reviewDataFixture(): ReviewData {
  return {
    summary: {
      uploaded_from: '2026-05-20T00:00:00Z',
      uploaded_to: '2026-05-21T00:00:00Z',
      upload_count: 1,
      parsed_upload_count: 1,
      failed_upload_count: 0,
      session_count: 1,
      turn_count: 2,
      ai_call_count: 1,
      tool_call_count: 1,
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    },
    failures: [],
    sessions: [{
      session_record_id: 'session-1',
      upload_id: 'upload-1',
      user_key: 'teacher-key',
      device_key: 'device-key',
      bot_key: 'bot-school',
      person_key: 'person-teacher',
      actor_key: 'actor-teacher',
      actor_weixin_user_key: 'actor-weixin-teacher',
      session_key: 'session-key',
      session_type: 'chat',
      started_at: '2026-05-20 08:00:00',
      entry_count: 1,
      runtime_count: 1,
      turn_count: 2,
      ai_call_count: 1,
      tool_call_count: 1,
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      summary_status: 'ready',
      created_at: '2026-05-20 08:00:00',
    }],
    sessionEntries: {
      'session-1': [{
        entry_id: 'entry-1',
        line_no: 1,
        entry_type: 'tool_call',
        event_category: 'tool',
        tool_name: 'read_file',
        message: 'tool succeeded actor_external_user_id=actor-external-raw',
      }],
    },
    sessionTurns: {
      'session-1': [{
        turn_record_id: 'turn-1',
        turn_no: 1,
        timestamp: '2026-05-20 08:00:00',
        bot_key: 'bot-school',
        person_key: 'person-teacher',
        actor_key: 'actor-teacher',
        actor_weixin_user_key: 'actor-weixin-teacher',
        user_text: '帮我统计张三同学考试成绩，手机号 13812345678，身份证 110101199003071234，路径 E:\\Dirty Work\\XiaoBa-CLI\\成绩.xlsx actor_external_user_id=actor-external-raw',
        assistant_text: '我可以帮你整理成绩统计表。',
      }, {
        turn_record_id: 'turn-2',
        turn_no: 2,
        timestamp: '2026-05-20 08:10:00',
        bot_key: 'bot-school',
        person_key: 'person-teacher',
        actor_key: 'actor-teacher',
        user_text: '帮我整理奖学金名单公示材料',
        assistant_text: '可以，我会帮你按公示格式整理。',
      }],
    },
  };
}
