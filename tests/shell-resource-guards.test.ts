import { describe, test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'node:child_process';
import { ShellTool } from '../src/tools/bash-tool';
import { ToolExecutionContext } from '../src/types/tool';
import { clearActiveCommandsForTest, listActiveCommands } from '../src/utils/active-commands';

const POSIX_ONLY = { skip: process.platform === 'win32' } as const;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Counts real processes matching the pattern. The first letter is bracketed so
 * the pattern never matches the wrapper shell or grep itself — only actual
 * process command lines (this exact pitfall caused a false leak report once).
 */
function processCount(pattern: string): number {
  const bracketed = pattern.replace(/^(\S)/, '[$1]');
  try {
    const output = execSync(`ps -eo args | grep '${bracketed}'`).toString().trim();
    return output ? output.split('\n').length : 0;
  } catch {
    return 0;
  }
}

function sleepProcessCount(): number {
  try {
    const output = execSync(`ps -eo comm | awk '$1 == "sleep"' | wc -l`).toString().trim();
    return Number.parseInt(output, 10) || 0;
  } catch {
    return 0;
  }
}

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

  test('registers the running command in the global registry while it runs', POSIX_ONLY, async () => {
    const tool = new ShellTool();
    const pending = tool.execute({ command: 'sleep 2', timeout: 15_000 }, context);
    await delay(400);

    const running = listActiveCommands();
    assert.equal(running.length, 1);
    assert.ok(running[0].label.includes('sleep 2'));

    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(listActiveCommands().length, 0);
  });

  test('leaves no watchdog sleep behind after a fast command', POSIX_ONLY, async () => {
    const tool = new ShellTool();
    const before = sleepProcessCount();
    const result = await tool.execute({ command: 'echo quick-command', timeout: 30_000 }, context);
    assert.equal(result.ok, true);
    await delay(400);
    assert.equal(sleepProcessCount(), before, 'no stray watchdog sleep processes allowed');
  });

  test('kills the whole process group when the deadline is hit', POSIX_ONLY, async () => {
    const tool = new ShellTool();
    const started = Date.now();
    const result = await tool.execute({ command: 'sleep 654320', timeout: 1500 }, context);
    const elapsed = Date.now() - started;

    assert.equal(result.ok, false);
    assert.match(result.message, /timed_out: true/);
    assert.ok(elapsed < 15_000, `timeout guard should fire promptly, took ${elapsed}ms`);
    assert.equal(listActiveCommands().length, 0);
    await delay(500);
    assert.equal(processCount('sleep 654320'), 0, 'timed-out command must leave no processes behind');
  });

  test('kills background children of a timed-out command', POSIX_ONLY, async () => {
    const tool = new ShellTool();
    const result = await tool.execute({ command: 'sleep 654321 & wait', timeout: 1500 }, context);
    assert.equal(result.ok, false);
    await delay(500);
    assert.equal(processCount('sleep 654321'), 0, 'background child must die with the process group');
  });

  test('terminates the process group when stdout overflows maxBuffer', POSIX_ONLY, async () => {
    const tool = new ShellTool();
    const result = await tool.execute({
      command: 'head -c 11000000 /dev/zero | tr "\\0" a; sleep 654322',
      timeout: 30_000,
    }, context);

    assert.equal(result.ok, false);
    assert.match(result.message, /maxBuffer/);
    assert.equal(listActiveCommands().length, 0);
    await delay(800);
    assert.equal(processCount('sleep 654322'), 0, 'overflowing command must not be left running');
  });

  test('abort terminates the process group', POSIX_ONLY, async () => {
    const tool = new ShellTool();
    const controller = new AbortController();
    const pending = tool.execute({ command: 'sleep 654323', timeout: 30_000 }, {
      ...context,
      abortSignal: controller.signal,
    });
    await delay(400);
    controller.abort();
    const result = await pending;

    assert.equal(result.ok, false);
    assert.match(result.message, /status: aborted/);
    assert.equal(listActiveCommands().length, 0);
    await delay(800);
    assert.equal(processCount('sleep 654323'), 0, 'aborted command must leave no processes behind');
  });

  test('enforces the deadline while the event loop is starved', POSIX_ONLY, async () => {
    const tool = new ShellTool();
    const pending = tool.execute({ command: 'sleep 654324', timeout: 1500 }, context);
    await delay(300);

    const spinUntil = Date.now() + 6000;
    while (Date.now() < spinUntil) {
      // Deliberately block the event loop; the OS-side watchdog must still kill the command.
    }

    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.message, /timed_out: true/);
    assert.equal(listActiveCommands().length, 0);
    assert.equal(processCount('sleep 654324'), 0);
  });
});
