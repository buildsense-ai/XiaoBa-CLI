import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadRuntimeManifest,
  normalizeArch,
  normalizePlatform,
  removeBrokenRuntimeSymlinks,
  repairNodeRuntimeEntrypoints,
  resolveExtractedRoot,
  resolveRuntimeTarget,
  resolveRuntimeTargetKey,
  validateRuntimeManifest,
  verifyXurlRuntime,
} from '../scripts/prepare-runtime.mjs';

describe('runtime manifest resolution', () => {
  test('normalizes platform and arch aliases', () => {
    assert.strictEqual(normalizePlatform('macos'), 'darwin');
    assert.strictEqual(normalizePlatform('windows'), 'win32');
    assert.strictEqual(normalizeArch('x86_64'), 'x64');
    assert.strictEqual(normalizeArch('aarch64'), 'arm64');
  });

  test('resolves runtime target keys from normalized values', () => {
    assert.strictEqual(resolveRuntimeTargetKey('darwin', 'aarch64'), 'darwin-arm64');
    assert.strictEqual(resolveRuntimeTargetKey('windows', 'x86_64'), 'win32-x64');
  });

  test('loads node, python, and xurl targets from the manifest', () => {
    const manifest = loadRuntimeManifest();
    const nodeTarget = resolveRuntimeTarget(manifest, 'node', 'darwin', 'arm64');
    const pythonTarget = resolveRuntimeTarget(manifest, 'python', 'linux', 'x64');
    const xurlTarget = resolveRuntimeTarget(manifest, 'xurl', 'darwin', 'arm64');

    assert.strictEqual(nodeTarget.archiveType, 'tar.xz');
    assert.strictEqual(nodeTarget.targetSubdir, 'node');
    assert.ok(nodeTarget.sources.length >= 2);
    assert.ok(nodeTarget.sources[0].url.includes('node-v20.12.2-darwin-arm64'));

    assert.strictEqual(pythonTarget.archiveType, 'tar.gz');
    assert.strictEqual(pythonTarget.targetSubdir, 'python');
    assert.ok(pythonTarget.sources.length >= 2);
    assert.ok(pythonTarget.sources[0].url.includes('cpython-3.12.7%2B20241016-x86_64-unknown-linux-gnu'));

    assert.strictEqual(xurlTarget.archiveType, 'tar.gz');
    assert.strictEqual(xurlTarget.targetSubdir, 'xurl');
    assert.strictEqual(xurlTarget.packageRoot, 'package/vendor/aarch64-apple-darwin/xurl');
    assert.strictEqual(xurlTarget.sources.length, 1);
    assert.ok(xurlTarget.sources[0].url.includes('xurl-0.0.27-darwin-arm64.tgz'));
  });
});

describe('runtime manifest safety checks', () => {
  test('accepts the checked-in manifest', () => {
    const manifest = loadRuntimeManifest();
    assert.doesNotThrow(() => validateRuntimeManifest(manifest));
  });

  test('rejects an unapproved source host', () => {
    const manifest = {
      runtimes: {
        node: {
          targets: {
            'linux-x64': {
              archiveType: 'tar.xz',
              sources: [
                {
                  url: 'https://evil.example.com/node.tar.xz',
                  sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                },
              ],
            },
          },
        },
      },
    };

    assert.throws(
      () => validateRuntimeManifest(manifest),
      /Unapproved host/,
    );
  });

  test('rejects a source without a valid sha256', () => {
    const manifest = {
      runtimes: {
        node: {
          targets: {
            'linux-x64': {
              archiveType: 'tar.xz',
              sources: [
                {
                  url: 'https://nodejs.org/dist/v20.12.2/node-v20.12.2-linux-x64.tar.xz',
                  sha256: 'short',
                },
              ],
            },
          },
        },
      },
    };

    assert.throws(
      () => validateRuntimeManifest(manifest),
      /invalid sha256/,
    );
  });
});

