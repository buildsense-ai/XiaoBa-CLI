import { describe, test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ShellTool } from '../src/tools/bash-tool';
import { ToolExecutionContext } from '../src/types/tool';

describe('ShellTool current directory probe', () => {
  let testRoot: string;
  let currentDirectory: string;
  let context: ToolExecutionContext;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-shell-cwd-'));
    fs.mkdirSync(path.join(testRoot, 'sub'));
    currentDirectory = testRoot;
    context = {
      workingDirectory: testRoot,
      workspaceRoot: testRoot,
      conversationHistory: [],
      getCurrentDirectory: () => currentDirectory,
      updateCurrentDirectory: directory => {
        currentDirectory = directory;
      },
    };
  });

  afterEach(() => {
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('successful cd updates session current directory without exposing probe marker', async () => {
    const tool = new ShellTool();
    const result = await tool.execute({ command: 'cd sub' }, {
      ...context,
      workingDirectory: currentDirectory,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(currentDirectory, path.join(testRoot, 'sub'));
    assert.ok(!(result.content as string).includes('__XIAOBA_CWD_MARKER__'));
  });

  test('successful cd at the start of a compound command persists the final directory', async () => {
    const tool = new ShellTool();
    const command = process.platform === 'win32'
      ? 'Set-Location sub; Write-Output ok'
      : 'cd sub && echo ok';
    const result = await tool.execute({ command }, {
      ...context,
      workingDirectory: currentDirectory,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(currentDirectory, path.join(testRoot, 'sub'));
    assert.ok((result.content as string).includes('ok'));
    assert.ok(!(result.content as string).includes('__XIAOBA_CWD_MARKER__'));
  });

  test('failed cd does not update session current directory', async () => {
    const tool = new ShellTool();
    const result = await tool.execute({ command: 'cd missing-directory' }, {
      ...context,
      workingDirectory: currentDirectory,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(currentDirectory, testRoot);
    assert.ok(!result.message.includes('__XIAOBA_CWD_MARKER__'));
  });

  test('successful cd is persisted even when a later command fails', async () => {
    const tool = new ShellTool();
    const failingCommand = process.platform === 'win32'
      ? 'Set-Location sub; definitely_missing_xiaoba_command'
      : 'cd sub && definitely_missing_xiaoba_command';
    const result = await tool.execute({ command: failingCommand }, {
      ...context,
      workingDirectory: currentDirectory,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(currentDirectory, path.join(testRoot, 'sub'));
    assert.ok(!result.message.includes('__XIAOBA_CWD_MARKER__'));
  });

  test('Windows PowerShell command output is decoded as UTF-8', {
    skip: process.platform !== 'win32',
  }, async () => {
    const tool = new ShellTool();
    const result = await tool.execute({ command: 'Write-Output "\u4e2d\u6587\u8f93\u51fa"' }, {
      ...context,
      workingDirectory: currentDirectory,
    });

    assert.strictEqual(result.ok, true);
    assert.ok((result.content as string).includes('\u4e2d\u6587\u8f93\u51fa'));
  });

  test('Windows PowerShell lists names without cmd banner or prompt pollution', {
    skip: process.platform !== 'win32',
  }, async () => {
    fs.writeFileSync(path.join(testRoot, 'visible-file.txt'), 'ok');
    const tool = new ShellTool();
    const result = await tool.execute({ command: 'Get-ChildItem -Name' }, {
      ...context,
      workingDirectory: currentDirectory,
    });

    assert.strictEqual(result.ok, true);
    assert.ok((result.content as string).includes('visible-file.txt'));
    assert.ok(!(result.content as string).includes('Microsoft Windows'));
    assert.ok(!(result.content as string).includes('__XIAOBA_CWD_MARKER__'));
  });

  test('Windows PowerShell cwd survives prompt changes', {
    skip: process.platform !== 'win32',
  }, async () => {
    const tool = new ShellTool();
    const result = await tool.execute({ command: 'Set-Location sub; function prompt { "USER> " }; Write-Output visible-output' }, {
      ...context,
      workingDirectory: currentDirectory,
    });

    assert.strictEqual(result.ok, true);
    assert.ok((result.content as string).includes('visible-output'));
    assert.strictEqual(currentDirectory, path.join(testRoot, 'sub'));
  });

});
