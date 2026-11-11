import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentTurnController } from '../src/core/agent-turn-controller';
import { ConversationRunner } from '../src/core/conversation-runner';
import { TurnContextBuilder } from '../src/core/turn-context-builder';
import { TurnLogRecorder } from '../src/core/turn-log-recorder';
import { MemoryLogStore } from '../src/core/memory-log-store';
import { SessionTurnLogger } from '../src/utils/session-turn-logger';
import { parseSessionLogContent, type SessionTranscriptLogEntry } from '../src/utils/session-log-schema';
import { projectSessionLog } from '../src/utils/session-log-projection';
import { FinishMemorySearchTool } from '../src/tools/memory-branch-tools';
import { AIService } from '../src/utils/ai-service';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const textResponse = (content: string) => ({ content, toolCalls: [], usage });
const toolResponse = {
  content: 'PRELUDE_' + 'p'.repeat(500) + '_PRELUDE_TAIL',
  toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'noop', arguments: '{}' } }], usage,
};
const tools = {
  getToolDefinitions: () => [{ name: 'noop', description: 'synthetic', parameters: { type: 'object', properties: {} } }],
  executeTool: async (call: any) => ({ tool_call_id: call.id, role: 'tool', name: 'noop', content: 'TOOL_RESULT_' + 'r'.repeat(500) + '_RESULT_TAIL', ok: true }),
};
function harness(responses: any[]) {
  const logger = new SessionTurnLogger('cli', 'transcript-test-' + randomUUID());
  let calls = 0;
  const controller = new AgentTurnController({
    sessionKey: 'transcript-test', sessionType: 'cli',
    services: {
      aiService: { isToolCallingSupported: () => true, chatStream: async (_messages: any, _tools: any, callbacks: any) => {
        const response = responses[calls++];
        if (typeof response === 'function') return response(callbacks);
        if (response instanceof Error) throw response;
        return response;
      } },
      toolManager: tools, skillManager: {}, memoryBranch: { enabled: false },
    },
    skillRuntime: { reloadSkills: async () => {}, buildSkillsListMessage: () => null },
    turnContextBuilder: new TurnContextBuilder(), turnLogRecorder: new TurnLogRecorder(logger),
    workspaceRoot: os.tmpdir(), getCurrentDirectory: () => os.tmpdir(), updateCurrentDirectory: () => {},
  } as any);
  return { logger, controller, read: () => parseSessionLogContent(fs.readFileSync(logger.getLogFilePath(), 'utf8')) };
}
function events(entries: ReturnType<typeof parseSessionLogContent>) {
  return entries.filter((entry): entry is SessionTranscriptLogEntry => entry.entry_type === 'transcript');
}

test('records pending inputs, all assistant messages and tools in occurrence order while retaining the old summary', async t => {
  const h = harness([toolResponse, textResponse('DRAFT_' + 'd'.repeat(500) + '_DRAFT_TAIL'), textResponse('FINAL_REPLY')]);
  t.after(() => fs.rmSync(h.logger.getLogFilePath(), { force: true }));
  const pending = ['ONE_' + 'a'.repeat(500) + '_ONE_TAIL', 'TWO_' + 'b'.repeat(500) + '_TWO_TAIL'];
  await h.controller.run({ input: 'ROOT', messages: [], runtimeFeedback: [], shouldContinue: () => true,
    pendingUserInputProvider: () => pending.shift() || null });
  const entries = h.read();
  const transcript = events(entries);
  const body = JSON.stringify(transcript);
  for (const marker of ['_ONE_TAIL', '_TWO_TAIL', '_PRELUDE_TAIL', '_DRAFT_TAIL', '_RESULT_TAIL']) assert.ok(body.includes(marker), marker);
  assert.deepEqual(transcript.map(entry => entry.seq), transcript.map((_, i) => i + 1));
  assert.equal(new Set(transcript.map(entry => entry.event_id)).size, transcript.length);
  assert.ok(body.indexOf('_PRELUDE_TAIL') < body.indexOf('tool_started'));
  assert.ok(body.indexOf('tool_started') < body.indexOf('tool_finished'));
  const summary = entries.find(entry => entry.entry_type === 'turn') as any;
  assert.equal(summary.user.text, 'ROOT');
  assert.equal(summary.assistant.text, 'FINAL_REPLY');
  const projected = projectSessionLog(entries).filter(record => record.searchable);
  assert.equal(projected.length, 1);
  assert.match(projected[0].transcript!, /RUN_STATUS: completed/);
  assert.equal(summary.run_id, transcript.find(entry => entry.run_id)?.run_id);
});

