import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import { EnterPlanModeTool } from '../src/tools/enter-plan-mode-tool';
import { ExitPlanModeTool } from '../src/tools/exit-plan-mode-tool';
import { PlanModeStore } from '../src/tools/plan-mode-store';
import { GlobTool } from '../src/tools/glob-tool';
import { GrepTool } from '../src/tools/grep-tool';

function buildContext(workdir: string, sessionId = 'test-session') {
  return {
    workingDirectory: workdir,
    conversationHistory: [],
    sessionId,
  };
}

test('enter_plan_mode blocks write path outside working directory', async () => {
  const workdir = path.join(os.tmpdir(), 'xiaoba-plan-workdir');
  const outside = path.join(os.tmpdir(), 'xiaoba-plan-outside', 'plan.md');
  const tool = new EnterPlanModeTool();

  const result = await tool.execute(
    { task_description: 'test', plan_file: outside },
    buildContext(workdir),
  );

  assert.match(result, /执行被阻止/);
});

test('exit_plan_mode blocks read path outside working directory', async () => {
  const workdir = path.join(os.tmpdir(), 'xiaoba-plan-workdir');
  const outside = path.join(os.tmpdir(), 'xiaoba-plan-outside', 'plan.md');
  const sessionId = 'plan-read-block';
  PlanModeStore.enter(sessionId, outside);

  const tool = new ExitPlanModeTool();
  const result = await tool.execute({}, buildContext(workdir, sessionId));

  assert.match(result, /执行被阻止/);
  PlanModeStore.exit(sessionId);
});

test('glob blocks read path outside working directory', async () => {
  const workdir = path.join(os.tmpdir(), 'xiaoba-glob-workdir');
  const outside = path.join(os.tmpdir(), 'xiaoba-glob-outside');
  const tool = new GlobTool();

  const result = await tool.execute(
    { pattern: '**/*', path: outside },
    buildContext(workdir),
  );

  assert.match(result, /执行被阻止/);
});

test('grep blocks read path outside working directory', async () => {
  const workdir = path.join(os.tmpdir(), 'xiaoba-grep-workdir');
  const outside = path.join(os.tmpdir(), 'xiaoba-grep-outside');
  const tool = new GrepTool();

  const result = await tool.execute(
    { pattern: 'TODO', path: outside },
    buildContext(workdir),
  );

  assert.match(result, /执行被阻止/);
});

