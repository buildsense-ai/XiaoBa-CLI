import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('SessionStore atomic persistence', () => {
  let testRoot: string;
  let originalCwd: string;
  let originalUserDataDir: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalUserDataDir = process.env.XIAOBA_USER_DATA_DIR;
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-session-atomic-'));
    process.env.XIAOBA_USER_DATA_DIR = testRoot;
    process.chdir(testRoot);
  });

  afterEach(() => {
    if (originalUserDataDir === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = originalUserDataDir;
    process.chdir(originalCwd);
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('publishes context and runtime state through same-directory temporary files', () => {
    const { SessionStore } = loadSessionStore();
    const store = SessionStore.getInstance();

    store.saveContext('user:atomic-success', [{ role: 'user', content: 'new durable history' }]);
    store.saveRuntimeState('user:atomic-success', { currentDirectory: '/workspace' });

    assert.deepStrictEqual(store.loadContext('user:atomic-success').map((message: any) => message.content), [
      'new durable history',
    ]);
    assert.equal(store.loadRuntimeState('user:atomic-success').currentDirectory, '/workspace');
    assert.deepStrictEqual(findTemporaryFiles(), []);
  });

  test('atomic replacement publishes only after the complete temporary file is written', () => {
    const { atomicWriteFileSync } = loadSessionStore();
    const calls: string[] = [];
    const fakeFileSystem = {
      writeFileSync(source: fs.PathLike, content: string) {
        calls.push(`write:${String(source)}:${content}`);
      },
      renameSync(source: fs.PathLike, target: fs.PathLike) {
        calls.push(`rename:${String(source)}:${String(target)}`);
      },
      existsSync() {
        calls.push('exists');
        return false;
      },
      unlinkSync() {
        calls.push('unlink');
      },
    };

    atomicWriteFileSync('/sessions/context.jsonl', 'complete snapshot', fakeFileSystem);

    assert.equal(calls.length, 2);
    assert.match(calls[0], /^write:\/sessions\/context\.jsonl\..+\.tmp:complete snapshot$/);
    assert.match(calls[1], /^rename:\/sessions\/context\.jsonl\..+\.tmp:\/sessions\/context\.jsonl$/);
  });

  test('failed temporary-file write removes a partial file without publishing it', () => {
    const { atomicWriteFileSync } = loadSessionStore();
    const targetPath = path.join(testRoot, 'write-failure.jsonl');
    let temporaryPath = '';
    const fakeFileSystem = {
      writeFileSync(source: fs.PathLike) {
        temporaryPath = String(source);
        fs.writeFileSync(source, 'partial snapshot', 'utf-8');
        throw new Error('simulated write failure');
      },
      renameSync() {
        throw new Error('rename must not run');
      },
      existsSync: fs.existsSync,
      unlinkSync: fs.unlinkSync,
    };

    assert.throws(
      () => atomicWriteFileSync(targetPath, 'replacement snapshot', fakeFileSystem),
      /simulated write failure/,
    );
    assert.equal(fs.existsSync(targetPath), false);
    assert.equal(fs.existsSync(temporaryPath), false);
  });

  test('failed replacement keeps the canonical snapshot untouched and removes the temporary file', () => {
    const { atomicWriteFileSync } = loadSessionStore();
    const targetPath = path.join(testRoot, 'session.jsonl');
    fs.writeFileSync(targetPath, 'previous durable snapshot', 'utf-8');
    let temporaryPath = '';
    const fakeFileSystem = {
      writeFileSync(source: fs.PathLike, content: string, options: fs.WriteFileOptions) {
        temporaryPath = String(source);
        fs.writeFileSync(source, content, options);
      },
      renameSync() {
        const error = new Error('simulated rename failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      },
      existsSync: fs.existsSync,
      unlinkSync: fs.unlinkSync,
    };

    assert.throws(
      () => atomicWriteFileSync(targetPath, 'replacement snapshot', fakeFileSystem),
      /simulated rename failure/,
    );
    assert.equal(fs.readFileSync(targetPath, 'utf-8'), 'previous durable snapshot');
    assert.equal(fs.existsSync(temporaryPath), false);
  });

  test('saveContext failure preserves the previously published durable context', () => {
    const { SessionStore } = loadSessionStore();
    const healthyStore = new SessionStore();
    healthyStore.saveContext('user:context-call-path', [{ role: 'user', content: 'previous context' }]);
    const failingStore = new SessionStore(() => {
      throw new Error('simulated context publish failure');
    });

    failingStore.saveContext('user:context-call-path', [{ role: 'user', content: 'replacement context' }]);

    assert.deepStrictEqual(healthyStore.loadContext('user:context-call-path').map((message: any) => message.content), [
      'previous context',
    ]);
  });

  test('saveRuntimeState failure preserves the previously published runtime state', () => {
    const { SessionStore } = loadSessionStore();
    const healthyStore = new SessionStore();
    healthyStore.saveRuntimeState('user:state-call-path', {
      currentDirectory: '/previous',
      remoteContextCursors: { source: 7 },
    });
    const failingStore = new SessionStore(() => {
      throw new Error('simulated state publish failure');
    });

    failingStore.saveRuntimeState('user:state-call-path', {
      currentDirectory: '/replacement',
      remoteContextCursors: { source: 8 },
    });

    const restored = healthyStore.loadRuntimeState('user:state-call-path');
    assert.equal(restored.currentDirectory, '/previous');
    assert.equal(restored.remoteContextCursors?.source, 7);
  });

  test('migration write-back failure still returns the sanitized readable history', () => {
    const { SessionStore } = loadSessionStore();
    const sessionsDir = path.join(testRoot, 'data', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, 'user_migration-failure.jsonl'),
      `${JSON.stringify({ role: 'user', content: 'readable history' })}\n{damaged final line`,
      'utf-8',
    );
    const failingStore = new SessionStore(() => {
      throw new Error('simulated migration publish failure');
    });

    const restored = failingStore.loadContext('user:migration-failure');

    assert.deepStrictEqual(restored.map((message: any) => message.content), ['readable history']);
  });

  function findTemporaryFiles(): string[] {
    const dataRoot = path.join(testRoot, 'data');
    if (!fs.existsSync(dataRoot)) return [];
    const files: string[] = [];
    for (const directory of ['sessions', 'session-state']) {
      const absolute = path.join(dataRoot, directory);
      if (!fs.existsSync(absolute)) continue;
      files.push(...fs.readdirSync(absolute).filter(name => name.endsWith('.tmp')));
    }
    return files;
  }
});

function loadSessionStore(): any {
  for (const modulePath of [
    '../src/utils/path-resolver',
    '../src/utils/session-store',
  ]) {
    delete require.cache[require.resolve(modulePath)];
  }
  return require('../src/utils/session-store');
}
