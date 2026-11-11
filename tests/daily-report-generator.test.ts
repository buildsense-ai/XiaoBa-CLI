import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('DailyReportGenerator', () => {
  let testRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-daily-report-'));
    process.chdir(testRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('ignores runtime entries in mixed session logs', () => {
    delete require.cache[require.resolve('../src/utils/daily-report-generator')];
    const { DailyReportGenerator } = require('../src/utils/daily-report-generator');

    const date = '2026-04-30';
    const sessionDir = path.join(testRoot, 'logs', 'sessions', 'chat', date);
    fs.mkdirSync(sessionDir, { recursive: true });

    const filePath = path.join(sessionDir, 'chat_user_ou_demo.jsonl');
    const entries = [
      {
        entry_type: 'runtime',
        timestamp: '2026-04-30T08:00:00.000Z',
        session_id: 'user:ou_demo',
        session_type: 'chat',
        level: 'INFO',
        message: 'runtime entry',
      },
      {
        entry_type: 'turn',
        turn: 1,
        timestamp: '2026-04-30T08:01:00.000Z',
        session_id: 'user:ou_demo',
        session_type: 'chat',
        user: { text: 'first request' },
        assistant: {
          text: 'first response',
          tool_calls: [{ name: 'bash', id: 'tool-1', arguments: {}, result: 'ok' }],
        },
        tokens: { prompt: 10, completion: 5 },
      },
      {
        entry_type: 'runtime',
        timestamp: '2026-04-30T08:01:10.000Z',
        session_id: 'user:ou_demo',
        session_type: 'chat',
        level: 'INFO',
        message: 'more runtime',
      },
      {
        entry_type: 'turn',
        turn: 2,
        timestamp: '2026-04-30T08:02:00.000Z',
        session_id: 'user:ou_demo',
        session_type: 'chat',
        user: { text: 'second request' },
        assistant: {
          text: 'second response',
          tool_calls: [{ name: 'read_file', id: 'tool-2', arguments: {}, result: 'done' }],
        },
        tokens: { prompt: 7, completion: 3 },
      },
    ];

    fs.writeFileSync(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');

    const generator = new DailyReportGenerator({} as any);
    const summary = (generator as any).parseSessionLog(filePath, 'chat');

    assert.deepStrictEqual(summary, {
      session_id: 'user:ou_demo',
      session_type: 'chat',
      turn_count: 2,
      start_time: '2026-04-30T08:01:00.000Z',
      end_time: '2026-04-30T08:02:00.000Z',
      topics: ['first request', 'second request'],
      tool_calls: ['bash', 'read_file'],
      total_tokens: 25,
    });
  });

  test('keeps parsing legacy turn-only logs without entry_type', () => {
    delete require.cache[require.resolve('../src/utils/daily-report-generator')];
    const { DailyReportGenerator } = require('../src/utils/daily-report-generator');

    const date = '2026-04-30';
    const sessionDir = path.join(testRoot, 'logs', 'sessions', 'chat', date);
    fs.mkdirSync(sessionDir, { recursive: true });

    const filePath = path.join(sessionDir, 'legacy-session.jsonl');
    const entries = [
      {
        turn: 1,
        timestamp: '2026-04-30T09:01:00.000Z',
        session_id: 'legacy-session',
        session_type: 'chat',
        user: { text: 'legacy request' },
        assistant: {
          text: 'legacy response',
          tool_calls: [{ name: 'write_file', id: 'tool-1', arguments: {}, result: 'ok' }],
        },
        tokens: { prompt: 4, completion: 6 },
      },
    ];

    fs.writeFileSync(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');

    const generator = new DailyReportGenerator({} as any);
    const summary = (generator as any).parseSessionLog(filePath, 'chat');

    assert.deepStrictEqual(summary, {
      session_id: 'legacy-session',
      session_type: 'chat',
      turn_count: 1,
      start_time: '2026-04-30T09:01:00.000Z',
      end_time: '2026-04-30T09:01:00.000Z',
      topics: ['legacy request'],
      tool_calls: ['write_file'],
      total_tokens: 10,
    });
  });

  test('projects transcript runs once, recovers damaged tails, and groups CLI and Weixin reports', () => {
    const { DailyReportGenerator } = require('../src/utils/daily-report-generator');
    const generator = new DailyReportGenerator({} as any);
    const envelope = { entry_type: 'transcript', schema_version: 1, stream_id: 'stream', seq: 1,
      timestamp: '2026-11-11T08:00:00Z', session_id: 'cli-session', session_type: 'cli' };
    const filePath = path.join(testRoot, 'transcript.jsonl');
    const entries = [
      { ...envelope, event_id: 'receipt', event: { type: 'input_received', input_id: 'input', text: 'actual user topic' } },
      { ...envelope, event_id: 'consumed', run_id: 'run', event: { type: 'input_consumed', input_ids: ['input'], kind: 'root', text: 'merged model input' } },
      { ...envelope, event_id: 'tool', run_id: 'run', event: { type: 'tool_finished', call_id: 'call', name: 'read_file', result: 'done', duration_ms: 1 } },
      { entry_type: 'turn', run_id: 'run', turn: 1, timestamp: envelope.timestamp, session_id: 'cli-session', session_type: 'cli',
        user: { text: 'merged model input' }, assistant: { text: 'answer', tool_calls: [] }, tokens: { prompt: 2, completion: 3 } },
    ];
    fs.writeFileSync(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n{"damaged":');
    const summary = (generator as any).parseSessionLog(filePath, 'cli');
    assert.strictEqual(summary.turn_count, 1);
    assert.deepStrictEqual(summary.topics, ['actual user topic']);
    assert.deepStrictEqual(summary.tool_calls, ['read_file']);
    assert.strictEqual(summary.total_tokens, 5);
    const grouped = (generator as any).groupByType([summary, { ...summary, session_type: 'weixin' }]);
    const report = (generator as any).fallbackTemplate('2026-11-11', grouped, { total_sessions: 2, chat_sessions: 2, team_sessions: 0, total_turns: 2, total_tokens: 10 });
    assert.match(report, /CLI \/ Weixin/);
    assert.match(report, /actual user topic/);
  });
});
