import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const script = path.resolve('skills/xiaoba-knowledge/scripts/wiki.cjs');
const roots: string[] = [];
const id = 'KB-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('readonly knowledge Wiki Skill entry', () => {
  test('lists metadata and reads the exact managed document', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-wiki-')); roots.push(root);
    fs.mkdirSync(path.join(root, 'documents'));
    fs.writeFileSync(path.join(root, 'documents', `${id}.md`), `---\n${JSON.stringify({ id, title: '合同', summary: '摘要', category: 'procedures', updatedAt: '2026-09-11T00:00:00Z', change: '导入', sources: ['S1'] })}\n---\n\n正文内容`);
    const list = JSON.parse(execFileSync(process.execPath, [script, root, 'knowledge.document.list', '{}'], { encoding: 'utf8' }));
    assert.equal(list.ok, true); assert.equal(list.total, 1); assert.equal(list.items[0].id, id); assert.equal('file' in list.items[0], false);
    const read = JSON.parse(execFileSync(process.execPath, [script, root, 'knowledge.document.read', JSON.stringify({ id })], { encoding: 'utf8' }));
    assert.equal(read.ok, true); assert.match(read.body, /正文内容/); assert.deepEqual(read.sources, ['S1']);
  });

  test('rejects a path and does not expose unqualified source files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-wiki-')); roots.push(root);
    fs.mkdirSync(path.join(root, 'documents')); fs.writeFileSync(path.join(root, 'documents', 'notes.md'), '# raw');
    const read = JSON.parse(execFileSync(process.execPath, [script, root, 'knowledge.document.read', JSON.stringify({ id: 'file:documents/notes.md' })], { encoding: 'utf8' }));
    assert.equal(read.ok, false); assert.equal(read.code, 'INVALID_ID');
    const list = JSON.parse(execFileSync(process.execPath, [script, root, 'knowledge.document.list', '{}'], { encoding: 'utf8' }));
    assert.equal(list.total, 0);
  });
});
