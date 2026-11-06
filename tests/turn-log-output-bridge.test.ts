import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

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

test('ordinary turn log captures bounded outputs with model-call origin and stable body hashes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catslog-output-'));
  process.env.XIAOBA_USER_DATA_DIR = root;
  const { SessionTurnLogger } = await import('../src/utils/session-turn-logger');
  const { TurnLogRecorder } = await import('../src/core/turn-log-recorder');
  const sessionId = 'output-bridge-test';
  const logger = new SessionTurnLogger('bridge', sessionId);
  const recorder = new TurnLogRecorder(logger);
  const args = '{"quote":"\\\"","html":"<tag>","unicode":"雪"}';
  const message = (modelCallId: string, content: string) => ({
    role: 'assistant', content,
    __executionNodeRef: `session:${sessionId}:episode:episode-1:model-call:${modelCallId}:output:0`,
    __executionSourceSessionId: sessionId,
    __executionSourceEpisodeId: 'episode-1',
    __executionSourceModelCallId: modelCallId,
    tool_calls: [
      { id: 'reused-id', function: { name: 'search', arguments: args } },
      { id: 'parallel-id', function: { name: 'lookup', arguments: '{"n":2}' } },
    ],
  });
  recorder.recordTurn({
    userInput: 'query', tokens: { prompt: 1, completion: 2 },
    result: { response: '雪 <done>', newMessages: [message('call-a', '雪 <done>'), message('call-b', 'second')] } as any,
  });

  const date = new Date();
  const dateDir = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const logPath = join(root, 'logs', 'sessions', 'bridge', dateDir, `bridge_${sessionId}.jsonl`);
  const entry = JSON.parse(readFileSync(logPath, 'utf8').trim().split('\n').at(-1)!);
  assert.equal(entry.assistant.outputs_contract, 'session-output/1');
  assert.equal(entry.assistant.outputs_complete, true);
  assert.equal(entry.assistant.outputs.length, 6);
  const outputs = entry.assistant.outputs;
  assert.deepEqual(outputs.map((output: any) => [output.model_call_id, output.output_position]), [
    ['call-a', 0], ['call-a', 1], ['call-a', 2], ['call-b', 0], ['call-b', 1], ['call-b', 2],
  ]);
  assert.equal(outputs[0].body_sha256, toolHash('reused-id', 'search', args));
  assert.equal(outputs[0].body, args);
  assert.equal(outputs[2].body_sha256, createHash('sha256').update('雪 <done>', 'utf8').digest('hex'));
  assert.equal(outputs[0].ref, outputs[3].ref);
  assert.notEqual(outputs[0].model_call_id, outputs[3].model_call_id);
});
