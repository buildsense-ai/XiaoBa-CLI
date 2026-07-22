import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applyShellRuntimeDefaults,
  DEFAULT_AGENT_BROWSER_IDLE_TIMEOUT_MS,
  ShellTool,
} from '../src/tools/bash-tool';
import { isBashCommandAllowed, isPathAllowed } from '../src/utils/safety';
import { WriteTool } from '../src/tools/write-tool';

test('shell runtime bounds agent-browser daemon idle lifetime by default', () => {
  const sourceEnv = { PATH: '/usr/bin' };
  const result = applyShellRuntimeDefaults(sourceEnv);

  assert.equal(result.AGENT_BROWSER_IDLE_TIMEOUT_MS, DEFAULT_AGENT_BROWSER_IDLE_TIMEOUT_MS);
  assert.equal(sourceEnv.AGENT_BROWSER_IDLE_TIMEOUT_MS, undefined);
});

test('shell runtime preserves an explicit agent-browser idle timeout', () => {
  const configured = applyShellRuntimeDefaults({
    AGENT_BROWSER_IDLE_TIMEOUT_MS: '300000',
  });
  const disabled = applyShellRuntimeDefaults({
    AGENT_BROWSER_IDLE_TIMEOUT_MS: '0',
  });

  assert.equal(configured.AGENT_BROWSER_IDLE_TIMEOUT_MS, '300000');
  assert.equal(disabled.AGENT_BROWSER_IDLE_TIMEOUT_MS, '0');
});

test('execute_shell passes the default agent-browser idle timeout to child processes', async () => {
  const previous = process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS;
  delete process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS;

  try {
    const result = await new ShellTool().execute({
      command: `node -e "process.stdout.write(process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS || '')"`,
    }, {
      workingDirectory: process.cwd(),
      conversationHistory: [],
    });

    assert.equal(result.ok, true);
    assert.match(String(result.ok && result.content), new RegExp(DEFAULT_AGENT_BROWSER_IDLE_TIMEOUT_MS));
  } finally {
    if (previous === undefined) delete process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS;
    else process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS = previous;
  }
});

test('Device RPC receivers apply the same agent-browser idle timeout locally', async () => {
  const previous = process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS;
  delete process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS;

  try {
    const result = await new ShellTool().execute({
      command: `node -e "process.stdout.write(process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS || '')"`,
    }, {
      workingDirectory: process.cwd(),
      conversationHistory: [],
      deviceRpcReceiver: true,
    });

    assert.equal(result.ok, true);
    assert.match(String(result.ok && result.content), new RegExp(DEFAULT_AGENT_BROWSER_IDLE_TIMEOUT_MS));
  } finally {
    if (previous === undefined) delete process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS;
    else process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS = previous;
  }
});

test('shell safety blocks confirmable destructive commands until explicitly confirmed', () => {
  assert.deepEqual(isBashCommandAllowed('git reset --hard'), {
    allowed: false,
    reason: '检测到会丢弃工作区改动的 git reset --hard。请先确认用户明确要求该危险操作，再用 confirm_dangerous=true 重试；如需强制绕过全部 shell 安全检查，请设置 GAUZ_BASH_ALLOW_DANGEROUS=true',
  });
  assert.deepEqual(isBashCommandAllowed('git reset --hard', { confirmed: true }), {
    allowed: true,
  });
});

test('shell safety keeps extreme destructive commands blocked even with command confirmation', () => {
  const result = isBashCommandAllowed('rm -rf /', { confirmed: true });

  assert.equal(result.allowed, false);
  assert.match(result.reason || '', /rm -rf \//);
  assert.match(result.reason || '', /GAUZ_BASH_ALLOW_DANGEROUS=true/);
});

test('shell safety supports explicit environment override for emergency maintenance', () => {
  assert.deepEqual(isBashCommandAllowed('rm -rf /', {
    env: { GAUZ_BASH_ALLOW_DANGEROUS: 'true' },
  }), { allowed: true });
});

test('execute_shell schema exposes confirm_dangerous and enforces it before execution', async () => {
  const shell = new ShellTool();
  const param = shell.definition.parameters.properties.confirm_dangerous;
  assert.equal(param?.type, 'boolean');

  const result = await shell.execute({
    command: 'git reset --hard',
  }, {
    workingDirectory: process.cwd(),
    conversationHistory: [],
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'PERMISSION_DENIED');
  assert.match(result.message, /confirm_dangerous=true/);
});

test('write safety blocks direct .env mutation unless explicitly allowed by environment', async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-safety-'));
  const previous = process.env.GAUZ_FS_ALLOW_DOTENV;
  delete process.env.GAUZ_FS_ALLOW_DOTENV;

  try {
    const envPath = path.join(testRoot, '.env');
    assert.equal(isPathAllowed(envPath, testRoot).allowed, false);

    const write = new WriteTool();
    const result = await write.execute({
      file_path: '.env',
      content: 'SECRET=value',
    }, {
      workingDirectory: testRoot,
      conversationHistory: [],
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'PERMISSION_DENIED');
    assert.equal(fs.existsSync(envPath), false);

    process.env.GAUZ_FS_ALLOW_DOTENV = 'true';
    assert.equal(isPathAllowed(envPath, testRoot).allowed, true);
  } finally {
    if (previous === undefined) delete process.env.GAUZ_FS_ALLOW_DOTENV;
    else process.env.GAUZ_FS_ALLOW_DOTENV = previous;
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});
