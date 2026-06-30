import { describe, test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EditTool } from '../src/tools/edit-tool';
import type { ToolExecutionContext, ToolExecutionResult } from '../src/types/tool';

function getFailure(result: ToolExecutionResult): Extract<ToolExecutionResult, { ok: false }> {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected edit_file to fail');
  return result;
}

describe('EditTool', () => {
  let tool: EditTool;
  let testRoot: string;
  let context: ToolExecutionContext;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-tool-'));
    tool = new EditTool();
    context = {
      workingDirectory: testRoot,
      sessionId: 'edit-tool-test',
      surface: 'cli',
    };
  });

  afterEach(() => {
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('edits a unique string in a text file', async () => {
    const filePath = path.join(testRoot, 'sample.txt');
    fs.writeFileSync(filePath, 'hello world', 'utf8');

    const result = await tool.execute({
      file_path: filePath,
      old_string: 'world',
      new_string: 'XiaoBa',
    }, context);

    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'hello XiaoBa');
  });

  test('rejects missing new_string without writing undefined', async () => {
    const filePath = path.join(testRoot, 'missing-new.txt');
    fs.writeFileSync(filePath, 'hello world', 'utf8');

    const result = await tool.execute({
      file_path: filePath,
      old_string: 'world',
    }, context);

    const failure = getFailure(result);
    assert.equal(failure.errorCode, 'INVALID_TOOL_ARGUMENTS');
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'hello world');
  });

  test('rejects empty old_string without inserting between characters', async () => {
    const filePath = path.join(testRoot, 'empty-old.txt');
    fs.writeFileSync(filePath, 'abc', 'utf8');

    const result = await tool.execute({
      file_path: filePath,
      old_string: '',
      new_string: 'X',
      replace_all: true,
    }, context);

    const failure = getFailure(result);
    assert.equal(failure.errorCode, 'INVALID_TOOL_ARGUMENTS');
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'abc');
  });

  test('rejects directory paths instead of throwing', async () => {
    const result = await tool.execute({
      file_path: testRoot,
      old_string: 'a',
      new_string: 'b',
    }, context);

    const failure = getFailure(result);
    assert.equal(failure.errorCode, 'TOOL_EXECUTION_ERROR');
    assert.match(failure.message, /不是文件|not a file/);
  });

  test('rejects likely binary files without modifying bytes', async () => {
    const filePath = path.join(testRoot, 'image.png');
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    fs.writeFileSync(filePath, original);

    const result = await tool.execute({
      file_path: filePath,
      old_string: 'PNG',
      new_string: 'TXT',
    }, context);

    const failure = getFailure(result);
    assert.equal(failure.errorCode, 'TOOL_EXECUTION_ERROR');
    assert.deepEqual(fs.readFileSync(filePath), original);
  });

  test('rejects oversized text files before reading them into the edit path', async () => {
    const filePath = path.join(testRoot, 'large.txt');
    fs.writeFileSync(filePath, Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));

    const result = await tool.execute({
      file_path: filePath,
      old_string: 'aaa',
      new_string: 'bbb',
    }, context);

    const failure = getFailure(result);
    assert.equal(failure.errorCode, 'TOOL_EXECUTION_ERROR');
    assert.match(failure.message, /文件过大|too large/);
  });
});
