import { describe, test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { ShellTool, buildTimeoutWatchdogScript, normalizeShellTimeout, MAX_SHELL_TIMEOUT_MS } from '../src/tools/bash-tool';
import { ToolExecutionContext } from '../src/types/tool';
import { clearActiveCommandsForTest, listActiveCommands } from '../src/utils/active-commands';
import {
  __resetMachineResourceCacheForTest,
  readPosixProcessStartTime,
  setMachineResourceSnapshotForTest,
} from '../src/utils/machine-resources';

const POSIX_ONLY = { skip: process.platform === 'win32' } as const;
const LINUX_ONLY = { skip: process.platform !== 'linux' } as const;

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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(proc: ChildProcess, ms: number): Promise<boolean> {
  return new Promise(resolve => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), ms);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await delay(100);
  }
  return undefined;
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
    __resetMachineResourceCacheForTest();
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('normalizes hostile timeout values and caps at the ceiling', () => {
    assert.equal(normalizeShellTimeout(undefined), 30_000);
    assert.equal(normalizeShellTimeout(Number.NaN), 30_000);
    assert.equal(normalizeShellTimeout(0), 30_000);
    assert.equal(normalizeShellTimeout(-5), 30_000);
    assert.equal(normalizeShellTimeout('5000'), 5000);
    assert.equal(normalizeShellTimeout(2000.9), 2000);
    assert.equal(normalizeShellTimeout(true), 30_000);
    assert.equal(normalizeShellTimeout(''), 30_000);
    assert.equal(normalizeShellTimeout(10 ** 12), MAX_SHELL_TIMEOUT_MS);
  });

  test('bounds a free-form description before it reaches the shared registry', async () => {
    const tool = new ShellTool();
    const description = `${'很长的命令说明'.repeat(16)}\n第二行不应出现`;
    // PowerShell needs the call operator for a quoted executable path; POSIX
    // shells take the quoted path directly.
    const command = process.platform === 'win32'
      ? `& "${process.execPath}" -e "setTimeout(() => {}, 2500)"`
      : `'${process.execPath}' -e "setTimeout(() => {}, 2500)"`;
    const pending = tool.execute({
      command,
      description,
      timeout: 30_000,
    }, context);

    const entry = await waitFor(() => listActiveCommands()[0], 6000);
    assert.ok(entry, 'command should register while it runs');
    assert.ok(!entry!.label.includes('\n'), 'label must stay single-line');
    assert.ok(!entry!.label.includes('第二行'), 'only the first line travels');
    assert.ok(entry!.label.length <= 80, `label must be bounded, got ${entry!.label.length}`);

    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(listActiveCommands().length, 0);

    // A short description keeps the actual command visible next to it.
    const second = tool.execute({
      command,
      description: 'probe-desc',
      timeout: 30_000,
    }, context);
    const entry2 = await waitFor(() => listActiveCommands()[0], 6000);
    assert.ok(entry2, 'second command should register');
    assert.ok(entry2!.label.includes('probe-desc'), 'description must travel with the label');
    assert.ok(entry2!.label.includes(' · '), 'description and command are composed');
    assert.ok(entry2!.label.includes('node'), 'the command must stay visible next to the description');
    const secondResult = await second;
    assert.equal(secondResult.ok, true);
  });

  test('watchdog never kills a recycled pgid (start-time guard)', LINUX_ONLY, async () => {
    const leader = spawn('sleep', ['654326'], { detached: true, stdio: 'ignore' });
    try {
      await delay(200);
      const leaderPid = leader.pid!;
      const startTime = readPosixProcessStartTime(leaderPid);
      assert.ok(startTime !== undefined, 'live leader must expose a start time');

      // A recycled pgid shows up with a different leader start time: skip.
      const wrong = spawn('/bin/sh', ['-c', buildTimeoutWatchdogScript(leaderPid, 1, startTime! + 99_999)], { stdio: 'ignore' });
      assert.equal(await waitForExit(wrong, 4000), true);
      assert.equal(processAlive(leaderPid), true, 'recycled-pgid guard must skip the kill');

      // Unverifiable leader (no recorded start time): skip as well.
      const unverifiable = spawn('/bin/sh', ['-c', buildTimeoutWatchdogScript(leaderPid, 1, undefined)], { stdio: 'ignore' });
      assert.equal(await waitForExit(unverifiable, 4000), true);
      assert.equal(processAlive(leaderPid), true, 'unverifiable guard must skip the kill');

      // Recorded start time matches the live leader: the group is ours — kill.
      const matching = spawn('/bin/sh', ['-c', buildTimeoutWatchdogScript(leaderPid, 1, startTime!)], { stdio: 'ignore' });
      assert.equal(await waitForExit(leader, 4000), true, 'matching guard must terminate the group');
      try { matching.kill('SIGKILL'); } catch { /* already gone */ }
    } finally {
      if (leader.pid) {
        try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  });

  test('watchdog reaps the group when the leader is already gone', POSIX_ONLY, async () => {
    const leader = spawn('setsid', ['sh', '-c', 'sleep 654329 &'], { stdio: 'ignore' });
    try {
      assert.equal(await waitForExit(leader, 4000), true, 'leader exits immediately');
      await delay(300);
      assert.equal(processCount('sleep 654329'), 1, 'member survives its leader');

      // Leader gone => /proc/<pgid>/stat is unreadable, the guard is skipped, and
      // the still-existing group (which cannot be a recycled pgid) is reaped.
      const script = spawn('/bin/sh', ['-c', buildTimeoutWatchdogScript(leader.pid!, 1, 12345)], { stdio: 'ignore' });
      const reaped = await waitFor(() => (processCount('sleep 654329') === 0 ? true : undefined), 8000);
      assert.equal(reaped, true, 'group with a dead leader must still be reaped');
      // Let the script finish its own TERM->KILL sequence on its own so no inner
      // sleep leaks into the sleep-count test that runs later.
      assert.equal(await waitForExit(script, 8000), true, 'watchdog script exits on its own');
    } finally {
      try { execSync("pkill -9 -f '65432[9]' 2>/dev/null || true"); } catch { /* best effort */ }
    }
  });

  test('captures a fast memory spike through the early RSS sample', LINUX_ONLY, async () => {
    setMachineResourceSnapshotForTest({
      platform: 'linux',
      cpuCount: 2,
      totalMemoryBytes: 1024 ** 3,
      availableMemoryBytes: 900 * 1024 ** 2,
      sampledAt: Date.now(),
    });
    const tool = new ShellTool();
    const command = `'${process.execPath}' -e "const b = Buffer.alloc(420 * 1024 * 1024, 1); console.log('balloon', b.length); setTimeout(() => {}, 3000)"`;
    const result = await tool.execute({ command, timeout: 30_000 }, context);
    assert.equal(result.ok, true);
    const report = String(result.content || result.message || '');
    assert.match(report, /resource_note:/);
    assert.match(report, /峰值 RSS [3-5]\d\dM/);
  });

  test('captures a memory spike that lands mid-run (2-5 s window)', LINUX_ONLY, async () => {
    setMachineResourceSnapshotForTest({
      platform: 'linux',
      cpuCount: 2,
      totalMemoryBytes: 1024 ** 3,
      availableMemoryBytes: 900 * 1024 ** 2,
      sampledAt: Date.now(),
    });
    const tool = new ShellTool();
    const command = `'${process.execPath}' -e "setTimeout(() => { global.b = Buffer.alloc(420 * 1024 * 1024, 1); }, 2500); setTimeout(() => {}, 4600)"`;
    const result = await tool.execute({ command, timeout: 30_000 }, context);
    assert.equal(result.ok, true);
    const report = String(result.content || result.message || '');
    assert.match(report, /resource_note:/);
    assert.match(report, /峰值 RSS [3-5]\d\dM/);
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

  test('finishes the TERM->KILL escalation even after the direct child exits', { ...POSIX_ONLY, timeout: 25_000 }, async () => {
    setMachineResourceSnapshotForTest({
      platform: 'linux',
      cpuCount: 2,
      totalMemoryBytes: 1024 ** 3,
      availableMemoryBytes: 100 * 1024 ** 2,
      sampledAt: Date.now(),
    });
    const tool = new ShellTool();
    try {
      // The wrapper exits on SIGTERM, but the background member ignores TERM and
      // keeps respawning sleeps in the same group — the OS-side escalation must
      // still reap it, and the failure result must carry a resource note.
      const result = await tool.execute({
        command: `sh -c 'trap "" TERM; while :; do sleep 654328; done' & sleep 654327`,
        timeout: 1500,
      }, context);
      assert.equal(result.ok, false);
      assert.match(result.message, /timed_out: true/);
      assert.match(result.message, /resource_note:/);

      await delay(6500);
      assert.equal(processCount('654328'), 0, 'TERM-immunized group member must be SIGKILLed by the escalation');
    } finally {
      try { execSync("pkill -9 -f '65432[8]' 2>/dev/null || true"); } catch { /* best effort */ }
    }
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
