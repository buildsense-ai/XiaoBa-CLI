import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { analyzeUsageData, classifyUsageTopic } from '../src/utils/catsco-review-usage-analyzer';
import type { ReviewData } from '../src/utils/catsco-review-agent-client';

describe('catsco review usage analyzer', () => {
  test('classifies education office usage topics', () => {
    assert.equal(classifyUsageTopic('帮我统计本次考试成绩'), 'grades_or_exams');
    assert.equal(classifyUsageTopic('把这个课表整理一下'), 'course_schedule');
    assert.equal(classifyUsageTopic('写一条教务处通知'), 'notices_or_messages');
    assert.equal(classifyUsageTopic('汇总 Excel 表格数据'), 'spreadsheets_or_data');
  });

  test('summarizes frequency, topics, tools, and time without raw question text', () => {
    const data: ReviewData = {
      summary: {
        uploaded_from: '2026-05-20T00:00:00Z',
        uploaded_to: '2026-05-21T00:00:00Z',
        upload_count: 1,
        parsed_upload_count: 1,
        failed_upload_count: 0,
        session_count: 2,
        turn_count: 3,
        ai_call_count: 3,
        tool_call_count: 2,
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      },
      failures: [],
      sessions: [
        {
          session_record_id: 'session-1',
          upload_id: 'upload-1',
          user_key: 'teacher-a',
          device_key: 'device-a',
          bot_key: 'bot-school',
          person_key: 'person-teacher-a',
          actor_key: 'actor-teacher-a',
          session_key: 'session-a',
          session_type: 'chat',
          started_at: '2026-05-20 08:00:00',
          entry_count: 1,
          runtime_count: 1,
          turn_count: 2,
          ai_call_count: 2,
          tool_call_count: 1,
          prompt_tokens: 80,
          completion_tokens: 40,
          total_tokens: 120,
          summary_status: 'ready',
          created_at: '2026-05-20 08:00:00',
        },
        {
          session_record_id: 'session-2',
          upload_id: 'upload-1',
          user_key: 'teacher-a',
          device_key: 'device-a',
          bot_key: 'bot-school',
          person_key: 'person-teacher-a',
          actor_key: 'actor-teacher-a',
          session_key: 'session-b',
          session_type: 'chat',
          started_at: '2026-05-21 09:00:00',
          entry_count: 1,
          runtime_count: 1,
          turn_count: 1,
          ai_call_count: 1,
          tool_call_count: 1,
          prompt_tokens: 20,
          completion_tokens: 10,
          total_tokens: 30,
          summary_status: 'ready',
          created_at: '2026-05-21 09:00:00',
        },
      ],
      sessionEntries: {
        'session-1': [{
          entry_id: 'entry-1',
          line_no: 1,
          entry_type: 'tool_call',
          event_category: 'tool',
          tool_name: 'read_file',
        }],
        'session-2': [{
          entry_id: 'entry-2',
          line_no: 1,
          entry_type: 'tool_call',
          event_category: 'tool',
          tool_name: 'write_file',
        }],
      },
      sessionTurns: {
        'session-1': [
          {
            turn_record_id: 'turn-1',
            turn_no: 1,
            timestamp: '2026-05-20 08:00:00',
            bot_key: 'bot-school',
            person_key: 'person-teacher-a',
            actor_key: 'actor-teacher-a',
            user_text: '帮我统计张三同学考试成绩',
          },
          {
            turn_record_id: 'turn-2',
            turn_no: 2,
            timestamp: '2026-05-20 08:10:00',
            bot_key: 'bot-school',
            person_key: 'person-teacher-a',
            actor_key: 'actor-teacher-a',
            user_text: '写一条教务处通知',
          },
        ],
        'session-2': [{
          turn_record_id: 'turn-3',
          turn_no: 1,
          timestamp: '2026-05-21 09:00:00',
          bot_key: 'bot-school',
          person_key: 'person-teacher-a',
          actor_key: 'actor-teacher-a',
          user_text: '整理 Excel 表格数据',
        }],
      },
    };

    const usage = analyzeUsageData(data, {
      targetUserKey: 'teacher-a',
      targetBotKey: 'bot-school',
      targetPersonKey: 'person-teacher-a',
      targetActorKey: 'actor-teacher-a',
    });
    assert.equal(usage.totals.userCount, 1);
    assert.equal(usage.totals.botCount, 1);
    assert.equal(usage.totals.personCount, 1);
    assert.equal(usage.totals.actorCount, 1);
    assert.equal(usage.totals.sessionCount, 2);
    assert.equal(usage.totals.activeDays, 2);
    assert.equal(usage.totals.turnCount, 3);
    assert.equal(usage.users[0].averageTurnsPerSession, 1.5);
    assert.equal(usage.actors[0].actorKey, 'actor-teacher-a');
    assert.equal(usage.actors[0].loadedTurnCount, 3);
    assert.deepEqual(usage.segments.botKeys, [{ name: 'bot-school', count: 5 }]);
    assert.deepEqual(usage.segments.personKeys, [{ name: 'person-teacher-a', count: 5 }]);
    assert.deepEqual(usage.segments.actorKeys, [{ name: 'actor-teacher-a', count: 5 }]);
    assert.deepEqual(usage.toolUsage.map(tool => tool.name), ['read_file', 'write_file']);
    assert.ok(usage.topics.some(topic => topic.topic === 'grades_or_exams'));
    assert.ok(usage.topics.some(topic => topic.topic === 'notices_or_messages'));
    assert.equal(usage.questionSamples[0].questionHash.startsWith('q_'), true);
    assert.equal(usage.questionSamples[0].actorKey, 'actor-teacher-a');
    assert.equal(JSON.stringify(usage).includes('张三'), false);
  });
});
