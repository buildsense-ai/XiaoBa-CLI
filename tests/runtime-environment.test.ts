import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveRuntimeEnvironment } from '../src/utils/runtime-environment';

describe('resolveRuntimeEnvironment', () => {
  let testRoot: string;
  let shimRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-runtime-'));
    shimRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-runtime-shims-test-'));
  });

  afterEach(() => {
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
    if (shimRoot && fs.existsSync(shimRoot)) {
      fs.rmSync(shimRoot, { recursive: true, force: true });
    }
  });

  test('resolves bundled node from runtime root', () => {
    const nodeFileName = process.platform === 'win32' ? 'node.exe' : 'node';
    const nodeBinaryPath = process.platform === 'win32'
      ? path.join(testRoot, 'node', nodeFileName)
      : path.join(testRoot, 'node', 'bin', nodeFileName);

    fs.mkdirSync(path.dirname(nodeBinaryPath), { recursive: true });
    fs.writeFileSync(nodeBinaryPath, '');

    const runtimeEnvironment = resolveRuntimeEnvironment({
      runtimeRoot: testRoot,
      env: { PATH: '' },
      includeSystemFallback: false,
      probeVersion: false,
      shimDirectory: shimRoot,
    });

    assert.strictEqual(runtimeEnvironment.binaries.node.executable, nodeBinaryPath);
    assert.strictEqual(runtimeEnvironment.binaries.node.source, 'bundled');
  });

  test('does not duplicate bundled node directory in PATH', () => {
    const nodeFileName = process.platform === 'win32' ? 'node.exe' : 'node';
    const nodeDirectory = process.platform === 'win32'
      ? path.join(testRoot, 'node')
      : path.join(testRoot, 'node', 'bin');
    const nodeBinaryPath = path.join(nodeDirectory, nodeFileName);

    fs.mkdirSync(nodeDirectory, { recursive: true });
    fs.writeFileSync(nodeBinaryPath, '');

    const runtimeEnvironment = resolveRuntimeEnvironment({
      runtimeRoot: testRoot,
      env: { PATH: `${nodeDirectory}${path.delimiter}${nodeDirectory}` },
      includeSystemFallback: false,
      probeVersion: false,
      shimDirectory: shimRoot,
    });

    const pathEntries = (runtimeEnvironment.env[runtimeEnvironment.pathKey] || '').split(path.delimiter).filter(Boolean);
    const matchingEntries = pathEntries.filter(entry => normalize(entry) === normalize(nodeDirectory));
    assert.strictEqual(matchingEntries.length, 1);
    assert.strictEqual(normalize(runtimeEnvironment.prependedPaths[0]), normalize(shimRoot));
  });

  test('creates a python shim for a bundled runtime', () => {
    const pythonBinaryPath = process.platform === 'win32'
      ? path.join(testRoot, 'python', 'python.exe')
      : path.join(testRoot, 'python', 'bin', 'python3');

    fs.mkdirSync(path.dirname(pythonBinaryPath), { recursive: true });
    fs.writeFileSync(pythonBinaryPath, '');

    const runtimeEnvironment = resolveRuntimeEnvironment({
      runtimeRoot: testRoot,
      env: { PATH: '' },
      includeSystemFallback: false,
      probeVersion: false,
      shimDirectory: shimRoot,
    });

    const shimName = process.platform === 'win32' ? 'python.cmd' : 'python';
    assert.strictEqual(runtimeEnvironment.binaries.python.executable, pythonBinaryPath);
    assert.strictEqual(runtimeEnvironment.binaries.python.source, 'bundled');
    assert.ok(fs.existsSync(path.join(shimRoot, shimName)));
  });

  test('does not overwrite a shim with a self-referential command', (t) => {
    if (process.platform !== 'win32') {
      t.skip('Windows .cmd shim recursion is platform-specific');
      return;
    }

    const shimPath = path.join(shimRoot, 'node.cmd');
    const originalContent = `@echo off\r\n"${shimPath}" %*\r\n`;
    fs.writeFileSync(shimPath, originalContent, 'utf8');

    resolveRuntimeEnvironment({
      runtimeRoot: testRoot,
      env: { PATH: `${shimRoot}${path.delimiter}${process.env.PATH || ''}` },
      includeSystemFallback: true,
      probeVersion: false,
      shimDirectory: shimRoot,
    });

    assert.strictEqual(fs.readFileSync(shimPath, 'utf8'), originalContent);
  });

  test('reports missing python when no bundled or system runtime is available', () => {
    const runtimeEnvironment = resolveRuntimeEnvironment({
      runtimeRoot: testRoot,
      env: { PATH: '' },
      includeSystemFallback: false,
      probeVersion: false,
      shimDirectory: shimRoot,
    });

    assert.strictEqual(runtimeEnvironment.binaries.python.source, 'missing');
    assert.strictEqual(runtimeEnvironment.binaries.python.executable, undefined);
  });
});

function normalize(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
