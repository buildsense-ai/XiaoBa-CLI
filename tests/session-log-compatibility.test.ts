import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { SessionTurnLogger } from '../src/utils/session-turn-logger';
import { parseSessionLogContent, isSessionTurnEntry } from '../src/utils/session-log-schema';
import { projectSessionLog } from '../src/utils/session-log-projection';
import { MemoryLogStore } from '../src/core/memory-log-store';
import { DailyReportGenerator } from '../src/utils/daily-report-generator';

const require = createRequire(import.meta.url);
const summary = (turn = 1, extra: Record<string, unknown> = {}) => ({
  entry_type: 'turn' as const, turn, timestamp: `2026-11-11T${String(8 + turn).padStart(2, '0')}:00:00.000Z`,
  session_id: 'compat-session', session_type: 'cli',
  user: { text: `USER_${turn}`, images: ['image_0'], runtime_feedback: ['FEEDBACK_METADATA'] },
  assistant: { text: `FINAL_${turn}`, tool_calls: [{ id: `call-${turn}`, name: 'read_file', arguments: '{"path":"fixture"}', result: 'RESULT_METADATA', duration_ms: 3 }] },
  tokens: { prompt: 10, completion: 5 }, ...extra,
});
const event = (id: string, payload: unknown, runId = 'compat-run') => ({
  entry_type: 'transcript', schema_version: 1, event_id: id, stream_id: 'compat-stream', seq: 1,
  run_id: runId, timestamp: '2026-11-11T10:00:00.000Z', session_id: 'compat-session', session_type: 'cli', event: payload,
});
function writeFixture(t: any, records: unknown[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-log-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'logs', 'sessions', 'cli', '2026-11-11');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'compat.jsonl');
  fs.writeFileSync(file, records.map(record => typeof record === 'string' ? record : JSON.stringify(record)).join('\n') + '\n');
  return { root, file, ref: 'cli/2026-11-11/compat.jsonl' };
}

// The standalone scripts have an unconditional CLI entry point. Exercise their
// actual readers in a VM, replacing only main() and preventing dotenv/network IO.
function loadDiaryReader(scriptName: string, root: string): any {
  const scriptPath = path.resolve('scripts', scriptName);
  const scriptRequire = createRequire(scriptPath);
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.match(source, /main\(\)\.catch\(console\.error\);\s*$/);
  const module = { exports: {} };
  vm.runInNewContext(source.replace(/main\(\)\.catch\(console\.error\);\s*$/, 'module.exports = { ' + (scriptName === 'log-to-diary.js' ? 'readSessionLogs' : 'readAgentSessions') + ' };'), {
    module, __dirname: path.join(root, 'scripts'), console,
    require: (id: string) => {
      if (id === 'dotenv') return { config: () => ({}) };
      if (id === 'https') return { request: () => { throw new Error('Network access is not permitted in reader tests'); } };
      return scriptRequire(id);
    },
  }, { filename: scriptPath });
  return module.exports;
}

for (const script of ['log-to-diary.js', 'xiaoba-diary.js']) {
  test(`${script} counts old summaries once and ignores new/unknown event rows`, t => {
    const { entry_type: _, ...legacy } = summary(1);
    const fixture = writeFixture(t, [legacy, event('start', { type: 'run_started' }), summary(2, { run_id: 'compat-run' }),
      event('reply', { type: 'assistant_message', phase: 'reply', text: 'FINAL_2', model_call: 1 }),
      { entry_type: 'runtime', timestamp: '2026-11-11T10:00:00Z', message: 'runtime' },
      { entry_type: 'future_record', user: { text: 'not a turn' } }, null, '{broken',
      summary(3),
    ]);
    const reader = loadDiaryReader(script, fixture.root);
    const sessions = script === 'log-to-diary.js'
      ? reader.readSessionLogs('2026-11-11', 'all')
      : reader.readAgentSessions(fixture.root, 'synthetic-agent', '2026-11-11');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].turns.length, 3);
    assert.deepEqual(Array.from(sessions[0].turns, (turn: any) => turn.user), ['USER_1', 'USER_2', 'USER_3']);
  });
}

