import { describe, test, type TestContext } from 'node:test';
import * as assert from 'node:assert';
import childProcess, { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadRuntimeManifest,
  main as prepareRuntime,
  normalizeArch,
  normalizePlatform,
  removeBrokenRuntimeSymlinks,
  repairNodeRuntimeEntrypoints,
  resolveExtractedRoot,
  resolveRuntimeTarget,
  resolveRuntimeTargetKey,
  validateRuntimeManifest,
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

  test('loads node and python targets from the manifest', () => {
    const manifest = loadRuntimeManifest();
    const nodeTarget = resolveRuntimeTarget(manifest, 'node', 'darwin', 'arm64');
    const pythonTarget = resolveRuntimeTarget(manifest, 'python', 'linux', 'x64');

    assert.strictEqual(nodeTarget.archiveType, 'tar.xz');
    assert.strictEqual(nodeTarget.targetSubdir, 'node');
    assert.ok(nodeTarget.sources.length >= 2);
    assert.ok(nodeTarget.sources[0].url.includes('node-v20.12.2-darwin-arm64'));

    assert.strictEqual(pythonTarget.archiveType, 'tar.gz');
    assert.strictEqual(pythonTarget.targetSubdir, 'python');
    assert.ok(pythonTarget.sources.length >= 2);
    assert.ok(pythonTarget.sources[0].url.includes('cpython-3.12.7%2B20241016-x86_64-unknown-linux-gnu'));
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

describe('Windows Node staging', () => {
  for (const [name, entrypoint, cacheHit] of [
    ['missing from a cached archive', 'missing', true],
    ['empty in a new download', 'empty', false],
    ['a directory instead of a file', 'directory', true],
  ] as const) {
    test(`rejects node.exe that is ${name}`, async (t) => {
      const root = makeRuntimeFixtureRoot(t);
      const fixture = path.join(root, 'fixture');
      fs.mkdirSync(fixture);
      fs.writeFileSync(path.join(fixture, 'README.md'), 'fixture');
      const entry = path.join(fixture, 'node.exe');
      if (entrypoint === 'empty') fs.writeFileSync(entry, '');
      if (entrypoint === 'directory') fs.mkdirSync(entry);

      const archiveType = process.platform === 'win32' ? 'zip' : 'tar.gz';
      const fixtureArchive = path.join(root, `fixture.${archiveType}`);
      execFileSync('tar', [archiveType === 'zip' ? '-acf' : '-czf', fixtureArchive, '-C', root, 'fixture']);
      const options = configureWindowsNodeFixture(t, root, archiveType, fs.readFileSync(fixtureArchive), cacheHit);
      const stagedNode = path.join(options.runtimeRoot, 'node');
      fs.mkdirSync(stagedNode, { recursive: true });
      fs.writeFileSync(path.join(stagedNode, 'node.exe'), 'stale runtime');

      await assert.rejects(prepareRuntime(options), /Windows Node staging for win32-x64 .*node\.exe/);
      assert.strictEqual(fs.existsSync(stagedNode), false);
      assert.strictEqual(fs.existsSync(path.join(options.runtimeRoot, 'manifest.json')), false);
      assert.strictEqual(options.fetchMock.mock.callCount(), cacheHit ? 0 : 1);
    });
  }

  test('rejects a checksum-valid but unreadable ZIP as an extraction error', { skip: process.platform !== 'win32' }, async (t) => {
    const root = makeRuntimeFixtureRoot(t);
    const options = configureWindowsNodeFixture(t, root, 'zip', Buffer.from('not a zip'), true);
    await assert.rejects(prepareRuntime(options), /failed: status=[1-9]/);
    assert.strictEqual(fs.existsSync(path.join(options.runtimeRoot, 'node')), false);
    assert.strictEqual(fs.existsSync(path.join(options.runtimeRoot, 'manifest.json')), false);
    assert.strictEqual(options.fetchMock.mock.callCount(), 0);
  });

  test('re-extracts a ZIP when Expand-Archive reports success without node.exe', { skip: process.platform !== 'win32' }, async (t) => {
    const root = makeRuntimeFixtureRoot(t);
    const fixture = path.join(root, 'fixture');
    fs.mkdirSync(fixture);
    fs.writeFileSync(path.join(fixture, 'node.exe'), 'fixture node');
    const archive = path.join(root, 'fixture.zip');
    execFileSync('tar', ['-acf', archive, '-C', root, 'fixture']);
    const options = configureWindowsNodeFixture(t, root, 'zip', fs.readFileSync(archive), true);

    const spawnSync = childProcess.spawnSync;
    const spawn = t.mock.method(childProcess, 'spawnSync', (command, args, spawnOptions) => {
      if (command !== 'powershell.exe') return spawnSync(command, args, spawnOptions);
      const probe = args.at(-1).startsWith('Get-Command');
      return { status: 0, signal: null, stdout: probe ? 'Expand-Archive\r\n' : '', stderr: '' };
    });
    syncBuiltinESMExports();
    t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });

    // The fixture ends after Node, before preparing Python or copying Git.
    await assert.rejects(prepareRuntime(options), /Runtime python is not defined/);
    assert.strictEqual(fs.readFileSync(path.join(options.runtimeRoot, 'node', 'node.exe'), 'utf8'), 'fixture node');
    assert.deepStrictEqual(spawn.mock.calls.map(call => call.arguments[0]), ['powershell.exe', 'powershell.exe', 'tar']);
    assert.strictEqual(options.fetchMock.mock.callCount(), 0);
  });
});

function makeRuntimeFixtureRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-stage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function configureWindowsNodeFixture(t: TestContext, root: string, archiveType: string, bytes: Buffer, cacheHit: boolean) {
  const filename = `node.${archiveType}`;
  const url = `https://nodejs.org/${filename}`;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const config = {
    runtimes: {
      node: { targets: { 'win32-x64': { archiveType, sources: [{ url, sha256 }] } } },
    },
  };
  const manifestPath = path.join(root, 'runtime-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(config));
  const downloadCacheDir = path.join(root, "cache $[runtime]'s files");
  if (cacheHit) {
    const cache = path.join(downloadCacheDir, 'node', 'win32-x64');
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, filename), bytes);
  }
  const originalFetch = globalThis.fetch;
  const fetchMock = t.mock.fn(async (request) => {
    assert.strictEqual(request, url);
    const response = new Response(Uint8Array.from(bytes));
    Object.defineProperty(response, 'url', { value: url });
    return response;
  });
  globalThis.fetch = fetchMock;
  t.after(() => { globalThis.fetch = originalFetch; });
  return { manifestPath, downloadCacheDir, runtimeRoot: path.join(root, 'runtime'), platform: 'win32', arch: 'x64', fetchMock };
}

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
