import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CodingAgentAdapter,
  ExternalAgentRegistry,
  ProcessRunner,
  resolveExternalAgentTaskDirectory,
  serializeTaskPacket,
  TaskPacket,
} from '../src/runtime/external-agent';

let testRoot: string;

describe('external agent orchestration primitives', () => {
  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-external-agent-'));
  });

  afterEach(() => {
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('registry exposes descriptors and rejects duplicate ids', () => {
    const registry = new ExternalAgentRegistry();
    const agent = new CodingAgentAdapter({
      id: 'codex-local',
      kind: 'codex',
      displayName: 'Codex Local',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
    });

    registry.register(agent);

    assert.deepStrictEqual(registry.list(), [{
      id: 'codex-local',
      kind: 'codex',
      displayName: 'Codex Local',
      enabled: true,
      capabilities: ['coding-task'],
    }]);
    assert.equal(registry.require('codex-local'), agent);
    assert.throws(() => registry.register(agent), /already registered/);
    assert.throws(() => registry.require('missing'), /not found/);
  });

  test('task packets default to an isolated external-agent task directory', () => {
    const task = makeTask('phase g/demo task');
    const taskDirectory = resolveExternalAgentTaskDirectory(task);

    assert.equal(
      taskDirectory,
      path.join(testRoot, '.xiaoba/external-agents/phase-g-demo-task'),
    );

    const serialized = JSON.parse(serializeTaskPacket(task));
    assert.equal(serialized.workingDirectory, taskDirectory);
    assert.deepStrictEqual(serialized.requiredTests, ['npm run build']);
  });

  test('task packet workingDirectory override is explicit caller-owned execution context', () => {
    const customDirectory = path.join(testRoot, 'caller-owned-dir');
    const task = {
      ...makeTask('custom-dir'),
      workingDirectory: customDirectory,
    };

    assert.equal(resolveExternalAgentTaskDirectory(task), customDirectory);
    assert.equal(JSON.parse(serializeTaskPacket(task)).workingDirectory, customDirectory);
  });

  test('process runner executes without shell and captures stdin/stdout', async () => {
    const runner = new ProcessRunner();
    const result = await runner.run({
      command: process.execPath,
      args: ['-e', 'let input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>console.log(JSON.parse(input).goal));'],
      cwd: testRoot,
      input: JSON.stringify({ goal: 'echo-goal' }),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), 'echo-goal');
    assert.equal(result.stderr, '');
    assert.equal(result.timedOut, false);
  });

  test('coding adapter sends task packet through stdin and runs in isolated task directory', async () => {
    const adapter = new CodingAgentAdapter({
      id: 'opencode-local',
      kind: 'opencode',
      displayName: 'OpenCode Local',
      command: process.execPath,
      args: [
        '-e',
        [
          'let input="";',
          'process.stdin.on("data",c=>input+=c);',
          'process.stdin.on("end",()=>{',
          'const task=JSON.parse(input);',
          'const normalizedCwd = process.cwd().replace(/\\\\/g,"/");',
          'console.log([task.id,task.goal,normalizedCwd.endsWith(".xiaoba/external-agents/phase-g")].join("|"));',
          '});',
        ].join(''),
      ],
    });

    const result = await adapter.runTask(makeTask('phase-g'));

    assert.equal(result.ok, true);
    assert.equal(result.taskId, 'phase-g');
    assert.equal(result.agentId, 'opencode-local');
    assert.equal(result.stdout.trim(), 'phase-g|Keep orchestration out of the main runtime|true');
    assert.equal(fs.existsSync(result.workingDirectory), true);
  });

  test('coding adapter rejects disabled agents before starting a process', async () => {
    const adapter = new CodingAgentAdapter({
      id: 'disabled-agent',
      kind: 'custom',
      displayName: 'Disabled Agent',
      enabled: false,
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
    });

    await assert.rejects(() => adapter.runTask(makeTask('disabled')), /disabled/);
  });

  test('coding adapter returns non-zero exits as failed results', async () => {
    const adapter = new CodingAgentAdapter({
      id: 'failing-agent',
      kind: 'custom',
      displayName: 'Failing Agent',
      command: process.execPath,
      args: ['-e', 'console.error("failed intentionally");process.exit(7)'],
    });

    const result = await adapter.runTask(makeTask('failure'));

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 7);
    assert.match(result.stderr, /failed intentionally/);
  });

  test('process runner reports timed out tasks', async () => {
    const runner = new ProcessRunner();
    const result = await runner.run({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 1000)'],
      cwd: testRoot,
      timeoutMs: 20,
    });

    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    assert.equal(result.signal, 'SIGTERM');
  });
});

function makeTask(id: string): TaskPacket {
  return {
    id,
    goal: 'Keep orchestration out of the main runtime',
    repositoryRoot: testRoot,
    instructions: 'Do not edit the main runtime path in this spike.',
    expectedOutputs: ['summary'],
    requiredTests: ['npm run build'],
  };
}
