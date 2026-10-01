import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MAX_LOCAL_KNOWLEDGE_ENTRIES,
  projectLocalKnowledgeLane,
  searchLocalKnowledgeLane,
} from '../src/core/catslog-knowledge-lane';
import { isMemoryCitationRef } from '../src/tools/memory-branch-tools';

const KB_ID = 'KB-11111111-2222-4333-8444-555555555555';

function writeManagedDoc(root: string, id: string, title: string, summary: string, body: string): void {
  const metadata = {
    id,
    title,
    summary,
    category: 'deploy',
    updatedAt: '2026-09-01T00:00:00.000Z',
    change: 'initial write',
    sources: ['stream-deploy#3'],
  };
  const documents = path.join(root, 'documents');
  fs.mkdirSync(documents, { recursive: true });
  fs.writeFileSync(path.join(documents, `${id}.md`), `---\n${JSON.stringify(metadata)}\n---\n\n${body}\n`, 'utf-8');
}

function writeSourceDoc(root: string, relative: string, body: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf-8');
}

/** Fake knowledge.cjs: emits a fixed JSON envelope and records argv for assertions. */
function writeFakeScript(dir: string, body: string): string {
  const file = path.join(dir, 'fake-knowledge.cjs');
  fs.writeFileSync(file, body, 'utf-8');
  return file;
}