for (const cancelled of [false, true]) test(`retains completed work and streamed partial text after ${cancelled ? 'cancellation' : 'failure'}`, async t => {
  const error = Object.assign(new Error('synthetic failure'), { name: cancelled ? 'AbortError' : 'Error' });
  const h = harness([toolResponse, (callbacks: any) => { callbacks.onTextObserved('PARTIAL_' + 'x'.repeat(500) + '_PARTIAL_TAIL'); throw error; }]);
  t.after(() => fs.rmSync(h.logger.getLogFilePath(), { force: true }));
  let pending = true;
  await assert.rejects(h.controller.run({ input: 'ROOT_FAILURE', messages: [], runtimeFeedback: [], shouldContinue: () => true,
    pendingUserInputProvider: () => pending ? (pending = false, 'PENDING_FAILURE_TAIL') : null }), /synthetic failure/);
  const transcript = events(h.read());
  assert.equal(h.read().filter(entry => entry.entry_type === 'turn').length, 0);
  assert.match(JSON.stringify(transcript), /ROOT_FAILURE/);
  assert.match(JSON.stringify(transcript), /PENDING_FAILURE_TAIL/);
  assert.match(JSON.stringify(transcript), /_RESULT_TAIL/);
  assert.match(JSON.stringify(transcript), /_PARTIAL_TAIL/);
  assert.ok(transcript.some(entry => entry.event.type === 'model_failed' && entry.event.error_name === error.name));
  assert.deepEqual(transcript.at(-1)?.event, { type: 'run_finished', status: cancelled ? 'cancelled' : 'failed', error_name: error.name });
});

test('rejects a dequeued pending batch when cancellation wins the asynchronous handoff', async () => {
  let stopped = false;
  const queue = ['pending-handoff'];
  const observed: any[] = [];
  const runner = new ConversationRunner({ chat: async () => textResponse('first') } as any, tools as any, {
    stream: false, shouldContinue: () => !stopped, onTranscript: event => observed.push(event),
    pendingUserInputProvider: async () => {
      const content = queue.shift()!;
      await Promise.resolve();
      stopped = true;
      return { content, transcriptInputIds: ['input-id'], onRejected: () => queue.unshift(content) };
    },
  });
  const result = await runner.run([{ role: 'user', content: 'start' }]);
  assert.deepEqual(queue, ['pending-handoff']);
  assert.ok(!result.newMessages.some(message => message.content === 'pending-handoff'));
  assert.ok(observed.some(event => event.type === 'input_deferred'));
  assert.ok(!observed.some(event => event.type === 'input_consumed'));
});

