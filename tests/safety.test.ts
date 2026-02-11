import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import { isReadPathAllowed, isToolAllowed } from '../src/utils/safety';

function withEnv(key: string, value: string | undefined, run: () => void): void {
  const previous = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }

  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

test('dangerous tool is blocked by default', () => {
  withEnv('GAUZ_TOOL_ALLOW', undefined, () => {
    const result = isToolAllowed('execute_bash');
    assert.equal(result.allowed, false);
  });
});

test('dangerous tool can be explicitly allowed', () => {
  withEnv('GAUZ_TOOL_ALLOW', 'execute_bash', () => {
    const result = isToolAllowed('execute_bash');
    assert.equal(result.allowed, true);
  });
});

test('read path outside working directory is blocked by default', () => {
  withEnv('GAUZ_FS_ALLOW_OUTSIDE_READ', undefined, () => {
    const workdir = path.join(os.tmpdir(), 'xiaoba-safety-workdir');
    const target = path.join(os.tmpdir(), 'xiaoba-safety-outside', 'file.txt');
    const result = isReadPathAllowed(target, workdir);
    assert.equal(result.allowed, false);
  });
});

test('read path outside working directory can be enabled', () => {
  withEnv('GAUZ_FS_ALLOW_OUTSIDE_READ', 'true', () => {
    const workdir = path.join(os.tmpdir(), 'xiaoba-safety-workdir');
    const target = path.join(os.tmpdir(), 'xiaoba-safety-outside', 'file.txt');
    const result = isReadPathAllowed(target, workdir);
    assert.equal(result.allowed, true);
  });
});
