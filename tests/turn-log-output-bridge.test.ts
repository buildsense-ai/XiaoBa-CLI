import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ConversationRunner } from '../src/core/conversation-runner';
import { TurnLogRecorder } from '../src/core/turn-log-recorder';
import { Logger } from '../src/utils/logger';
import { SessionTurnLogger } from '../src/utils/session-turn-logger';
import type { Message } from '../src/types';
import type { ToolCall, ToolDefinition, ToolExecutor, ToolResult } from '../src/types/tool';

const usage = { promptTokens: 4, completionTokens: 2, totalTokens: 6 };

function toolHash(id: string, name: string, args: string): string {
  const hash = createHash('sha256');
  for (const field of [id, name, args]) {
    const bytes = Buffer.from(field, 'utf8');
    const size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    hash.update(size).update(bytes);
  }
  return hash.digest('hex');
}

function setTestRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'catslog-output-'));
  process.env.XIAOBA_USER_DATA_DIR = root;
  return root;
}

async function captureOrdinaryTurn(sessionId: string, calls: Array<{ id: string; name: string; args: string }[]>, finalText: string) {
  const root = setTestRoot();
  const logger = new SessionTurnLogger('cli', sessionId);
  const recorder = new TurnLogRecorder(logger);
  const tool: ToolDefinition = { name: 'lookup', description: 'deterministic fixture', parameters: { type: 'object', properties: {} } };
  let providerCalls = 0;
  const ai = {
    chat: async () => {
      const batch = calls[providerCalls++];
      return batch
        ? { content: null, toolCalls: batch.map(call => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: call.args } })), usage }
        : { content: finalText, toolCalls: [], usage };
    },
  };
  const tools: ToolExecutor = {
    getToolDefinitions: () => [tool],
    executeTool: async (call: ToolCall): Promise<ToolResult> => ({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: 'ok', ok: true }),
  };
  const runner = new ConversationRunner(ai as any, tools, {
    stream: false,
    episodeId: 'episode-bridge',
    toolExecutionContext: { sessionId },
  });
  let result: any;
  await Logger.withSessionContext(sessionId, logger, async () => {
    result = await runner.run([{ role: 'user', content: 'run deterministic output fixture', __episodeId: 'episode-bridge', __episodeInputKind: 'root' }], {
      onExecutionGraphEvent: event => Logger.runtimeEvent('INFO', 'execution graph model call', { type: 'execution_graph', payload: event }),
    });
    recorder.recordTurn({ userInput: 'run deterministic output fixture', result, tokens: { prompt: usage.promptTokens, completion: usage.completionTokens } });
  });
  const entries = readFileSync(logger.getLogFilePath(), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  const turn = entries.find(entry => entry.entry_type === 'turn');
  const runtime = entries.filter(entry => entry.entry_type === 'runtime' && entry.event?.type === 'execution_graph').map(entry => entry.event.payload);
  const canonicalBytes = readFileSync(logger.getLogFilePath());
  const fullCapturePath = process.env.CATSLOG_OUTPUT_BRIDGE_FULL_LOG_PATH;
  if (fullCapturePath) writeFileSync(fullCapturePath, canonicalBytes, { mode: 0o600 });
  const capturePath = process.env.CATSLOG_OUTPUT_BRIDGE_CAPTURE_PATH;
  if (capturePath) writeFileSync(capturePath, `${JSON.stringify({ turn, runtime, canonical_log_path: fullCapturePath || null, canonical_log_sha256: createHash('sha256').update(canonicalBytes).digest('hex') }, null, 2)}\n`, { mode: 0o600 });
  return { root, turn, runtime, result };
}

test('ConversationRunner -> TurnLogRecorder -> SessionTurnLogger binds ordinary outputs to exact successful calls', async () => {
  const sessionId = `output-bridge-e2e-${randomUUID()}`;
  const args = '{"quote":"\\\"","html":"<tag>","unicode":"雪"}';
  const { turn, runtime, result } = await captureOrdinaryTurn(sessionId, [
    [{ id: 'reused-id', name: 'search', args }, { id: 'parallel-id', name: 'lookup', args: '{"n":2}' }],
    [{ id: 'reused-id', name: 'search', args: '{"second":true}' }],
  ], '雪 <done>');
  const outputs = turn.assistant.outputs;
  const outputCallIDs = new Set(outputs.map((output: any) => output.model_call_id));
  const calls = runtime.filter(event => event.type === 'successful_model_call' && outputCallIDs.has(event.model_call_id));
  assert.equal(outputCallIDs.size, 3);
  assert.equal(turn.assistant.outputs_contract, 'session-output/1');
  assert.equal(turn.assistant.outputs_complete, true);
  assert.equal(outputs.length, 4);
  for (const call of calls) {
    const descriptors = call.outputs;
    const outputRecords = outputs.filter((output: any) => output.model_call_id === call.model_call_id);
    assert.equal(outputRecords.length, descriptors.length);
    for (const descriptor of descriptors) {
      const record = outputRecords.find((output: any) => output.ref === descriptor.node_ref);
      assert.ok(record, `missing session output ${descriptor.node_ref}`);
      assert.equal(record.source_session_id, sessionId);
      assert.equal(record.episode_id, call.episode_id);
      assert.equal(record.model_call_id, call.model_call_id);
      assert.equal(record.output_position, descriptor.output_position);
      assert.equal(record.body_sha256, descriptor.body_sha256);
    }
  }
  const first = outputs.find((output: any) => output.ref === 'provider-call:reused-id');
  assert.equal(first.body, args);
  assert.equal(first.body_sha256, toolHash('reused-id', 'search', args));
  const repeated = outputs.filter((output: any) => output.ref === 'provider-call:reused-id');
  assert.equal(repeated.length, 2);
  assert.notEqual(repeated[0].model_call_id, repeated[1].model_call_id);
  const text = outputs.find((output: any) => output.kind === 'message');
  assert.equal(text.body_sha256, createHash('sha256').update('雪 <done>', 'utf8').digest('hex'));
  const textDescriptor = calls.at(-1)!.outputs[0];
  assert.equal(textDescriptor.content_sha256, createHash('sha256').update(JSON.stringify('雪 <done>')).digest('hex'));
  assert.notEqual(textDescriptor.content_sha256, text.body_sha256);
  assert.equal(result.response, '雪 <done>');
});

