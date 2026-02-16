import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import { GlobTool } from '../src/tools/glob-tool';
import { GrepTool } from '../src/tools/grep-tool';

function buildContext(workdir: string, sessionId = 'test-session') {
  return {
    workingDirectory: workdir,
    conversationHistory: [],
    sessionId,
  };
}

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