describe('local knowledge lane (L0)', () => {
  let testRoot: string;
  let previousUserDataDir: string | undefined;
  let previousNodeExecutable: string | undefined;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-knowledge-lane-'));
    previousUserDataDir = process.env.XIAOBA_USER_DATA_DIR;
    previousNodeExecutable = process.env.XIAOBA_NODE_EXECUTABLE;
    process.env.XIAOBA_USER_DATA_DIR = testRoot;
    delete process.env.XIAOBA_NODE_EXECUTABLE;
  });

  afterEach(() => {
    if (previousUserDataDir === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = previousUserDataDir;
    if (previousNodeExecutable === undefined) delete process.env.XIAOBA_NODE_EXECUTABLE;
    else process.env.XIAOBA_NODE_EXECUTABLE = previousNodeExecutable;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('missing knowledge root degrades to a typed unavailable status without invoking the script', async () => {
    const result = await searchLocalKnowledgeLane({
      keywords: ['release'],
      scriptPath: path.join(testRoot, 'nope.cjs'),
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.error, 'knowledge_root_missing');
    assert.deepEqual(result.entries, []);
  });

  test('missing script degrades to knowledge_script_missing', async () => {
    const root = path.join(testRoot, 'knowledge');
    fs.mkdirSync(root, { recursive: true });
    const result = await searchLocalKnowledgeLane({
      keywords: ['release'],
      knowledgeRoot: root,
      scriptPath: path.join(testRoot, 'nope.cjs'),
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.error, 'knowledge_script_missing');
  });

  test('searches the bundled knowledge.cjs and maps managed + source hits to citable refs', async () => {
    const root = path.join(testRoot, 'knowledge');
    writeManagedDoc(root, KB_ID, 'Deploy runbook', 'nginx read-only mount decision', '# Deploy runbook\n\nnginx stays read-only for release safety.');
    writeSourceDoc(root, 'documents/rollback-notes.md', '# Rollback notes\n\nRollback switches the feature flag off.');

    const result = await searchLocalKnowledgeLane({ keywords: ['nginx', 'rollback'], knowledgeRoot: root });
    assert.equal(result.status, 'ok');
    assert.equal(result.keywordsFailed, 0);
    assert.deepEqual(result.keywordsQueried, ['nginx', 'rollback']);

    const managed = result.entries.find(entry => entry.id === KB_ID);
    assert.ok(managed, 'managed KB document must be found');
    assert.equal(managed.ref, `kb:${KB_ID}`);
    assert.equal(managed.managed, true);
    assert.equal(managed.title, 'Deploy runbook');
    assert.equal(managed.category, 'deploy');
    assert.equal(managed.updated_at, '2026-09-01T00:00:00.000Z');
    assert.match(managed.revision, /^[a-f0-9]{64}$/);
    assert.match(managed.summary, /read-only mount/);

    const source = result.entries.find(entry => entry.id === 'file:documents/rollback-notes.md');
    assert.ok(source, 'raw source document must be found');
    assert.equal(source.ref, 'file:documents/rollback-notes.md');
    assert.equal(source.managed, false);
    assert.equal(source.title, 'Rollback notes');

    for (const entry of result.entries) {
      assert.equal(isMemoryCitationRef(entry.ref), true, `ref must be citable: ${entry.ref}`);
    }
  });

  test('caps the search at the top 3 keywords and dedupes hits across keywords', async () => {
    const callsDir = fs.mkdtempSync(path.join(testRoot, 'calls-'));
    const script = writeFakeScript(testRoot, `
      const fs = require('node:fs');
      const keywords = JSON.parse(process.argv[5]);
      if (process.argv[4] !== 'search-any') throw new Error('expected batched search-any');
      fs.appendFileSync(${JSON.stringify(callsDir)} + '/processes', '1\\n');
      for (const keyword of keywords) {
        fs.writeFileSync(${JSON.stringify(callsDir)} + '/marker-' + encodeURIComponent(keyword), 'x');
      }
      const keyword = keywords[0];
      process.stdout.write(JSON.stringify({ ok: true, total: 1, items: [{
        id: 'KB-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        title: 'shared doc ' + keyword,
        summary: 'one summary',
        category: 'deploy',
        updatedAt: '2026-09-02T00:00:00.000Z',
        revision: 'f'.repeat(64),
        managed: true,
        file: 'documents/KB-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.md',
      }] }) + '\\n');
    `);
    const root = path.join(testRoot, 'knowledge');
    fs.mkdirSync(root, { recursive: true });

    const result = await searchLocalKnowledgeLane({
      keywords: ['k1', 'k2', 'k3', 'k4', 'k5'],
      knowledgeRoot: root,
      scriptPath: script,
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.keywordsCapped, true);
    assert.deepEqual(result.keywordsQueried, ['k1', 'k2', 'k3']);
    assert.deepEqual(
      fs.readdirSync(callsDir).filter(name => name.startsWith('marker-')).sort()
        .map(name => decodeURIComponent(name.replace('marker-', ''))),
      ['k1', 'k2', 'k3'],
      'exactly the top 3 keywords must be searched',
    );
    assert.equal(fs.readFileSync(path.join(callsDir, 'processes'), 'utf8'), '1\n',
      'all selected keywords must share one process');
    assert.equal(result.entries.length, 1, 'identical hits dedupe by ref');
    assert.equal(result.entries[0].ref, 'kb:KB-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });

  test('caps collected entries at 8 and marks the lane truncated', async () => {
    const items = Array.from({ length: MAX_LOCAL_KNOWLEDGE_ENTRIES + 4 }, (_, index) => {
      const hex = String(index + 1).padStart(2, '0');
      const id = `KB-00000000-0000-4000-8000-0000000000${hex}`;
      return {
        id,
        title: `doc ${index}`,
        summary: 's',
        category: 'deploy',
        updatedAt: '2026-09-03T00:00:00.000Z',
        revision: 'a'.repeat(64),
        managed: true,
        file: `documents/${id}.md`,
      };
    });
    const script = writeFakeScript(testRoot, `
      process.stdout.write(JSON.stringify({ ok: true, total: ${items.length}, items: ${JSON.stringify(items)} }) + '\\n');
    `);
    const root = path.join(testRoot, 'knowledge');
    fs.mkdirSync(root, { recursive: true });

    const result = await searchLocalKnowledgeLane({
      keywords: ['release'],
      knowledgeRoot: root,
      scriptPath: script,
    });
    assert.equal(result.status, 'truncated');
    assert.equal(result.entries.length, MAX_LOCAL_KNOWLEDGE_ENTRIES);
    assert.equal(result.entriesCapped, true);
  });

  test('script failure, non-JSON output, and ok:false envelopes all degrade to unavailable', async () => {
    const root = path.join(testRoot, 'knowledge');
    fs.mkdirSync(root, { recursive: true });

    const failing = await searchLocalKnowledgeLane({
      keywords: ['release'],
      knowledgeRoot: root,
      scriptPath: writeFakeScript(testRoot, `
        process.stdout.write(JSON.stringify({ ok: false, code: 'INVALID_PATH', message: 'Path escapes knowledge root.' }) + '\\n');
        process.exitCode = 1;
      `),
    });
    assert.equal(failing.status, 'unavailable');
    assert.match(String(failing.error), /Path escapes knowledge root/);

    const nonJson = await searchLocalKnowledgeLane({
      keywords: ['release'],
      knowledgeRoot: root,
      scriptPath: writeFakeScript(testRoot, `process.stdout.write('not json');`),
    });
    assert.equal(nonJson.status, 'unavailable');
    assert.match(String(nonJson.error), /non-JSON/);

    const badEnvelope = await searchLocalKnowledgeLane({
      keywords: ['release'],
      knowledgeRoot: root,
      scriptPath: writeFakeScript(testRoot, `process.stdout.write(JSON.stringify([1, 2, 3]));`),
    });
    assert.equal(badEnvelope.status, 'unavailable');
    assert.match(String(badEnvelope.error), /unusable envelope/);
  });

  test('one batch deadline kills the script and degrades to unavailable', async () => {
    const root = path.join(testRoot, 'knowledge');
    fs.mkdirSync(root, { recursive: true });
    const script = writeFakeScript(testRoot, `
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ ok: true, total: 0, items: [] }) + '\\n');
      }, 5000);
    `);

    const result = await searchLocalKnowledgeLane({
      keywords: ['release'],
      knowledgeRoot: root,
      scriptPath: script,
      timeoutMs: 200,
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.entries.length, 0);
    assert.ok(String(result.error).length > 0);
  });

  test('malformed items are skipped: missing id, unsafe KB id shape, traversal file path', async () => {
    const script = writeFakeScript(testRoot, `
      process.stdout.write(JSON.stringify({ ok: true, total: 4, items: [
        { title: 'no id', summary: 's', category: 'c', updatedAt: 'x', revision: 'r', managed: true },
        { id: 'not-a-kb-id', title: 'bad id', summary: 's', category: 'c', updatedAt: 'x', revision: 'r', managed: true },
        { id: 'file:documents/../../etc/hosts.md', title: 'traversal', summary: 's', category: 'sources', updatedAt: 'x', revision: 'r', managed: false, file: 'documents/../../etc/hosts.md' },
        { id: 'KB-cccccccc-dddd-4eee-8fff-000000000001', title: 'good', summary: 's', category: 'deploy', updatedAt: '2026-09-04T00:00:00.000Z', revision: 'b'.repeat(64), managed: true, file: 'documents/KB-cccccccc-dddd-4eee-8fff-000000000001.md' },
      ] }) + '\\n');
    `);
    const root = path.join(testRoot, 'knowledge');
    fs.mkdirSync(root, { recursive: true });

    const result = await searchLocalKnowledgeLane({
      keywords: ['release'],
      knowledgeRoot: root,
      scriptPath: script,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].ref, 'kb:KB-cccccccc-dddd-4eee-8fff-000000000001');
  });

  test('keyword cap does not imply missing entries or truncated model evidence', async () => {
    const root = path.join(testRoot, 'knowledge');
    writeManagedDoc(root, KB_ID, 'DERP', 'DERP deployment', '# derper\nDERP socket tailscale');
    const result = await searchLocalKnowledgeLane({
      keywords: ['DERP', 'derper', 'tailscale', 'certificate'], knowledgeRoot: root,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.keywordsCapped, true);
    assert.equal(result.entriesCapped, false);
    const pack = projectLocalKnowledgeLane(result);
    assert.equal(pack.scope, 'per_instance_shared');
    assert.equal(pack.keywords_capped, true);
    assert.equal(pack.truncated, false);
    assert.equal((pack.entries as any[])[0].ref, `kb:${KB_ID}`);
    const small = projectLocalKnowledgeLane(result, 300);
    assert.equal(small.truncated, true);
    assert.equal(small.projection_capped, true);
  });

  test('no hits returns empty rather than ok with an empty entries array', async () => {
    const root = path.join(testRoot, 'knowledge');
    writeManagedDoc(root, KB_ID, 'DERP', 'DERP deployment', '# derper');
    const result = await searchLocalKnowledgeLane({ keywords: ['not-present'], knowledgeRoot: root });
    assert.equal(result.status, 'empty');
    assert.equal(result.entriesCapped, false);
  });

  test('empty keyword list yields empty status without touching the filesystem', async () => {
    const result = await searchLocalKnowledgeLane({
      keywords: [],
      knowledgeRoot: path.join(testRoot, 'absent'),
      scriptPath: path.join(testRoot, 'absent.cjs'),
    });
    assert.equal(result.status, 'empty');
    assert.deepEqual(result.entries, []);
  });
});
