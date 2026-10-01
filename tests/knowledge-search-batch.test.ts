import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { KnowledgeStore, main } = require('../skills/xiaoba-knowledge/scripts/knowledge.cjs');

describe('knowledge search-any batch', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-batch-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  function source(name: string, text: string): void {
    fs.mkdirSync(path.join(root, 'documents'), { recursive: true });
    fs.writeFileSync(path.join(root, 'documents', name), text);
  }

  test('matches per-keyword first-page union with one documents scan, preserving priority and AND semantics', () => {
    source('a.md', '# rollback\n回滚 nginx');
    source('b.md', '# deployment\n发布 only');
    source('c.md', '# budget\n审批 only');
    source('d.md', '# both\n回滚 发布 nginx');
    const store = new KnowledgeStore(root);
    const queries = ['发布', '回滚 nginx', '审批'];
    const expected = new Map();
    for (const query of queries) {
      for (const item of store.index(query).items) if (!expected.has(item.id)) expected.set(item.id, item);
    }
    let scans = 0;
    const original = store.documents.bind(store);
    store.documents = (...args: any[]) => { scans++; return original(...args); };
    const actual = store.searchAny(queries);
    assert.equal(scans, 1);
    assert.deepEqual(actual.items, Array.from(expected.values()));
    assert.equal(actual.total, expected.size);
    assert.equal(actual.truncated, false);
  });

  test('reports pagination loss rather than claiming an exhaustive union', () => {
    for (let i = 0; i < 35; i++) source(`${String(i).padStart(2, '0')}.md`, '# common\ncommon');
    source('unique.md', '# unique\n独立');
    const result = new KnowledgeStore(root).searchAny(['common', '独立']);
    assert.equal(result.total, 36);
    assert.equal(result.items.length, 31);
    assert.equal(result.truncated, true);
    assert.equal(result.items.at(-1).id, 'file:documents/unique.md');
  });

  test('validates batch bounds and empty/control terms before scanning', async () => {
    const store = new KnowledgeStore(root);
    store.documents = () => { throw new Error('unexpected scan'); };
    for (const invalid of [[], ['a', 'b', 'c', 'd'], [''], [42], ['a\u0001'], ['汉'.repeat(65)]]) {
      assert.throws(() => store.searchAny(invalid), /1-3 nonempty/);
    }
    await assert.rejects(() => main(['--root', root, 'search-any', '{broken']), /JSON array/);
  });

  test('reads fresh revision/content on every batch; no stale result cache', () => {
    source('fact.md', '# before\noldterm');
    const store = new KnowledgeStore(root);
    const before = store.searchAny(['oldterm']).items[0];
    source('fact.md', '# after\nnewterm');
    assert.equal(store.searchAny(['oldterm']).items.length, 0);
    const after = store.searchAny(['newterm']).items[0];
    assert.notEqual(before.revision, after.revision);
  });

  test('unsafe linked documents remain warnings and never leak source content', () => {
    source('safe.md', '# safe\ncommon');
    fs.writeFileSync(path.join(root, 'outside.md'), '# private\ncommon');
    fs.symlinkSync(path.join(root, 'outside.md'), path.join(root, 'documents', 'linked.md'));
    const result = new KnowledgeStore(root).searchAny(['common']);
    assert.deepEqual(result.items.map((item: any) => item.id), ['file:documents/safe.md']);
    assert.equal(result.warnings[0].code, 'UNSAFE_PATH');
  });
});
