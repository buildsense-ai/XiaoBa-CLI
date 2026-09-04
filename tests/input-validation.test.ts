import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateFilePath,
  validateCommand,
  validateFileContent,
  validateTimeout,
  validateString,
  validateBoolean,
  validateInteger,
  validateShellToolArgs,
  validateWriteToolArgs,
  validateReadToolArgs,
} from '../src/utils/input-validation';

test('validateFilePath rejects null/undefined', () => {
  assert.equal(validateFilePath(null).valid, false);
  assert.equal(validateFilePath(undefined).valid, false);
});

test('validateFilePath rejects non-string values', () => {
  assert.equal(validateFilePath(123).valid, false);
  assert.equal(validateFilePath({}).valid, false);
  assert.equal(validateFilePath([]).valid, false);
});

test('validateFilePath rejects empty strings', () => {
  assert.equal(validateFilePath('').valid, false);
  assert.equal(validateFilePath('   ').valid, false);
});

test('validateFilePath rejects paths with null bytes', () => {
  assert.equal(validateFilePath('/path/to/file\0.txt').valid, false);
});

test('validateFilePath rejects paths with control characters', () => {
  assert.equal(validateFilePath('/path/to/file\x00.txt').valid, false);
  assert.equal(validateFilePath('/path/to/file\x1f.txt').valid, false);
});

test('validateFilePath rejects path traversal attempts', () => {
  assert.equal(validateFilePath('../etc/passwd').valid, false);
  assert.equal(validateFilePath('foo/../../etc/passwd').valid, false);
});

test('validateFilePath rejects system paths', () => {
  assert.equal(validateFilePath('/sys/kernel').valid, false);
  assert.equal(validateFilePath('/proc/1').valid, false);
});

test('validateFilePath accepts valid paths', () => {
  assert.equal(validateFilePath('/home/user/file.txt').valid, true);
  assert.equal(validateFilePath('relative/path/file.txt').valid, true);
  assert.equal(validateFilePath('./current/file.txt').valid, true);
});

test('validateFilePath rejects overly long paths', () => {
  const longPath = '/home/' + 'a'.repeat(5000) + '/file.txt';
  assert.equal(validateFilePath(longPath).valid, false);
});

test('validateCommand rejects null/undefined', () => {
  assert.equal(validateCommand(null).valid, false);
  assert.equal(validateCommand(undefined).valid, false);
});

test('validateCommand rejects non-string values', () => {
  assert.equal(validateCommand(123).valid, false);
  assert.equal(validateCommand({}).valid, false);
});

test('validateCommand rejects empty commands', () => {
  assert.equal(validateCommand('').valid, false);
  assert.equal(validateCommand('   ').valid, false);
});

test('validateCommand rejects commands with null bytes', () => {
  assert.equal(validateCommand('echo hello\0').valid, false);
});

test('validateCommand accepts valid commands', () => {
  assert.equal(validateCommand('echo hello').valid, true);
  assert.equal(validateCommand('npm install').valid, true);
  assert.equal(validateCommand('git status').valid, true);
});

test('validateCommand rejects overly long commands', () => {
  const longCommand = 'echo ' + 'a'.repeat(15000);
  assert.equal(validateCommand(longCommand).valid, false);
});

test('validateFileContent rejects null/undefined', () => {
  assert.equal(validateFileContent(null).valid, false);
  assert.equal(validateFileContent(undefined).valid, false);
});

test('validateFileContent rejects non-string values', () => {
  assert.equal(validateFileContent(123).valid, false);
  assert.equal(validateFileContent({}).valid, false);
});

test('validateFileContent rejects content with null bytes', () => {
  assert.equal(validateFileContent('hello\0world').valid, false);
});

test('validateFileContent accepts valid content', () => {
  assert.equal(validateFileContent('Hello, World!').valid, true);
  assert.equal(validateFileContent('中文内容').valid, true);
  assert.equal(validateFileContent('').valid, true);
});

test('validateFileContent rejects overly large content', () => {
  const largeContent = 'a'.repeat(11 * 1024 * 1024); // 11 MB
  assert.equal(validateFileContent(largeContent).valid, false);
});

test('validateTimeout accepts valid values', () => {
  assert.equal(validateTimeout(undefined).valid, true);
  assert.equal(validateTimeout(null).valid, true);
  assert.equal(validateTimeout(1000).valid, true);
  assert.equal(validateTimeout(0).valid, true);
});

test('validateTimeout rejects invalid values', () => {
  assert.equal(validateTimeout('string').valid, false);
  assert.equal(validateTimeout(-1).valid, false);
  assert.equal(validateTimeout(1e10).valid, false); // > 1 hour
});

test('validateBoolean accepts valid values', () => {
  assert.equal(validateBoolean(undefined).valid, true);
  assert.equal(validateBoolean(null).valid, true);
  assert.equal(validateBoolean(true).valid, true);
  assert.equal(validateBoolean(false).valid, true);
});

test('validateBoolean rejects invalid values', () => {
  assert.equal(validateBoolean('true').valid, false);
  assert.equal(validateBoolean(1).valid, false);
  assert.equal(validateBoolean(0).valid, false);
});