test('receipt preserves attachment identity without binary, signed query or runtime grants', t => {
  const logger = new SessionTurnLogger('cli', 'transcript-attachments-' + randomUUID());
  t.after(() => fs.rmSync(logger.getLogFilePath(), { force: true }));
  const content = [{ type: 'image', source: { type: 'base64', data: 'c2VjcmV0LWltYWdl', media_type: 'image/png' } }] as any;
  const input = logger.recordInputReceipt(content, {
    source: 'synthetic', messageId: '42', senderId: 'user',
    attachments: [
      { name: 'test.png', url: 'https://user:password@example.test/uploads/test.png?media_token=private#private' },
      { name: 'source.txt', url: '/uploads/source.txt?media_token=private#private', reference: 'file-ref' },
    ],
    deviceGrants: [{ credential: 'DO_NOT_SERIALIZE' }],
  } as any);
  const raw = fs.readFileSync(logger.getLogFilePath(), 'utf8');
  assert.ok(raw.includes(input));
  assert.ok(raw.includes('sha256'));
  assert.ok(raw.includes('https://example.test/uploads/test.png'));
  assert.ok(raw.includes('"url":"/uploads/source.txt"'));
  assert.ok(raw.includes('"reference":"file-ref"'));
  for (const secret of ['c2VjcmV0LWltYWdl', 'password', 'media_token', 'DO_NOT_SERIALIZE']) assert.ok(!raw.includes(secret));
});

test('memory reads new runs and outstanding receipts, recovers malformed lines, and preserves existing ordinal refs', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-transcript-memory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'logs', 'sessions', 'cli', '2026-11-11');
  fs.mkdirSync(dir, { recursive: true });
  const logger = new SessionTurnLogger('cli', 'transcript-memory-' + randomUUID());
  t.after(() => fs.rmSync(logger.getLogFilePath(), { force: true }));
  const id = logger.recordInputReceipt('UNCONSUMED_MARKER');
  const recorder = new TurnLogRecorder(logger);
  recorder.startRun('run-stable', 'ROOT_MARKER');
  recorder.recordEvent('run-stable', { type: 'input_consumed', input_ids: [], kind: 'pending', text: 'PENDING_MARKER' });
  recorder.recordEvent('run-stable', { type: 'assistant_message', text: 'INTERMEDIATE_MARKER', phase: 'tool_prelude', model_call: 1 });
  recorder.recordEvent('run-stable', { type: 'input_consumed', input_ids: [], kind: 'runtime_observation', source: 'memory', text: 'SYNTHETIC_OBSERVATION' });
  recorder.recordEvent('run-stable', { type: 'run_finished', status: 'failed' });
  const old = { entry_type: 'turn', turn: 1, timestamp: '2026-11-11T00:00:00Z', session_id: 'old', session_type: 'cli',
    user: { text: 'CURRENT_ORDINAL' }, assistant: { text: 'answer', tool_calls: [] }, tokens: { prompt: 1, completion: 1 } };
  const { entry_type: _ignored, ...legacy } = { ...old, user: { text: 'LEGACY_MARKER' } };
  const logPath = path.join(dir, 'demo.jsonl');
  fs.writeFileSync(logPath, [JSON.stringify(legacy), JSON.stringify(old), '{corrupt}', fs.readFileSync(logger.getLogFilePath(), 'utf8'), '{"partial":'].join('\n'));
  const store = new MemoryLogStore(root);
  const search = await store.search({ keywords: ['PENDING_MARKER', 'INTERMEDIATE_MARKER'] });
  const run = search.find(match => match.ref === 'cli/2026-11-11/demo.jsonl#run:run-stable');
  assert.ok(run);
  const read = await store.readTurn(run.ref);
  assert.match(read.text, /RUN_STATUS: failed/);
  assert.match(read.text, /RUNTIME_OBSERVATION source=memory/);
  assert.ok(!read.text.includes('[USER_INPUT runtime_observation]'));
  assert.match((await store.readTurn('cli/2026-11-11/demo.jsonl#1')).text, /CURRENT_ORDINAL/);
  assert.match((await store.readTurn('cli/2026-11-11/demo.jsonl#legacy:1')).text, /LEGACY_MARKER/);
  assert.match((await store.readTurn(`cli/2026-11-11/demo.jsonl#input:${id}`)).text, /no consumption recorded/);
  const finish = new FinishMemorySearchTool(() => {});
  const result = await finish.execute({ summary: 'found', evidence: [run.ref], inject: true }, { workingDirectory: root, conversationHistory: [] });
  assert.equal(result.ok, true);
});

