import { describe, test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ShellTool } from '../src/tools/bash-tool';
import { ToolExecutionContext } from '../src/types/tool';
import { clearActiveCommandsForTest, listActiveCommands } from '../src/utils/active-commands';

describe('ShellTool resource guards', () => {
  let testRoot: string;
  let context: ToolExecutionContext;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-shell-guard-'));
    context = {
      workingDirectory: testRoot,
      workspaceRoot: testRoot,
      conversationHistory: [],
      getCurrentDirectory: () => testRoot,
      updateCurrentDirectory: () => {},
    };
  });

  afterEach(() => {
    clearActiveCommandsForTest();
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('registers the running command in the global registry while it runs', {
    skip: process.platform === 'win32',
  }, async () => {
    const tool = new ShellTool();
    const pending = tool.execute({ command: 'sleep 2', timeout: 15_000 }, context);
    await new Promise(resolve => setTimeout(resolve, 400));

    const running = listActiveCommands();
    assert.equal(running.length, 1);
    assert.ok(running[0].label.includes('sleep 2'));

    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(listActiveCommands().length, 0);
  });

  test('kills the whole process group when the deadline is hit', {
    skip: process.platform === 'win32',
  }, async () => {
    const tool = new ShellTool();
    const started = Date.now();
    const result = await tool.execute({ command: 'sleep 30', timeout: 1500 }, context);
    const elapsed = Date.now() - started;

    assert.equal(result.ok, false);
    assert.match(result.message, /timed_out: true/);
    assert.ok(elapsed < 15_000, `timeout guard should fire promptly, took ${elapsed}ms`);
    assert.equal(listActiveCommands().length, 0);
  });
});