for (const caseName of ['only-start', 'missing-root-and-final', 'missing-tool-result', 'future-event']) {
  test(`mixed projection retains compatible summary information: ${caseName}`, async t => {
    const old = summary(1, { run_id: 'compat-run' });
    const records: unknown[] = [event('start', { type: 'run_started' })];
    if (caseName === 'missing-root-and-final') records.push(event('partial', { type: 'assistant_message', phase: 'partial', text: 'ABANDONED_PARTIAL', model_call: 1 }));
    if (caseName === 'missing-tool-result') records.push(event('tool', { type: 'tool_started', call_id: 'call-1', name: 'read_file', arguments: '{"path":"fixture"}' }));
    if (caseName === 'future-event') records.splice(0, 1, event('future', { type: 'future_event' }));
    records.push(old);
    const fixture = writeFixture(t, records);
    const store = new MemoryLogStore(fixture.root);
    for (const marker of ['USER_1', 'FINAL_1', 'RESULT_METADATA', ...(caseName === 'future-event' ? [] : ['FEEDBACK_METADATA'])]) {
      const matches = (await store.search({ keywords: [marker] })).filter(match => match.ref.startsWith(fixture.ref + '#'));
      assert.equal(matches.length, 1, `one searchable copy of ${marker}`);
      assert.match((await store.readTurn(matches[0].ref)).text, new RegExp(marker));
    }
    assert.match((await store.readTurn(fixture.ref + '#1')).text, /FINAL_1/);
    const projected = projectSessionLog(parseSessionLogContent(fs.readFileSync(fixture.file, 'utf8'))).filter(item => item.searchable);
    assert.equal(projected.length, 1);
    assert.deepEqual(projected[0].entry.user.images, ['image_0']);
    assert.deepEqual(projected[0].entry.tokens, old.tokens);
    if (caseName !== 'future-event') assert.match(projected[0].transcript!, /unfinished_or_unknown/);
  });
}

test('old, upgraded and rollback turns preserve numeric references and report chronology', async t => {
  const first = summary(1);
  const upgraded = summary(2, { run_id: 'compat-run' });
  const rollback = summary(3);
  const fixture = writeFixture(t, [first, event('start', { type: 'run_started' }),
    event('root', { type: 'input_consumed', input_ids: [], kind: 'root', text: 'USER_2' }),
    event('reply', { type: 'assistant_message', phase: 'reply', text: 'FINAL_2', model_call: 1 }),
    event('finish', { type: 'run_finished', status: 'completed' }), upgraded, rollback]);
  const store = new MemoryLogStore(fixture.root);
  for (const index of [1, 2, 3]) assert.match((await store.readTurn(`${fixture.ref}#${index}`)).text, new RegExp(`FINAL_${index}`));
  const report = (new DailyReportGenerator({} as any) as any).parseSessionLog(fixture.file, 'cli');
  assert.equal(report.turn_count, 3);
  assert.equal(report.total_tokens, 45);
  assert.deepEqual(report.topics, ['USER_1', 'USER_2', 'USER_3']);
  assert.equal(report.start_time, first.timestamp);
  assert.equal(report.end_time, rollback.timestamp);
});

test('writer keeps the complete turn contract while independently numbering events', t => {
  const sessionId = 'compat-writer-' + randomUUID();
  const logger = new SessionTurnLogger('cli', sessionId, {
    agent_id: 'agent-compat', trust: 'legacy_context', source: 'fixture',
  });
  t.after(() => fs.rmSync(logger.getLogFilePath(), { force: true }));
  const prompt = { source: 'fixture', prompt_version: 'v1', prompts_dir: '/synthetic', generated_at: '2026-11-11T00:00:00Z',
    system_sha256: 'a'.repeat(64), system_short_hash: 'a'.repeat(12), bundle_sha256: 'b'.repeat(64), bundle_short_hash: 'b'.repeat(12), bundle_file_count: 2 };
  const tools = summary().assistant.tool_calls;
  const input: any = [{ type: 'text', text: 'hello\n' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('synthetic').toString('base64') } }, { type: 'text', text: 'world' }];
  logger.logTurn(input, 'BASE_FINAL', tools, { prompt: 10, completion: 5 }, { runtimeFeedback: ['feedback'], runtimeObservationSource: 'runtime', prompt });
  const inputId = logger.recordInputReceipt('original');
  logger.logTranscript({ type: 'run_started' }, 'new-run');
  logger.logTurn(input, 'NEW_FINAL', tools, { prompt: 10, completion: 5 }, { runId: 'new-run', runtimeFeedback: ['feedback'], runtimeObservationSource: 'runtime', prompt });
  logger.logTranscript({ type: 'run_finished', status: 'completed' }, 'new-run');
  const raw = fs.readFileSync(logger.getLogFilePath(), 'utf8');
  // Old consumers selected explicit turn rows, independent of physical line number.
  const oldView = raw.trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.entry_type === 'turn');
  assert.deepEqual(oldView.map(entry => entry.turn), [1, 2]);
  const expected = { entry_type: 'turn', turn: 1, timestamp: oldView[0].timestamp, session_id: sessionId, session_type: 'cli',
    agent_identity: { agent_id: 'agent-compat', trust: 'legacy_context', source: 'fixture' },
    user: { text: 'hello\nworld', images: ['image_0'], runtime_feedback: ['feedback'], runtime_observation_source: 'runtime' },
    assistant: { text: 'BASE_FINAL', tool_calls: tools }, tokens: { prompt: 10, completion: 5 }, prompt };
  assert.deepEqual(oldView[0], expected);
  assert.deepEqual(oldView[1], { ...expected, turn: 2, run_id: 'new-run', timestamp: oldView[1].timestamp, assistant: { ...expected.assistant, text: 'NEW_FINAL' } });
  assert.deepEqual(parseSessionLogContent(raw).filter(isSessionTurnEntry), oldView);
  assert.ok(raw.includes(inputId));
});
