import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MemoryLogStore } from '../src/core/memory-log-store';
import {
  FinishMemorySearchTool,
  MemoryNeighborsTool,
  MemoryReadTurnTool,
  MemorySearchTool,
} from '../src/tools/memory-branch-tools';

describe('memory branch tools', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-memory-tools-'));
  });

  afterEach(() => {
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('search returns compact canonical refs from turn entries only', async () => {
    writeSessionLog(testRoot, [
      turn(1, '2026-06-16T10:00:00.000Z', 'alpha_unique first episode', 'nothing yet'),
      {
        entry_type: 'runtime',
        timestamp: '2026-06-16T10:05:00.000Z',
        session_id: 'chat:demo',
        session_type: 'chat',
        level: 'info',
        message: 'alpha_unique runtime should be ignored',
      },
      turn(2, '2026-06-16T11:00:00.000Z', 'second user', 'alpha_unique beta_unique final'),
    ]);
    writeDataSessionLog(testRoot, [turn(1, '2026-06-16T12:00:00.000Z', 'alpha_unique data source', 'ignored')]);
    writeBranchLog(testRoot, 'alpha_unique branch source should be ignored');

    const store = new MemoryLogStore(testRoot);
    const tool = new MemorySearchTool(store);
    const result = await tool.execute({
      keywords: ['alpha_unique', 'beta_unique'],
      start_time: '2026-06-16T00:00:00.000Z',
      end_time: '2026-06-16T23:59:59.999Z',
      limit: 80,
    }, { workingDirectory: testRoot, conversationHistory: [] });

    assert.equal(result.ok, true);
    const parsed = JSON.parse(String(result.content));
    assert.equal(parsed.count, 2);
    assert.deepEqual(parsed.matches, [
      { ref: 'chat/2026-06-16/demo.jsonl#2', hits: ['alpha_unique', 'beta_unique'] },
      { ref: 'chat/2026-06-16/demo.jsonl#1', hits: ['alpha_unique'] },
    ]);
    assert.equal('preview' in parsed.matches[0], false);
    assert.equal('score' in parsed.matches[0], false);
  });

  test('read and neighbors accept manually edited adjacent refs', async () => {
    writeSessionLog(testRoot, [
      turn(1, '2026-06-16T10:00:00.000Z', 'episode one manual_neighbor_unique', 'first answer'),
      turn(2, '2026-06-16T11:00:00.000Z', 'episode two', 'second answer'),
      turn(3, '2026-06-16T12:00:00.000Z', 'episode three', 'third answer'),
    ]);

    const store = new MemoryLogStore(testRoot);
    const readTool = new MemoryReadTurnTool(store);
    const read = await readTool.execute({
      ref: 'chat/2026-06-16/demo.jsonl#2',
      budget_chars: 2000,
    }, { workingDirectory: testRoot, conversationHistory: [] });
    assert.equal(read.ok, true);
    const readJson = JSON.parse(String(read.content));
    assert.equal(readJson.ref, 'chat/2026-06-16/demo.jsonl#2');
    assert.match(readJson.text, /USER:\nepisode two/);

    const manualAdjacent = await readTool.execute({
      ref: 'chat/2026-06-16/demo.jsonl#1',
      budget_chars: 2000,
    }, { workingDirectory: testRoot, conversationHistory: [] });
    assert.equal(manualAdjacent.ok, true);
    assert.match(JSON.parse(String(manualAdjacent.content)).text, /manual_neighbor_unique/);

    const neighborsTool = new MemoryNeighborsTool(store);
    const neighbors = await neighborsTool.execute({
      ref: 'chat/2026-06-16/demo.jsonl#2',
      previous: 1,
      next: 1,
      budget_chars: 6000,
    }, { workingDirectory: testRoot, conversationHistory: [] });
    assert.equal(neighbors.ok, true);
    const neighborsJson = JSON.parse(String(neighbors.content));
    assert.deepEqual(
      neighborsJson.turns.map((item: any) => item.ref),
      [
        'chat/2026-06-16/demo.jsonl#1',
        'chat/2026-06-16/demo.jsonl#2',
        'chat/2026-06-16/demo.jsonl#3',
      ],
    );
  });

  test('finish validates canonical refs and has pause control mode', async () => {
    let captured: any = null;
    const tool = new FinishMemorySearchTool(payload => {
      captured = payload;
    });

    assert.equal(tool.definition.controlMode, 'pause_turn');

    const invalid = await tool.execute({
      summary: 'done',
      refs: ['m1'],
    }, { workingDirectory: testRoot, conversationHistory: [] });
    assert.equal(invalid.ok, false);
    assert.match(JSON.parse(String(invalid.message)).error, /invalid canonical ref/);

    const emptyDefaultInject = await tool.execute({
      summary: 'No useful memory.',
      refs: [],
    }, { workingDirectory: testRoot, conversationHistory: [] });
    assert.equal(emptyDefaultInject.ok, false);
    assert.match(JSON.parse(String(emptyDefaultInject.message)).error, /unless inject is false/);

    const valid = await tool.execute({
      summary: 'Prior decision found.',
      refs: ['chat/2026-06-16/demo.jsonl#2', 'chat/2026-06-16/demo.jsonl#2'],
    }, { workingDirectory: testRoot, conversationHistory: [] });
    assert.equal(valid.ok, true);
    assert.deepEqual(captured, {
      summary: 'Prior decision found.',
      refs: ['chat/2026-06-16/demo.jsonl#2'],
      inject: true,
    });
    assert.deepEqual(JSON.parse(String(valid.content)), { ok: true });

    const suppressed = await tool.execute({
      summary: 'No extra memory worth injecting.',
      refs: [],
      inject: false,
    }, { workingDirectory: testRoot, conversationHistory: [] });
    assert.equal(suppressed.ok, true);
    assert.deepEqual(captured, {
      summary: 'No extra memory worth injecting.',
      refs: [],
      inject: false,
    });

    const contradictory = await tool.execute({
      summary: 'Found something but asked not to inject.',
      refs: ['chat/2026-06-16/demo.jsonl#2'],
      inject: false,
    }, { workingDirectory: testRoot, conversationHistory: [] });
    assert.equal(contradictory.ok, false);
    assert.match(JSON.parse(String(contradictory.message)).error, /refs must be empty/);
  });

  test('read applies field-level truncation for oversized single episodes', async () => {
    writeSessionLog(testRoot, [
      turn(1, '2026-06-16T10:00:00.000Z', 'short user', 'x'.repeat(5000)),
    ]);

    const store = new MemoryLogStore(testRoot);
    const tool = new MemoryReadTurnTool(store);
    const result = await tool.execute({
      ref: 'chat/2026-06-16/demo.jsonl#1',
      budget_chars: 400,
    }, { workingDirectory: testRoot, conversationHistory: [] });

    assert.equal(result.ok, true);
    const parsed = JSON.parse(String(result.content));
    assert.equal(parsed.truncated, true);
    assert.match(parsed.text, /truncated field/);
  });

  test('read strips DeepSeek replay summary artifacts from historical assistant text', async () => {
    const leakedReplay = [
      '先给你做个小游戏。',
      '',
      '[历史工具调用已转为摘要：DeepSeek thinking replay 缓存缺失，工具=write_file，id=call_function_1，参数={"content":"<!DOCTYPE html>',
      '<html>',
      '<script>',
      'const levels = [1, 2, 3];',
      '</script>',
      '</html>","file_path":"E:\\\\tmp\\\\flappy.html"}]',
    ].join('\n');
    writeSessionLog(testRoot, [
      turn(1, '2026-06-16T10:00:00.000Z', '写个游戏', leakedReplay),
    ]);

    const store = new MemoryLogStore(testRoot);
    const readTool = new MemoryReadTurnTool(store);
    const result = await readTool.execute({
      ref: 'chat/2026-06-16/demo.jsonl#1',
      budget_chars: 4000,
    }, { workingDirectory: testRoot, conversationHistory: [] });

    assert.equal(result.ok, true);
    const parsed = JSON.parse(String(result.content));
    assert.match(parsed.text, /ASSISTANT_FINAL:\n先给你做个小游戏。/);
    assert.doesNotMatch(parsed.text, /DeepSeek thinking replay|DOCTYPE html|flappy\.html/);

    const searchTool = new MemorySearchTool(store);
    const search = await searchTool.execute({
      keywords: ['flappy.html'],
      start_time: '2026-06-16T00:00:00.000Z',
      end_time: '2026-06-16T23:59:59.999Z',
    }, { workingDirectory: testRoot, conversationHistory: [] });
    assert.equal(search.ok, true);
    assert.deepEqual(JSON.parse(String(search.content)).matches, []);
  });
});

function writeSessionLog(root: string, entries: unknown[]): void {
  const dir = path.join(root, 'logs', 'sessions', 'chat', '2026-06-16');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'demo.jsonl'),
    entries.map(entry => JSON.stringify(entry)).join('\n') + '\n',
    'utf-8',
  );
}

function writeDataSessionLog(root: string, entries: unknown[]): void {
  const dir = path.join(root, 'data', 'sessions', 'chat', '2026-06-16');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'demo.jsonl'),
    entries.map(entry => JSON.stringify(entry)).join('\n') + '\n',
    'utf-8',
  );
}

function writeBranchLog(root: string, message: string): void {
  const dir = path.join(root, 'logs', 'branches', 'memory', '2026-06-16');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'branch.jsonl'),
    JSON.stringify({ entry_type: 'branch', message }) + '\n',
    'utf-8',
  );
}

function turn(turnNumber: number, timestamp: string, userText: string, assistantText: string) {
  return {
    entry_type: 'turn',
    turn: turnNumber,
    timestamp,
    session_id: 'chat:demo',
    session_type: 'chat',
    user: { text: userText },
    assistant: {
      text: assistantText,
      tool_calls: [],
    },
    tokens: {
      prompt: 1,
      completion: 1,
    },
  };
}
