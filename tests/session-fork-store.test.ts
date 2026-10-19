import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-fork-'));
process.env.XIAOBA_USER_DATA_DIR = root;
const require = createRequire(import.meta.url);
const { SessionStore } = require('../src/utils/session-store');
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('fork is durable, independent and retry cannot replace subsequent target progress', () => {
  const store = new SessionStore();
  store.saveContext('source', [{ role: 'user', content: 'approved' }, { role: 'assistant', content: 'ready' }]);
  const snapshot = { version: 1, requestId: 'req1', sourceSessionKey: 'source', targetSessionKey: 'target', sourceLastSeq: 5,
    currentDirectory: 'D:/project', messages: store.loadContext('source') };
  assert.equal(store.installFork(snapshot), 'created');
  const restarted = new SessionStore();
  assert.equal(restarted.hasSession('target'), true);
  assert.equal(JSON.stringify(restarted.loadContext('target')), JSON.stringify(store.loadContext('source')));
  assert.equal(restarted.loadRuntimeState('target').currentDirectory, 'D:/project');
  assert.equal(restarted.saveContext('target', [{ role: 'user', content: 'new branch work' }]), true);
  assert.equal(restarted.installFork(snapshot), 'existing');
  assert.equal(restarted.loadContext('target').length, 1);
  assert.equal(restarted.loadContext('target')[0].content, 'new branch work');
  assert.equal(store.loadContext('source')[0].content, 'approved');
  assert.throws(() => restarted.installFork({ ...snapshot, requestId: 'different' }), /different|exists/i);
  restarted.saveContext('target', []);
  assert.equal(restarted.installFork(snapshot), 'existing');
  assert.deepEqual(restarted.loadContext('target'), []);
  assert.equal(restarted.deleteSession('source'), true);
  assert.deepEqual(restarted.loadContext('target'), []);
});

test('fork does not overwrite a previously existing unrelated session', () => {
  const store = new SessionStore();
  store.saveContext('occupied', [{ role: 'user', content: 'keep me' }]);
  assert.throws(() => store.installFork({ version: 1, requestId: 'req2', sourceSessionKey: 'other', targetSessionKey: 'occupied', sourceLastSeq: 1, messages: [] }), /exists/i);
  assert.equal(store.loadContext('occupied')[0].content, 'keep me');
});

test('fork publication retries transient rename failures without removing the destination', (t) => {
  const store = new SessionStore();
  store.installFork({ version: 1, requestId: 'rename-retry', sourceSessionKey: 'old',
    targetSessionKey: 'rename-retry', sourceLastSeq: 1, messages: [{ role: 'user', content: 'old' }] });
  const nativeFs = require('fs');
  const rename = nativeFs.renameSync;
  let attempts = 0;
  const destination = path.join(root, 'data', 'session-forks', 'rename-retry.json');
  t.mock.method(nativeFs, 'renameSync', (source: string, target: string) => {
    if (target === destination && ++attempts <= 2) {
      assert.equal(fs.existsSync(destination), true);
      throw Object.assign(new Error('transient sharing lock'), { code: 'EPERM' });
    }
    return rename(source, target);
  });
  assert.equal(store.saveContext('rename-retry', [{ role: 'user', content: 'new' }]), true);
  assert.equal(attempts, 3);
  assert.equal(new SessionStore().loadContext('rename-retry')[0].content, 'new');
});

for (const code of ['EPERM', 'EIO']) {
  test(`fork publication fails safely after ${code} without replacing history`, (t) => {
    const store = new SessionStore();
    const key = `rename-failure-${code}`;
    store.installFork({ version: 1, requestId: key, sourceSessionKey: 'old',
      targetSessionKey: key, sourceLastSeq: 1, messages: [{ role: 'user', content: 'keep' }] });
    const nativeFs = require('fs');
    const rename = nativeFs.renameSync;
    let attempts = 0;
    const destination = path.join(root, 'data', 'session-forks', `${key}.json`);
    t.mock.method(nativeFs, 'renameSync', (source: string, target: string) => {
      if (target === destination) {
        attempts++;
        throw Object.assign(new Error('publication unavailable'), { code });
      }
      return rename(source, target);
    });
    assert.equal(store.saveContext(key, [{ role: 'user', content: 'discard' }]), false);
    assert.equal(attempts, code === 'EPERM' ? 4 : 1);
    assert.equal(new SessionStore().loadContext(key)[0].content, 'keep');
    assert.equal(fs.readdirSync(path.dirname(destination)).some(name => name.startsWith(`${key}.json.`)), false);
  });
}

