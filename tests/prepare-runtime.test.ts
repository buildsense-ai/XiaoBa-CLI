import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { inferPythonInstallRoot } from '../scripts/prepare-runtime.mjs';

describe('inferPythonInstallRoot', () => {
  test('keeps the executable directory on Windows', () => {
    assert.strictEqual(
      inferPythonInstallRoot('C:\\hostedtoolcache\\windows\\Python\\3.12.0\\x64\\python.exe', 'win32'),
      'C:\\hostedtoolcache\\windows\\Python\\3.12.0\\x64',
    );
  });

  test('uses the parent of bin on Linux and macOS', () => {
    assert.strictEqual(
      inferPythonInstallRoot('/opt/hostedtoolcache/Python/3.12.0/x64/bin/python3', 'linux'),
      '/opt/hostedtoolcache/Python/3.12.0/x64',
    );
    assert.strictEqual(
      inferPythonInstallRoot('/Users/runner/hostedtoolcache/Python/3.12.0/x64/bin/python3', 'darwin'),
      '/Users/runner/hostedtoolcache/Python/3.12.0/x64',
    );
  });

  test('falls back to the executable directory when there is no bin segment', () => {
    assert.strictEqual(
      inferPythonInstallRoot('/custom/python3', 'linux'),
      '/custom',
    );
  });
});