test('validateInteger accepts valid values', () => {
  assert.equal(validateInteger(undefined).valid, true);
  assert.equal(validateInteger(null).valid, true);
  assert.equal(validateInteger(0).valid, true);
  assert.equal(validateInteger(100).valid, true);
  assert.equal(validateInteger(-50).valid, true);
});

test('validateInteger respects min/max constraints', () => {
  assert.equal(validateInteger(5, 'test', 0, 10).valid, true);
  assert.equal(validateInteger(-1, 'test', 0, 10).valid, false);
  assert.equal(validateInteger(15, 'test', 0, 10).valid, false);
});

test('validateInteger rejects non-integers', () => {
  assert.equal(validateInteger(1.5).valid, false);
  assert.equal(validateInteger('string').valid, false);
  assert.equal(validateInteger(NaN).valid, false);
  assert.equal(validateInteger(Infinity).valid, false);
});

test('validateString accepts valid values', () => {
  assert.equal(validateString(undefined).valid, true);
  assert.equal(validateString(null).valid, true);
  assert.equal(validateString('hello').valid, true);
  assert.equal(validateString('').valid, true);
});

test('validateString rejects non-string values', () => {
  assert.equal(validateString(123).valid, false);
  assert.equal(validateString({}).valid, false);
});

test('validateString rejects strings with null bytes', () => {
  assert.equal(validateString('hello\0world').valid, false);
});

test('validateString respects maxLength constraint', () => {
  assert.equal(validateString('hello', 'test', 10).valid, true);
  assert.equal(validateString('hello world', 'test', 5).valid, false);
});

test('validateShellToolArgs validates complete valid args', () => {
  assert.equal(validateShellToolArgs({
    command: 'echo hello',
    timeout: 5000,
    cwd: '/tmp',
    confirm_dangerous: false,
  }).valid, true);
});

test('validateShellToolArgs requires command', () => {
  assert.equal(validateShellToolArgs({}).valid, false);
  assert.equal(validateShellToolArgs({ timeout: 5000 }).valid, false);
});

test('validateShellToolArgs validates command format', () => {
  assert.equal(validateShellToolArgs({ command: '' }).valid, false);
  assert.equal(validateShellToolArgs({ command: 'echo hello' }).valid, true);
});

test('validateShellToolArgs validates timeout format', () => {
  assert.equal(validateShellToolArgs({ command: 'echo', timeout: -1 }).valid, false);
  assert.equal(validateShellToolArgs({ command: 'echo', timeout: 'invalid' }).valid, false);
});

test('validateShellToolArgs validates cwd format', () => {
  assert.equal(validateShellToolArgs({ command: 'echo', cwd: '../etc' }).valid, false);
});

test('validateWriteToolArgs validates complete valid args', () => {
  assert.equal(validateWriteToolArgs({
    file_path: '/tmp/test.txt',
    content: 'Hello, World!',
  }).valid, true);
});

test('validateWriteToolArgs requires both file_path and content', () => {
  assert.equal(validateWriteToolArgs({ file_path: '/tmp/test.txt' }).valid, false);
  assert.equal(validateWriteToolArgs({ content: 'Hello' }).valid, false);
});

test('validateWriteToolArgs validates file_path format', () => {
  assert.equal(validateWriteToolArgs({ file_path: '', content: 'test' }).valid, false);
  assert.equal(validateWriteToolArgs({ file_path: '../etc', content: 'test' }).valid, false);
});

test('validateWriteToolArgs validates content format', () => {
  assert.equal(validateWriteToolArgs({ file_path: '/tmp/test.txt', content: null }).valid, false);
  const largeContent = 'a'.repeat(11 * 1024 * 1024);
  assert.equal(validateWriteToolArgs({ file_path: '/tmp/test.txt', content: largeContent }).valid, false);
});

test('validateReadToolArgs validates complete valid args', () => {
  assert.equal(validateReadToolArgs({
    file_path: '/tmp/test.txt',
    offset: 1,
    limit: 100,
  }).valid, true);
});

test('validateReadToolArgs requires file_path', () => {
  assert.equal(validateReadToolArgs({}).valid, false);
});

test('validateReadToolArgs validates file_path format', () => {
  assert.equal(validateReadToolArgs({ file_path: '' }).valid, false);
  assert.equal(validateReadToolArgs({ file_path: '../etc' }).valid, false);
});

test('validateReadToolArgs validates offset format', () => {
  assert.equal(validateReadToolArgs({ file_path: '/tmp/test.txt', offset: -1 }).valid, false);
  assert.equal(validateReadToolArgs({ file_path: '/tmp/test.txt', offset: 1.5 }).valid, false);
});

test('validateReadToolArgs validates limit format', () => {
  assert.equal(validateReadToolArgs({ file_path: '/tmp/test.txt', limit: -1 }).valid, false);
  assert.equal(validateReadToolArgs({ file_path: '/tmp/test.txt', limit: 'invalid' }).valid, false);
  assert.equal(validateReadToolArgs({ file_path: '/tmp/test.txt', limit: 999999 }).valid, false);
});

test('input validation provides helpful error messages', () => {
  const result = validateFilePath('');
  assert.ok(result.error?.includes('cannot be empty'));
  
  const result2 = validateCommand(null);
  assert.ok(result2.error?.includes('required'));
  
  const result3 = validateFilePath('../etc');
  assert.ok(result3.error?.includes('Path traversal'));
});