test('tolerant parsing reports corrupt lines; strict parsing still rejects them; restart append isolates damaged tail', t => {
  const logger = new SessionTurnLogger('cli', 'transcript-tail-' + randomUUID());
  t.after(() => fs.rmSync(logger.getLogFilePath(), { force: true }));
  fs.writeFileSync(logger.getLogFilePath(), '{"incomplete":');
  logger.recordInputReceipt('RECOVERED_TAIL');
  const raw = fs.readFileSync(logger.getLogFilePath(), 'utf8');
  assert.throws(() => parseSessionLogContent(raw));
  const issues: any[] = [];
  const entries = parseSessionLogContent(raw, { tolerant: true, onIssue: issue => issues.push(issue) });
  assert.equal(entries.length, 1);
  assert.deepEqual(issues, [{ line: 1, kind: 'invalid_json' }]);
  assert.match(JSON.stringify(entries), /RECOVERED_TAIL/);
});

test('runtime fallback replies are recorded separately from model text', async () => {
  const observed: any[] = [];
  const empty = { content: null, toolCalls: [], stopReason: 'max_tokens', usage };
  const runner = new ConversationRunner({ chat: async () => empty } as any, tools as any, {
    stream: false, onTranscript: event => observed.push(event),
  });
  const result = await runner.run([{ role: 'user', content: 'synthetic' }]);
  assert.match(result.response, /max_tokens/);
  assert.deepEqual(observed.filter(event => event.type === 'assistant_message'), [
    { type: 'assistant_message', text: result.response, phase: 'runtime_reply', model_call: 2 },
  ]);
});

test('projection isolates malformed events and preserves runtime observations and unknown end states', () => {
  const envelope = { entry_type: 'transcript', schema_version: 1, stream_id: 'stream', seq: 1,
    event_id: 'start', run_id: 'run-unknown', timestamp: '2026-11-11T00:00:00Z', session_id: 'test', session_type: 'cli' };
  const entries = [
    { ...envelope, event: { type: 'run_started' } },
    { ...envelope, event_id: 'bad', event: { type: 'input_consumed', text: 'bad', input_ids: null } },
    { ...envelope, event_id: 'observation', event: { type: 'runtime_observation', source: 'tool', text: 'RUNTIME_ONLY' } },
    { ...envelope, event_id: 'error', event: { type: 'model_failed', model_call: 1, error_name: 'Error' } },
  ];
  const [run] = projectSessionLog(entries as any);
  assert.match(run.transcript!, /RUN_STATUS: unfinished_or_unknown/);
  assert.match(run.transcript!, /RUNTIME_OBSERVATION source=tool/);
  assert.match(run.transcript!, /MODEL_FAILED/);
  assert.equal(run.entry.user.text, '');
});

test('memory neighbors suppress the covered turn summary and consumed receipt', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-transcript-neighbors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const h = harness([textResponse('UNIQUE_ANSWER')]);
  t.after(() => fs.rmSync(h.logger.getLogFilePath(), { force: true }));
  await h.controller.run({ input: 'UNIQUE_ROOT', messages: [], runtimeFeedback: [], shouldContinue: () => true });
  const dir = path.join(root, 'logs', 'sessions', 'cli', '2026-11-11');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(h.logger.getLogFilePath(), path.join(dir, 'neighbors.jsonl'));
  const store = new MemoryLogStore(root);
  const matches = await store.search({ keywords: ['UNIQUE_ROOT'] });
  const ref = matches.find(match => match.ref.startsWith('cli/2026-11-11/neighbors.jsonl#run:'))!.ref;
  const neighbors = await store.readNeighbors(ref, { previous: 20, next: 20 });
  assert.deepEqual(neighbors.turns.map(turn => turn.ref), [ref]);
  assert.match((await store.readTurn('cli/2026-11-11/neighbors.jsonl#1')).text, /UNIQUE_ANSWER/);
});

