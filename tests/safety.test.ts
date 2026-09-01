import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isBashCommandAllowed,
  isPathAllowed,
  isReadPathAllowed,
  isToolAllowed,
} from '../src/utils/safety';
import { ShellTool } from '../src/tools/bash-tool';
import { WriteTool } from '../src/tools/write-tool';

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

test('isToolAllowed blocks dangerous tools by default', () => {
  // Dangerous tools should be blocked without environment variable
  assert.equal(isToolAllowed('execute_shell').allowed, false);
  assert.equal(isToolAllowed('execute_bash').allowed, false);
  assert.equal(isToolAllowed('write_file').allowed, false);
  assert.equal(isToolAllowed('edit_file').allowed, false);
});

test('isToolAllowed allows safe tools by default', () => {
  // Safe tools should always be allowed
  assert.equal(isToolAllowed('read_file').allowed, true);
  assert.equal(isToolAllowed('glob').allowed, true);
  assert.equal(isToolAllowed('grep').allowed, true);
  assert.equal(isToolAllowed('ask_parent').allowed, true);
  assert.equal(isToolAllowed('send_text').allowed, true);
});

test('isToolAllowed allows dangerous tools when GAUZ_TOOL_ALLOW is set', () => {
  const previous = process.env.GAUZ_TOOL_ALLOW;
  try {
    process.env.GAUZ_TOOL_ALLOW = 'execute_shell';
    assert.equal(isToolAllowed('execute_shell').allowed, true);
    assert.equal(isToolAllowed('execute_bash').allowed, true); // execute_bash should also be allowed
    
    // Other dangerous tools should still be blocked
    assert.equal(isToolAllowed('write_file').allowed, false);
  } finally {
    if (previous === undefined) delete process.env.GAUZ_TOOL_ALLOW;
    else process.env.GAUZ_TOOL_ALLOW = previous;
  }
});

test('isReadPathAllowed blocks paths outside working directory by default', () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-read-safety-'));
  const outsidePath = path.join(os.tmpdir(), 'outside-file.txt');
  
  try {
    // Create a test file outside the working directory
    fs.writeFileSync(outsidePath, 'test');
    
    // Read should be blocked by default
    assert.equal(isReadPathAllowed(outsidePath, testRoot).allowed, false);
    
    // Allow outside reads with env variable
    process.env.GAUZ_FS_ALLOW_OUTSIDE_READ = 'true';
    assert.equal(isReadPathAllowed(outsidePath, testRoot).allowed, true);
    delete process.env.GAUZ_FS_ALLOW_OUTSIDE_READ;
    
    // Read within working directory should be allowed
    const insidePath = path.join(testRoot, 'inside-file.txt');
    fs.writeFileSync(insidePath, 'test');
    assert.equal(isReadPathAllowed(insidePath, testRoot).allowed, true);
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
    if (fs.existsSync(outsidePath)) fs.unlinkSync(outsidePath);
  }
});

test('isPathAllowed blocks paths outside working directory by default', () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-write-safety-'));
  const outsidePath = path.join(os.tmpdir(), 'outside-write.txt');
  
  try {
    // Write should be blocked by default for paths outside working directory
    assert.equal(isPathAllowed(outsidePath, testRoot).allowed, false);
    
    // Allow outside writes with env variable
    process.env.GAUZ_FS_ALLOW_OUTSIDE = 'true';
    assert.equal(isPathAllowed(outsidePath, testRoot).allowed, true);
    delete process.env.GAUZ_FS_ALLOW_OUTSIDE;
    
    // Write within working directory should be allowed
    const insidePath = path.join(testRoot, 'inside-file.txt');
    assert.equal(isPathAllowed(insidePath, testRoot).allowed, true);
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
    if (fs.existsSync(outsidePath)) fs.unlinkSync(outsidePath);
  }
});

test('path containment handles symbolic links correctly', () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-symlink-safety-'));
  
  try {
    // Create a directory structure
    const subDir = path.join(testRoot, 'subdir');
    fs.mkdirSync(subDir);
    
    // Create a symlink pointing outside
    const symlinkPath = path.join(testRoot, 'outside_link');
    fs.symlinkSync(os.tmpdir(), symlinkPath);
    
    // The symlink itself is within the working directory, so it should be allowed
    // (the actual access would be checked by the OS)
    assert.equal(isPathAllowed(symlinkPath, testRoot).allowed, true);
    
    // But accessing a path through the symlink that goes outside should be blocked
    const accessedThroughSymlink = path.join(symlinkPath, 'target-file');
    assert.equal(isReadPathAllowed(accessedThroughSymlink, testRoot).allowed, false);
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test('dangerous bash patterns are properly detected', () => {
  const dangerousCommands = [
    'rm -rf /',
    'rm -rf /*',
    'del /s /q C:\\',
    'format C:',
    'mkfs.ext4 /dev/sda',
    'diskpart',
    'shutdown',
    'reboot',
    'poweroff',
    ':(){ :|:& };:',
  ];
  
  for (const cmd of dangerousCommands) {
    const result = isBashCommandAllowed(cmd);
    assert.equal(result.allowed, false, `Command "${cmd}" should be blocked`);
    assert.ok(result.reason, `Command "${cmd}" should have a reason`);
  }
});

test('dangerous tools execution is blocked by isToolAllowed', async () => {
  const shell = new ShellTool();
  
  // Without GAUZ_TOOL_ALLOW, execute_shell should be blocked
  const previous = process.env.GAUZ_TOOL_ALLOW;
  delete process.env.GAUZ_TOOL_ALLOW;
  
  try {
    const result = await shell.execute({
      command: 'echo hello',
    }, {
      workingDirectory: process.cwd(),
      conversationHistory: [],
    });
    
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'PERMISSION_DENIED');
    assert.ok(result.message.includes('GAUZ_TOOL_ALLOW'));
  } finally {
    if (previous !== undefined) process.env.GAUZ_TOOL_ALLOW = previous;
  }
});

test('dangerous tools can be enabled via GAUZ_TOOL_ALLOW', async () => {
  const shell = new ShellTool();
  
  const previous = process.env.GAUZ_TOOL_ALLOW;
  try {
    process.env.GAUZ_TOOL_ALLOW = 'execute_shell';
    
    const result = await shell.execute({
      command: 'echo hello',
    }, {
      workingDirectory: process.cwd(),
      conversationHistory: [],
    });
    
    // With the tool allowed, the command should proceed (unless it has dangerous bash patterns)
    // echo hello is not dangerous, so it should succeed
    assert.equal(result.ok, true);
  } finally {
    if (previous === undefined) delete process.env.GAUZ_TOOL_ALLOW;
    else process.env.GAUZ_TOOL_ALLOW = previous;
  }
});
