import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';
import {
  isSessionTurnEntry,
  parseSessionLogContent,
  readSessionIdFromJsonl,
  resolveSessionIdFromEntries,
} from '../src/utils/session-log-schema';

const require = createRequire(import.meta.url);

describe('session-log-schema', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-session-log-schema-'));
  });

  afterEach(() => {
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('parses jsonl content and recognizes current and legacy turn entries', () => {
    const currentTurn = {
      entry_type: 'turn',
      turn: 1,
      timestamp: '2026-05-01T08:00:00.000Z',
      session_id: 'user:current',
      session_type: 'chat',
      user: { text: 'current', runtime_feedback: ['[运行时反馈] runtime\n错误: failed'] },
      assistant: { text: 'ok', tool_calls: [] },
      tokens: { prompt: 1, completion: 2 },
    };
    const runtime = {
      entry_type: 'runtime',
      timestamp: '2026-05-01T08:00:01.000Z',
      session_id: 'user:current',
      session_type: 'chat',
      level: 'INFO',
      message: 'runtime',
    };
    const subagentEvent = {
      entry_type: 'subagent_event',
      timestamp: '2026-05-01T08:00:01.500Z',
      session_id: 'user:current',
      session_type: 'chat',
      subagent: {
        id: 'sub-demo',
        name: '子agent1',
        type: 'explorer',
        status: 'running',
        seq: 1,
      },
      event: {
        type: 'agent_spawned',
        summary: '派遣子agent1扫描登录链路',
      },
    };
    const legacyTurn = {
      turn: 2,
      timestamp: '2026-05-01T08:00:02.000Z',
      session_id: 'user:legacy',
      session_type: 'chat',
      user: { text: 'legacy' },
      assistant: { text: 'ok', tool_calls: [] },
      tokens: { prompt: 3, completion: 4 },
    };
    const malformedTurn = {
      entry_type: 'turn',
      timestamp: '2026-05-01T08:00:03.000Z',
      session_id: 'user:broken',
    };

    const entries = parseSessionLogContent([
      JSON.stringify(currentTurn),
      JSON.stringify(runtime),
      JSON.stringify(subagentEvent),
      JSON.stringify(legacyTurn),
      JSON.stringify(malformedTurn),
    ].join('\r\n'));

    assert.equal(entries.length, 5);
    assert.deepStrictEqual(entries.map(entry => isSessionTurnEntry(entry)), [true, false, false, true, false]);
    assert.deepStrictEqual((entries[0] as any).user.runtime_feedback, ['[运行时反馈] runtime\n错误: failed']);
    assert.equal((entries[2] as any).subagent.name, '子agent1');
  });

  test('resolves session id from content and falls back when content has no session id', () => {
    const entries = parseSessionLogContent(JSON.stringify({
      entry_type: 'runtime',
      timestamp: '2026-05-01T08:00:00.000Z',
      session_id: 'group:demo',
      session_type: 'feishu',
      level: 'INFO',
      message: 'runtime',
    }));

    assert.equal(resolveSessionIdFromEntries(entries, 'fallback'), 'group:demo');
    assert.equal(resolveSessionIdFromEntries([] as any, 'fallback'), 'fallback');
  });

  test('reads session id from the first non-empty jsonl line', () => {
    const filePath = path.join(testRoot, 'session.jsonl');
    fs.writeFileSync(
      filePath,
      '\n' + JSON.stringify({
        entry_type: 'turn',
        turn: 1,
        timestamp: '2026-05-01T08:00:00.000Z',
        session_id: 'user:first',
        session_type: 'chat',
        user: { text: 'hello' },
        assistant: { text: 'world', tool_calls: [] },
        tokens: { prompt: 1, completion: 1 },
      }) + '\n',
      'utf-8',
    );

    assert.equal(readSessionIdFromJsonl(filePath), 'user:first');
    assert.equal(readSessionIdFromJsonl(path.join(testRoot, 'missing.jsonl')), undefined);
  });

  test('SessionTurnLogger writes structured subagent event entries', () => {
    const originalCwd = process.cwd();
    process.chdir(testRoot);
    try {
      delete require.cache[require.resolve('../src/utils/session-turn-logger')];
      const { SessionTurnLogger } = require('../src/utils/session-turn-logger');
      const logger = new SessionTurnLogger('chat', 'cc_user:demo');
      logger.logSubAgentEvent({
        id: 'evt-demo',
        parentSessionKey: 'cc_user:demo',
        subAgentId: 'sub-demo',
        subAgentName: '子agent1',
        type: 'agent_spawned',
        timestamp: Date.parse('2026-05-01T08:00:00.000Z'),
        seq: 1,
        summary: '派遣子agent1扫描登录链路',
        payload: { agentType: 'explorer' },
      }, {
        id: 'sub-demo',
        displayName: '子agent1',
        agentType: 'explorer',
        status: 'running',
      } as any);

      const entries = parseSessionLogContent(fs.readFileSync(logger.getLogFilePath(), 'utf-8'));
      assert.equal(entries.length, 1);
      assert.equal((entries[0] as any).entry_type, 'subagent_event');
      assert.equal((entries[0] as any).subagent.name, '子agent1');
      assert.equal((entries[0] as any).event.type, 'agent_spawned');
    } finally {
      process.chdir(originalCwd);
    }
  });
});
