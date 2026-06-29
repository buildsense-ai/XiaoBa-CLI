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
    assertSameDirectory(currentDirectory, path.join(testRoot, 'sub'));
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
    assertSameDirectory(currentDirectory, path.join(testRoot, 'sub'));
    assert.ok((result.content as string).includes('ok'));
    assert.ok(!(result.content as string).includes('__XIAOBA_CWD_MARKER__'));
  });

  test('explicit cwd runs the command from that directory and persists final cwd', async () => {
    const tool = new ShellTool();
    const command = process.platform === 'win32'
      ? 'Set-Content -LiteralPath marker.txt -Value ok'
      : 'printf ok > marker.txt';
    const result = await tool.execute({ command, cwd: 'sub' }, {
      ...context,
      workingDirectory: currentDirectory,
    });

    assert.strictEqual(result.ok, true);
    assert.ok(fs.existsSync(path.join(testRoot, 'sub', 'marker.txt')));
    assertSameDirectory(currentDirectory, path.join(testRoot, 'sub'));
    assert.ok((result.content as string).includes(`Working directory: ${path.resolve(testRoot, 'sub')}`));
    assert.ok((result.content as string).includes(`Final cwd: ${path.resolve(testRoot, 'sub')}`));
  });

  test('successful commands return both stdout and stderr', async () => {
    const tool = new ShellTool();
    const command = process.platform === 'win32'
      ? `& ${quotePowerShellString(process.execPath)} -e "process.stdout.write('stdout-visible\\n'); process.stderr.write('stderr-visible\\n')"`
      : `${quotePosixString(process.execPath)} -e "process.stdout.write('stdout-visible\\n'); process.stderr.write('stderr-visible\\n')"`;
    const result = await tool.execute({ command }, {
      ...context,
      workingDirectory: currentDirectory,
    });

    assert.strictEqual(result.ok, true);
    const content = result.content as string;
    assert.match(content, /^Command completed/);
    assert.match(content, /^status: succeeded$/m);
    assert.match(content, /^exit_code: 0$/m);
    assert.match(content, /^timed_out: false$/m);
    assert.match(content, /^stdout_lines: 1$/m);
    assert.match(content, /^stderr_lines: 1$/m);
    assert.ok(content.includes('stdout-visible'));
    assert.ok(content.includes('stderr-visible'));
  });

  test('POSIX execution uses bash when bash is available', {
    skip: process.platform === 'win32' || !fs.existsSync('/bin/bash'),
  }, async () => {
    const tool = new ShellTool();
    const result = await tool.execute({ command: 'echo "bash-version:${BASH_VERSION:-missing}"' }, {
      ...context,
      workingDirectory: currentDirectory,
    });

    assert.strictEqual(result.ok, true);
    assert.match(result.content as string, /bash-version:[0-9]/);
  });

  test('failed cd does not update session current directory', async () => {
    const tool = new ShellTool();
    const result = await tool.execute({ command: 'cd missing-directory' }, {
      ...context,
      workingDirectory: currentDirectory,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(currentDirectory, testRoot);
    assert.match(result.message, /^Command completed/);
    assert.match(result.message, /^status: failed$/m);
    assert.match(result.message, /^timed_out: false$/m);
    assert.ok(!result.message.includes('__XIAOBA_CWD_MARKER__'));
    assert.ok(!result.message.includes('status=$?'));
    assert.ok(!result.message.includes('printf'));
    assert.ok(!result.message.includes('exit "$status"'));
  });

  test('timed out commands return structured timeout metadata', {
    skip: process.platform === 'win32',
  }, async () => {
    const tool = new ShellTool();
    const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 5' : 'sleep 5';
    const result = await tool.execute({ command, timeout: 50 }, {
      ...context,
      workingDirectory: currentDirectory,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'EXECUTION_TIMEOUT');
    assert.match(result.message, /^Command completed/);
    assert.match(result.message, /^status: timed_out$/m);
    assert.match(result.message, /^timed_out: true$/m);
    assert.match(result.message, /^stdout:/m);
    assert.match(result.message, /^stderr:/m);
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
    assertSameDirectory(currentDirectory, path.join(testRoot, 'sub'));
    assert.ok(!result.message.includes('__XIAOBA_CWD_MARKER__'));
    assert.ok(!result.message.includes('status=$?'));
    assert.ok(!result.message.includes('printf'));
    assert.ok(!result.message.includes('exit "$status"'));
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
    assertSameDirectory(currentDirectory, path.join(testRoot, 'sub'));
  });

  test('Windows cmd fallback preserves cwd and strips session noise', {
    skip: process.platform !== 'win32',
  }, async () => {
    const tool = new ShellTool();
    (tool as any).executeWindowsPowerShellScript = async () => {
      const error: any = new Error('spawn powershell.exe ENOENT');
      error.code = 'ENOENT';
      throw error;
    };

    const result = await tool.execute({ command: 'cd sub && echo ok' }, {
      ...context,
      workingDirectory: currentDirectory,
    });

    assert.strictEqual(result.ok, true);
    assert.ok((result.content as string).includes('ok'));
    assert.ok(!(result.content as string).includes('Microsoft Windows'));
    assert.ok(!/[A-Z]:\\.*>/.test(result.content as string));
    assertSameDirectory(currentDirectory, path.join(testRoot, 'sub'));
  });

  test('Windows cmd fallback persists cwd even when a later command fails', {
    skip: process.platform !== 'win32',
  }, async () => {
    const tool = new ShellTool();
    (tool as any).executeWindowsPowerShellScript = async () => {
      const error: any = new Error('spawn powershell.exe ENOENT');
      error.code = 'ENOENT';
      throw error;
    };

    const result = await tool.execute({ command: 'cd sub && definitely_missing_xiaoba_command' }, {
      ...context,
      workingDirectory: currentDirectory,
    });

    assert.strictEqual(result.ok, false);
    assertSameDirectory(currentDirectory, path.join(testRoot, 'sub'));
    assert.ok(!result.message.includes('__XIAOBA_STATUS__'));
    assert.ok(!result.message.includes('cd >'));
    assert.ok(!result.message.includes('exit /b'));
    assert.ok(!/[A-Z]:\\.*>/.test(result.message));
  });

});

function assertSameDirectory(actual: string, expected: string): void {
  assert.strictEqual(fs.realpathSync(actual), fs.realpathSync(expected));
}

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quotePosixString(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