describe('xurl runtime verification', () => {
  test('rejects a runtime without the expected executable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-xurl-runtime-'));
    try {
      assert.throws(
        () => verifyXurlRuntime(root, process.platform, '0.0.27'),
        /missing executable/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('runs the prepared executable and verifies its pinned version', (t) => {
    if (process.platform === 'win32') {
      t.skip('A synthetic Windows executable is not portable in this unit test');
      return;
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-xurl-runtime-'));
    try {
      const executable = path.join(root, 'xurl');
      fs.writeFileSync(executable, '#!/bin/sh\necho xurl 0.0.27\n');

      assert.doesNotThrow(() => verifyXurlRuntime(root, process.platform, '0.0.27'));
      assert.strictEqual(fs.statSync(executable).mode & 0o111, 0o111);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('desktop runtime packaging', () => {
  test('ships the prepared runtime and third-party license notices', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
    );

    assert.ok(packageJson.build.files.includes('LICENSE'));
    assert.ok(packageJson.build.files.includes('THIRD_PARTY_NOTICES.md'));
    assert.ok(
      packageJson.build.extraFiles.some(
        (fileSet: { from?: string; to?: string }) =>
          fileSet.from === 'build-resources/runtime' && fileSet.to === 'runtime',
      ),
    );
  });
});

describe('resolveExtractedRoot', () => {
  test('uses the single extracted directory by default', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-extract-root-'));
    try {
      const nested = path.join(root, 'bundle');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, 'marker.txt'), 'ok');
      assert.strictEqual(resolveExtractedRoot(root), nested);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('honors an explicit packageRoot when provided', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-extract-root-'));
    try {
      const nested = path.join(root, 'python', 'bin');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, 'python3'), '');
      assert.strictEqual(resolveExtractedRoot(root, 'python'), path.join(root, 'python'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('repairNodeRuntimeEntrypoints', () => {
  test('repairs POSIX npm, npx, and corepack entrypoints that were copied as regular files', (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX symlink repair is not used for Windows Node runtimes');
      return;
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-node-runtime-'));
    try {
      writeExecutable(path.join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
      writeExecutable(path.join(root, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'));
      writeExecutable(path.join(root, 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'));

      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'npm'), "require('../lib/cli.js')(process)\n");
      fs.writeFileSync(path.join(bin, 'npx'), "require('../lib/cli.js')(process)\n");
      fs.writeFileSync(path.join(bin, 'corepack'), "require('./lib/corepack.cjs')\n");

      assert.deepStrictEqual(
        repairNodeRuntimeEntrypoints(root, 'linux').sort(),
        ['corepack', 'npm', 'npx'],
      );

      assertSymlinkTarget(path.join(bin, 'npm'), path.join('..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
      assertSymlinkTarget(path.join(bin, 'npx'), path.join('..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'));
      assertSymlinkTarget(path.join(bin, 'corepack'), path.join('..', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('leaves Windows runtimes untouched', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-node-runtime-win-'));
    try {
      const npmPath = path.join(root, 'npm.cmd');
      fs.writeFileSync(npmPath, '@echo off\r\n');

      assert.deepStrictEqual(repairNodeRuntimeEntrypoints(root, 'win32'), []);
      assert.strictEqual(fs.readFileSync(npmPath, 'utf-8'), '@echo off\r\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('removeBrokenRuntimeSymlinks', () => {
  test('removes broken POSIX symlinks before macOS signing walks bundled runtimes', (t) => {
    if (process.platform === 'win32') {
      t.skip('Creating symlinks on Windows depends on local developer mode/admin policy');
      return;
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-python-runtime-'));
    try {
      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin, { recursive: true });
      writeExecutable(path.join(bin, 'python3'));
      fs.symlinkSync('python3', path.join(bin, 'python'));
      fs.symlinkSync('2to3-3.12', path.join(bin, '2to3'));

      assert.deepStrictEqual(
        removeBrokenRuntimeSymlinks(root).map(normalize),
        ['bin/2to3'],
      );
      assert.strictEqual(fs.existsSync(path.join(bin, '2to3')), false);
      assertSymlinkTarget(path.join(bin, 'python'), 'python3');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function writeExecutable(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '#!/usr/bin/env node\n');
  fs.chmodSync(filePath, 0o755);
}

function assertSymlinkTarget(linkPath: string, expectedTarget: string): void {
  assert.strictEqual(fs.lstatSync(linkPath).isSymbolicLink(), true);
  assert.strictEqual(path.normalize(fs.readlinkSync(linkPath)), path.normalize(expectedTarget));
}

function normalize(value: string): string {
  return value.split(path.sep).join('/');
}