test('missing/foreign origin, unsupported content, and overbound output are explicitly incomplete', async () => {
  const root = setTestRoot();
  const sessionId = `bounded-output-${randomUUID()}`;
  const logger = new SessionTurnLogger('cli', sessionId);
  const recorder = new TurnLogRecorder(logger);
  const assistant = (extra: Record<string, unknown>) => ({ role: 'assistant', content: 'ordinary', ...extra });
  recorder.recordTurn({ userInput: 'x', tokens: { prompt: 1, completion: 1 }, result: { response: 'x', newMessages: [assistant({})] } as any });
  recorder.recordTurn({ userInput: 'x', tokens: { prompt: 1, completion: 1 }, result: { response: 'x', newMessages: [assistant({ __executionSourceSessionId: 'foreign', __executionSourceEpisodeId: 'e', __executionSourceModelCallId: 'm' })] } as any });
  recorder.recordTurn({ userInput: 'x', tokens: { prompt: 1, completion: 1 }, result: { response: 'x', newMessages: [assistant({ __executionSourceSessionId: sessionId, __executionSourceEpisodeId: 'e', __executionSourceModelCallId: 'm', content: [{ type: 'text', text: 'unsupported' }] })] } as any });
  recorder.recordTurn({ userInput: 'x', tokens: { prompt: 1, completion: 1 }, result: { response: 'x', newMessages: [assistant({ __executionSourceSessionId: sessionId, __executionSourceEpisodeId: 'e', __executionSourceModelCallId: 'm', __executionNodeRef: 'session:bounded:output:0', content: 'x'.repeat(17 * 1024) })] } as any });
  const file = readFileSync(logger.getLogFilePath(), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)).filter(entry => entry.entry_type === 'turn');
  assert.equal(file.length, 4);
  for (const entry of file) assert.equal(entry.assistant.outputs_complete, false);
  assert.ok(file[0].assistant.outputs_omission_reasons.includes('missing_origin'));
  assert.ok(file[1].assistant.outputs_omission_reasons.includes('foreign_session_origin'));
  assert.ok(file[2].assistant.outputs_omission_reasons.includes('unsupported_multiblock_content'));
  assert.ok(file[3].assistant.outputs_omission_reasons.includes('body_byte_limit'));
  assert.ok(root.startsWith(tmpdir()));
});

test('output count and invalid UTF-16 boundaries fail closed with omission reasons', async () => {
  setTestRoot();
  const sessionId = `bounded-count-${randomUUID()}`;
  const logger = new SessionTurnLogger('cli', sessionId);
  const recorder = new TurnLogRecorder(logger);
  const toolCalls = Array.from({ length: 129 }, (_, index) => ({ id: `call-${index}`, function: { name: 'lookup', arguments: '{}' } }));
  recorder.recordTurn({ userInput: 'x', tokens: { prompt: 1, completion: 1 }, result: { response: 'x', newMessages: [{
    role: 'assistant', content: 'ok', tool_calls: toolCalls,
    __executionNodeRef: 'session:bounded-count:output:129', __executionSourceSessionId: sessionId,
    __executionSourceEpisodeId: 'e', __executionSourceModelCallId: 'm',
  }] } as any });
  recorder.recordTurn({ userInput: 'x', tokens: { prompt: 1, completion: 1 }, result: { response: 'x', newMessages: [{
    role: 'assistant', content: '\ud800', __executionNodeRef: 'session:bounded-count:output:0',
    __executionSourceSessionId: sessionId, __executionSourceEpisodeId: 'e', __executionSourceModelCallId: 'm2',
  }] } as any });
  const entries = readFileSync(logger.getLogFilePath(), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(entries[0].assistant.outputs_complete, false);
  assert.ok(entries[0].assistant.outputs_omission_reasons.includes('output_count_limit'));
  assert.equal(entries[0].assistant.outputs.length, 128);
  assert.equal(entries[1].assistant.outputs_complete, false);
  assert.ok(entries[1].assistant.outputs_omission_reasons.includes('invalid_utf8_body'));
});
