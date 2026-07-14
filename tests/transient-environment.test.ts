import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSIENT_CURRENT_DIRECTORY_PREFIX,
  buildTransientEnvironmentHint,
  resolveShellName,
} from '../src/core/transient-environment';

test('transient environment hint carries cwd and local execution details outside system prompt', () => {
  const message = buildTransientEnvironmentHint({
    currentDirectory: 'C:\\work\\project',
    provider: 'openai',
    model: 'MiniMax-M3',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    platform: 'win32',
    now: new Date('2026-06-14T12:00:00.000Z'),
    gitInfo: {
      root: 'C:\\work\\project',
      branch: 'main',
      trackedChanges: 2,
    },
  });

  assert.ok(message);
  assert.equal(message.role, 'user');
  assert.equal(message.__injected, true);
  assert.equal(typeof message.content, 'string');
  assert.equal(message.content.startsWith(TRANSIENT_CURRENT_DIRECTORY_PREFIX), true);
  assert.doesNotMatch(message.content, /^date:/m);
  assert.match(message.content, /cwd: C:\\work\\project/);
  assert.doesNotMatch(message.content, /^surface:/m);
  assert.match(message.content, /model: openai\/MiniMax-M3/);
  assert.match(message.content, /os: win32/);
  assert.match(message.content, /shell: powershell/);
  assert.match(message.content, /git: root=\., branch=main, tracked_changes=2/);
  assert.match(message.content, /Use cwd for relative file and shell paths\./);
});

test('transient environment hint is omitted without a current directory', () => {
  assert.equal(buildTransientEnvironmentHint({ currentDirectory: '' }), null);
});

test('shell name resolver accepts common Windows and POSIX env fields', () => {
  assert.equal(resolveShellName({ ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, 'win32'), 'powershell');
  assert.equal(resolveShellName({ SHELL: '/bin/zsh' }, 'linux'), 'zsh');
  assert.equal(resolveShellName({ PSModulePath: 'C:\\Users\\test\\Documents\\PowerShell\\Modules' }, 'win32'), 'powershell');
});