test('controller records its visible empty-response fallback', async t => {
  const h = harness([textResponse('')]);
  t.after(() => fs.rmSync(h.logger.getLogFilePath(), { force: true }));
  const result = await h.controller.run({ input: 'empty fallback', messages: [], runtimeFeedback: [], shouldContinue: () => true });
  assert.ok(result.text);
  assert.ok(events(h.read()).some(entry => entry.event.type === 'assistant_message'
    && entry.event.phase === 'runtime_reply' && entry.event.text === result.text));
});

test('image safety rejection retains the failed call and runtime reply', async () => {
  const observed: any[] = [];
  const runner = new ConversationRunner({ chat: async () => {
    throw new Error('input_new_sensitive, messages[3] content[1] image is sensitive');
  } } as any, tools as any, {
    stream: false, onTranscript: event => observed.push(event),
    toolExecutionContext: { surface: 'catscompany' } as any,
  });
  const result = await runner.run([{ role: 'user', content: 'synthetic image' }]);
  assert.ok(result.response);
  assert.ok(observed.some(event => event.type === 'model_failed'));
  assert.ok(observed.some(event => event.type === 'assistant_message'
    && event.phase === 'runtime_reply' && event.text === result.response));
});

for (const mode of ['failed', 'cancelled', 'retry'] as const) test(`real AIService buffered ${mode} preserves attempt text without a UI callback`, async () => {
  const service = new AIService({ provider: 'openai', apiUrl: 'https://synthetic.example.test/v1', apiKey: 'synthetic', model: 'synthetic', openaiApiMode: 'responses' });
  let attempts = 0;
  (service as any).sleepWithAbort = async () => {};
  (service as any).provider = { chatStream: async (_messages: any, _tools: any, callbacks: any) => {
    attempts++;
    callbacks.onText('ATTEMPT_' + attempts + '_TAIL');
    if (mode === 'retry' && attempts > 1) return textResponse('ATTEMPT_2_TAIL');
    throw Object.assign(new Error('synthetic failure'), mode === 'cancelled' ? { name: 'AbortError' } : mode === 'retry' ? { status: 503 } : {});
  } };
  const observed: any[] = [];
  const runner = new ConversationRunner(service, tools as any, { stream: true, onTranscript: event => observed.push(event) });
  const run = runner.run([{ role: 'user', content: 'synthetic input' }]);
  if (mode === 'retry') await run;
  else await assert.rejects(run);
  const messages = observed.filter(event => event.type === 'assistant_message');
  assert.deepEqual(messages.map(event => [event.phase, event.text]), mode === 'retry'
    ? [['partial', 'ATTEMPT_1_TAIL'], ['reply', 'ATTEMPT_2_TAIL']]
    : [['partial', 'ATTEMPT_1_TAIL']]);
  assert.equal(attempts, mode === 'retry' ? 2 : 1);
});

test('tool transcript preserves image hashes for both content blocks and direct-image wrappers', async () => {
  const image = { type: 'image', source: { type: 'base64', data: 'c2VjcmV0LWltYWdl', media_type: 'image/png' } };
  for (const content of [[{ type: 'text', text: 'IMAGE_TEXT' }, image], { _imageForNewMessage: true, imageBlock: image, credential: 'NEVER_LOG' }]) {
    const observed: any[] = [];
    let calls = 0;
    const runner = new ConversationRunner({ chat: async () => calls++ ? textResponse('done') : toolResponse } as any, {
      ...tools, executeTool: async () => ({ tool_call_id: 'call-1', role: 'tool', name: 'noop', content, ok: true }),
    } as any, { stream: false, onTranscript: event => observed.push(event) });
    await runner.run([{ role: 'user', content: 'synthetic image tool' }]);
    const event = observed.find(event => event.type === 'tool_finished');
    assert.match(event.attachments[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(event.attachments[0].media_type, 'image/png');
    assert.ok(!JSON.stringify(observed).includes('c2VjcmV0LWltYWdl'));
    assert.ok(!JSON.stringify(observed).includes('NEVER_LOG'));
  }
});