test('fork survives source deletion and starts with no interruption or source cursors', () => {
  const store = new SessionStore();
  store.saveContext('independent-source', [{ role: 'user', content: 'shared past' }]);
  store.saveRuntimeState('independent-source', { currentDirectory: root,
    remoteContextCursors: { 'catscompany.agent_context': 7 },
    interruptedTurn: { topic: 'old', reason: 'crash', startedAt: new Date().toISOString(), attempts: 1 } });
  store.installFork({ version: 1, requestId: 'independent', sourceSessionKey: 'independent-source',
    targetSessionKey: 'independent-target', sourceLastSeq: 7, currentDirectory: root,
    messages: store.readContextForFork('independent-source') });
  store.deleteSession('independent-source');
  const restarted = new SessionStore();
  assert.equal(restarted.loadContext('independent-target')[0].content, 'shared past');
  assert.deepEqual(restarted.loadRuntimeState('independent-target'), { currentDirectory: root });
  const changed = restarted.readContextForFork('independent-target');
  changed[0].content = 'caller mutation';
  assert.equal(restarted.readContextForFork('independent-target')[0].content, 'shared past');
});

test('strict fork read refuses corrupted or absent source without silently truncating history', () => {
  const store = new SessionStore();
  store.saveContext('damaged', [{ role: 'user', content: 'keep' }]);
  const file = path.join(root, 'data', 'sessions', 'damaged.jsonl');
  fs.appendFileSync(file, '{broken\n');
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => store.readContextForFork('damaged'));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.throws(() => store.readContextForFork('missing'), /unavailable/i);
});

test('clearing a fork retains only identity and never resurrects its bootstrap on retry', () => {
  const store = new SessionStore();
  const snapshot = { version: 1, requestId: 'clear-retry', sourceSessionKey: 'clear-source',
    targetSessionKey: 'clear-child', sourceLastSeq: 8,
    currentDirectory: root, messages: [{ role: 'user', content: 'erase this history' }] };
  store.installFork(snapshot);
  store.saveContext('clear-child', [{ role: 'assistant', content: 'erase newer history too' }]);
  assert.equal(store.deleteSession('clear-child', { preserveForkIdentity: true }), true);
  const restarted = new SessionStore();
  assert.equal(restarted.hasSession('clear-child'), true);
  assert.deepEqual(restarted.loadContext('clear-child'), []);
  assert.deepEqual(restarted.loadRuntimeState('clear-child'), {});
  assert.equal(restarted.getForkIdentity('clear-child').requestId, 'clear-retry');
  assert.equal(restarted.installFork(snapshot), 'existing');
  assert.deepEqual(restarted.readContextForFork('clear-child'), []);
});

test('lost or corrupt progressed fork context never falls back to an obsolete bootstrap', () => {
  const store = new SessionStore();
  store.installFork({ version: 1, requestId: 'lost-progress', sourceSessionKey: 'old',
    targetSessionKey: 'progressed', sourceLastSeq: 4,
    messages: [{ role: 'user', content: 'old snapshot' }] });
  store.saveContext('progressed', [{ role: 'assistant', content: 'new checkpoint', __checkpointSummary: true }]);
  store.saveRuntimeState('progressed', { currentDirectory: 'D:/new-work' });
  const file = path.join(root, 'data', 'sessions', 'progressed.jsonl');
  fs.appendFileSync(file, '{corrupt\n');
  assert.throws(() => new SessionStore().loadContext('progressed'));
  fs.unlinkSync(file);
  const restarted = new SessionStore();
  assert.equal(restarted.hasSession('progressed'), false);
  assert.throws(() => restarted.readContextForFork('progressed'), /unavailable/i);
  assert.throws(() => restarted.loadContext('progressed'), /unavailable/i);
  assert.equal(restarted.loadRuntimeState('progressed').currentDirectory, 'D:/new-work');
  assert.equal(restarted.getForkIdentity('progressed').requestId, 'lost-progress');
});
