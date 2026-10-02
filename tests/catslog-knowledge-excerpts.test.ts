import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { main: knowledgeMain } = require('../skills/xiaoba-knowledge/scripts/knowledge.cjs');

import {
  EXCERPT_LEAD_CONTEXT_CHARS,
  MAX_KNOWLEDGE_EXCERPT_CHARS,
  MAX_KNOWLEDGE_EXCERPT_ENTRIES,
  excerptSelectionTerms,
  planKnowledgeExcerptRequests,
  readKnowledgeExcerpts,
  selectKnowledgeExcerpt,
} from '../src/core/catslog-knowledge-excerpts';
import {
  MAX_LOCAL_KNOWLEDGE_KEYWORDS,
  projectLocalKnowledgeLane,
  searchLocalKnowledgeLane,
} from '../src/core/catslog-knowledge-lane';
import type { KnowledgeExcerptRequest } from '../src/core/catslog-knowledge-excerpts';

const REAL_SCRIPT = require.resolve('../skills/xiaoba-knowledge/scripts/knowledge.cjs');

const KB_A = 'KB-11111111-2222-4333-8444-555555555555';
const KB_B = 'KB-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const KB_C = 'KB-cccccccc-dddd-4eee-8fff-000000000003';
const KB_MISSING = 'KB-99999999-9999-4999-8999-999999999999';
const OLD_REVISION = 'a'.repeat(64);
const STALE_BODY_MARKER = 'ROTATED-SECRET-BODY-TEXT';

function writeManagedDoc(
  root: string,
  id: string,
  body: string,
  options: { updatedAt?: string; summary?: string } = {},
): string {
  const metadata = {
    id,
    title: `Doc ${id.slice(3, 11)}`,
    summary: options.summary ?? 'managed summary',
    category: 'deploy',
    updatedAt: options.updatedAt ?? '2026-09-01T00:00:00.000Z',
    change: 'initial write',
    sources: ['S1'],
  };
  const documents = path.join(root, 'documents');
  fs.mkdirSync(documents, { recursive: true });
  const raw = `---\n${JSON.stringify(metadata)}\n---\n\n${body}\n`;
  fs.writeFileSync(path.join(documents, `${id}.md`), raw, 'utf-8');
  return raw;
}

/** The store's revision is the SHA-256 of the raw file bytes. */
function revisionOfRaw(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function writeSourceDoc(root: string, relative: string, body: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf-8');
}

function listTree(target: string): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) visit(file);
      else found.push(path.relative(target, file));
    }
  };
  visit(target);
  return found;
}

/**
 * Fake knowledge.cjs: logs every invocation, fabricates the search-any
 * envelope, and delegates every other command to the REAL script so batch
 * reads exercise the official KnowledgeStore.read path.
 */
function writeDelegatingScript(
  dir: string,
  searchEnvelope: string,
  options: { sleepBeforeReadMs?: number; sleepBeforeSearchMs?: number } = {},
): string {
  const log = path.join(dir, 'invocations.jsonl');
  const file = path.join(dir, 'fake-then-real-knowledge.cjs');
  fs.writeFileSync(file, `
    const fs = require('node:fs');
    const LOG = ${JSON.stringify(log)};
    const REAL = ${JSON.stringify(REAL_SCRIPT)};
    const args = process.argv.slice(2);
    fs.appendFileSync(LOG, JSON.stringify(args) + '\\n');
    function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
    if (args[2] === 'search-any') {
      ${options.sleepBeforeSearchMs ? `sleep(${options.sleepBeforeSearchMs});` : ''}
      process.stdout.write(${JSON.stringify(searchEnvelope)} + '\\n');
      return;
    }
    ${options.sleepBeforeReadMs ? `sleep(${options.sleepBeforeReadMs});` : ''}
    const real = require(REAL);
    real.main(args).then(
      result => process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\\n'),
      error => {
        process.stdout.write(JSON.stringify({ ok: false, code: error.code || 'KNOWLEDGE_ERROR', message: error.message }) + '\\n');
        process.exitCode = 1;
      },
    );
  `, 'utf-8');
  return file;
}

function readInvocations(dir: string): string[][] {
  const log = path.join(dir, 'invocations.jsonl');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as string[]);
}

function assertNoSplitSurrogates(text: string): void {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      assert.ok(index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff,
        `unpaired high surrogate at ${index}`);
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      assert.ok(index > 0 && text.charCodeAt(index - 1) >= 0xd800 && text.charCodeAt(index - 1) <= 0xdbff,
        `unpaired low surrogate at ${index}`);
    }
  }
}

describe('knowledge.cjs read-batch seam (strictly read-only)', () => {
  let root: string;
  let scratch: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-kb-readbatch-'));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-kb-readbatch-scratch-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  function putDoc(id: string, body: string): string {
    // Write the document in the exact store format; the store's revision is
    // the SHA-256 of the raw file bytes.
    return revisionOfRaw(writeManagedDoc(root, id, body));
  }

  test('returns bodies only on an exact revision match; mismatches, missing and malformed are typed per item', async () => {
    const revision = putDoc(KB_A, '# Seam\n\nnginx stays read-only.');
    const batch = await knowledgeMain(['--root', root, 'read-batch', JSON.stringify([
      { id: KB_A, expectedRevision: revision },
      { id: KB_A, expectedRevision: OLD_REVISION },
      { id: KB_MISSING, expectedRevision: OLD_REVISION },
      { id: '../../etc/passwd', expectedRevision: OLD_REVISION },
      { id: KB_A, expectedRevision: 'short' },
    ])]) as { results: Array<Record<string, unknown>> };

    // main() returns the raw result; the CLI entrypoint (used by the lane)
    // wraps it as { ok: true, ... } — covered by the delegating lane tests.
    const results = batch.results;
    assert.equal(results.length, 5);
    assert.equal(results[0].status, 'ok');
    assert.equal(results[0].revision, revision);
    assert.match(String(results[0].body), /nginx stays read-only/);
    assert.equal(results[1].status, 'revision_mismatch');
    assert.equal(results[1].revision, revision, 'current revision reported as metadata');
    assert.equal('body' in results[1], false, 'mismatched body is never emitted');
    assert.equal(results[2].status, 'not_found');
    assert.equal('body' in results[2], false);
    assert.equal(results[3].status, 'read_error');
    assert.equal(results[3].code, 'INVALID_INPUT');
    assert.equal(results[4].status, 'read_error');
  });

  test('honors the existing read paging contract (offset/nextOffset)', async () => {
    const body = `# Paged\n\n${'p'.repeat(13000)}`;
    const revision = putDoc(KB_A, body);
    const batch = await knowledgeMain(['--root', root, 'read-batch', JSON.stringify([
      { id: KB_A, expectedRevision: revision },
      { id: KB_A, expectedRevision: revision, offset: 12000 },
    ])]) as { results: Array<Record<string, unknown>> };

    assert.equal((batch.results[0].body as string).length, 12000);
    assert.equal(batch.results[0].nextOffset, 12000);
    assert.equal(batch.results[0].offset, 0);
    assert.equal((batch.results[1].body as string).length, body.length + 1 - 12000);
    assert.equal(batch.results[1].nextOffset, null);
    assert.equal(batch.results[1].offset, 12000);
  });

  test('enforces batch bounds: 1-8 object requests and parseable JSON', async () => {
    const nine = Array.from({ length: 9 }, () => ({ id: KB_A, expectedRevision: OLD_REVISION }));
    await assert.rejects(() => knowledgeMain(['--root', root, 'read-batch', '[]']), /1-8 read request/);
    await assert.rejects(() => knowledgeMain(['--root', root, 'read-batch', JSON.stringify(nine)]), /1-8 read request/);
    await assert.rejects(() => knowledgeMain(['--root', root, 'read-batch', '{broken']), /JSON array/);
    await assert.rejects(() => knowledgeMain(['--root', root, 'read-batch', JSON.stringify(['nope'])]), /1-8 read request/);
  });

  test('denies symlinked and hard-linked documents through the official read path', async () => {
    writeSourceDoc(root, 'documents/linked-target.md', '# private');
    fs.symlinkSync(path.join(root, 'documents', 'linked-target.md'), path.join(root, 'documents', `${KB_B}.md`));
    writeSourceDoc(root, 'outside.md', '# outside');
    fs.linkSync(path.join(root, 'outside.md'), path.join(root, 'documents', `${KB_C}.md`));

    const batch = await knowledgeMain(['--root', root, 'read-batch', JSON.stringify([
      { id: KB_B, expectedRevision: OLD_REVISION },
      { id: KB_C, expectedRevision: OLD_REVISION },
    ])]) as { results: Array<Record<string, unknown>> };
    assert.equal(batch.results[0].status, 'read_error');
    assert.equal(batch.results[0].code, 'UNSAFE_PATH');
    assert.equal(batch.results[1].status, 'read_error');
    assert.equal(batch.results[1].code, 'UNSAFE_PATH');
    assert.equal('body' in batch.results[0], false);
    assert.equal('body' in batch.results[1], false);
  });

  test('never writes: lock file, history and the tree stay untouched', async () => {
    const revision = putDoc(KB_A, '# Stable\n\ncontent');
    const before = listTree(root).sort();
    await knowledgeMain(['--root', root, 'read-batch', JSON.stringify([
      { id: KB_A, expectedRevision: revision },
      { id: KB_MISSING, expectedRevision: OLD_REVISION },
    ])]);
    assert.deepEqual(listTree(root).sort(), before);
    assert.equal(fs.existsSync(path.join(root, '.write.lock')), false);
    assert.equal(fs.existsSync(path.join(root, '.history')), false);
  });
});

describe('excerpt planning and deterministic selection', () => {
  test('plans at most two managed requests with strict id/revision bounds; raw entries are skipped', () => {
    const entries = [
      { ref: 'file:documents/00-raw.md', id: 'file:documents/00-raw.md', title: 'raw', summary: '', category: 'sources', updated_at: '', revision: OLD_REVISION, managed: false },
      { ref: `kb:${KB_A}`, id: KB_A, title: 'a', summary: '', category: 'deploy', updated_at: '', revision: OLD_REVISION, managed: true },
      { ref: `kb:${KB_B}`, id: KB_B, title: 'b', summary: '', category: 'deploy', updated_at: '', revision: OLD_REVISION, managed: true },
      { ref: `kb:${KB_C}`, id: KB_C, title: 'c', summary: '', category: 'deploy', updated_at: '', revision: OLD_REVISION, managed: true },
      { ref: 'kb:KB-bad', id: 'KB-short', title: 'bad id', summary: '', category: 'deploy', updated_at: '', revision: OLD_REVISION, managed: true },
      { ref: `kb:${KB_MISSING}`, id: KB_MISSING, title: 'bad revision', summary: '', category: 'deploy', updated_at: '', revision: 'deadbeef', managed: true },
    ];
    const planned = planKnowledgeExcerptRequests(entries);
    assert.deepEqual(planned.map(request => request.id), [KB_A, KB_B]);
    assert.deepEqual(planned.map(request => request.ref), [`kb:${KB_A}`, `kb:${KB_B}`]);
    assert.equal(MAX_KNOWLEDGE_EXCERPT_ENTRIES, 2);
  });

  test('selection anchors at the earliest query term with line-aligned lead context and bounded budget', () => {
    const body = `# Runbook\n${'x'.repeat(900)}\nrollback switch near nginx\n${'y'.repeat(3000)}`;
    const selection = selectKnowledgeExcerpt(body, excerptSelectionTerms(['release nginx', 'rollback']), { maxChars: 2000 });
    assert.ok(selection.text.includes('rollback switch near nginx'), 'anchor must be inside the window');
    assert.ok(selection.text.length <= 2000);
    assert.equal(selection.charStart > 0, true);
    assert.equal(selection.charEnd, selection.charStart + selection.text.length);
    assert.equal(selection.omittedBefore, true);
    assert.equal(selection.omittedAfter, true);
    assert.equal(selection.truncated, true);
    assert.equal(selection.truncatedByPaging, false);
    assert.equal(selection.pageChars, body.length);
    // char range must slice back to the same verbatim text
    assert.equal(body.slice(selection.charStart, selection.charEnd), selection.text);
  });

  test('budget holds even when a single line before the anchor is longer than the lead context', () => {
    const body = `${'z'.repeat(6000)}\n关键 alpha\n${'tail'.repeat(100)}`;
    const selection = selectKnowledgeExcerpt(body, excerptSelectionTerms(['alpha']), { maxChars: MAX_KNOWLEDGE_EXCERPT_CHARS });
    assert.ok(selection.text.length <= MAX_KNOWLEDGE_EXCERPT_CHARS);
    assert.ok(selection.text.includes('alpha'), 'anchor must survive the clamp');
    assert.equal(body.slice(selection.charStart, selection.charEnd), selection.text);
  });

  test('selection without a term match falls back to the page head with visible omission', () => {
    const body = `# Head only\n${'q'.repeat(5000)}`;
    const selection = selectKnowledgeExcerpt(body, [], { maxChars: 2000 });
    assert.equal(selection.charStart, 0);
    assert.equal(selection.text.length, 2000);
    assert.equal(selection.omittedBefore, false);
    assert.equal(selection.omittedAfter, true);
    assert.equal(selection.truncated, true);
  });

  test('never splits surrogate pairs at the window edges and keeps full astral characters verbatim', () => {
    const emoji = '🚀';
    const cutBody = `${'b'.repeat(1999)}${emoji}tail-marker`;
    const cut = selectKnowledgeExcerpt(cutBody, [], { maxChars: 2000 });
    assert.equal(cut.charEnd, 1999, 'the cut moves back instead of splitting the pair');
    assert.equal(cut.text.includes(emoji), false);
    assertNoSplitSurrogates(cut.text);

    const anchorBody = `# t\n${emoji}关键 alpha\n${'c'.repeat(3000)}`;
    const anchored = selectKnowledgeExcerpt(anchorBody, excerptSelectionTerms(['alpha']), { maxChars: 2000 });
    assert.ok(anchored.text.includes(emoji), 'a full pair inside the window is preserved');
    assert.ok(anchored.text.includes('关键 alpha'));
    assertNoSplitSurrogates(anchored.text);
  });

  test('excerpt text is verbatim: quotes, conditions and negative constraints are preserved', () => {
    const constraint = 'Do NOT enable writes on the shared mount; 只有回滚开关可以切换。';
    const body = `# Constraints\n${'n'.repeat(700)}\nDeploy step references nginx. ${constraint}\n${'m'.repeat(900)}`;
    const selection = selectKnowledgeExcerpt(body, excerptSelectionTerms(['nginx']), { maxChars: 2000 });
    assert.ok(selection.text.includes(constraint), 'negative constraints inside the window must survive verbatim');
    assert.equal(body.slice(selection.charStart, selection.charEnd), selection.text);
  });

  test('readKnowledgeExcerpts spawns nothing for an empty request list', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-kb-helper-'));
    try {
      const outcome = await readKnowledgeExcerpts({
        scriptPath: REAL_SCRIPT,
        knowledgeRoot: scratch,
        requests: [],
        timeoutMs: 1000,
      });
      assert.equal(outcome.retained.size, 0);
      assert.equal(outcome.gaps.length, 0);
      assert.deepEqual(fs.readdirSync(scratch), []);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('readKnowledgeExcerpts maps per-item outcomes and drops process-level failures into typed gaps', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-kb-helper-'));
    try {
      const requests: KnowledgeExcerptRequest[] = [
        { ref: `kb:${KB_A}`, id: KB_A, revision: OLD_REVISION },
        { ref: `kb:${KB_B}`, id: KB_B, revision: OLD_REVISION },
      ];
      const failing = path.join(scratch, 'fail.cjs');
      fs.writeFileSync(failing, `process.stdout.write(JSON.stringify({ ok: false, code: 'INVALID_PATH', message: 'Path escapes knowledge root.' }) + '\\n'); process.exitCode = 1;`);
      const failure = await readKnowledgeExcerpts({ scriptPath: failing, knowledgeRoot: scratch, requests, timeoutMs: 3000 });
      assert.equal(failure.retained.size, 0);
      assert.equal(failure.gaps.length, 2);
      assert.deepEqual(failure.gaps.map(gap => gap.status), ['unavailable', 'unavailable']);
      assert.match(String(failure.gaps[0].message), /Path escapes knowledge root/);

      const buggy = path.join(scratch, 'buggy.cjs');
      fs.writeFileSync(buggy, `
        const requests = JSON.parse(process.argv[5]);
        process.stdout.write(JSON.stringify({ ok: true, results: requests.map((request, index) => ({
          index, id: request.id, status: 'ok', revision: 'f'.repeat(64),
          body: 'STALE-LEAK-' + index, offset: 0, nextOffset: null,
        })) }) + '\\n');
      `);
      const defensive = await readKnowledgeExcerpts({ scriptPath: buggy, knowledgeRoot: scratch, requests, timeoutMs: 3000 });
      assert.equal(defensive.retained.size, 0);
      assert.deepEqual(defensive.gaps.map(gap => gap.status), ['stale_revision', 'stale_revision']);
      assert.equal(JSON.stringify(defensive).includes('STALE-LEAK'), false, 'mismatched bodies are discarded, not surfaced');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('readKnowledgeExcerpts skips the child when the remaining budget is below the floor', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-kb-helper-'));
    try {
      const outcome = await readKnowledgeExcerpts({
        scriptPath: REAL_SCRIPT,
        knowledgeRoot: scratch,
        requests: [{ ref: `kb:${KB_A}`, id: KB_A, revision: OLD_REVISION }],
        timeoutMs: 10,
      });
      assert.equal(outcome.retained.size, 0);
      assert.equal(outcome.gaps[0].status, 'unavailable');
      assert.match(String(outcome.gaps[0].message), /deadline exhausted/);
      assert.deepEqual(fs.readdirSync(scratch), []);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('local knowledge lane bounded excerpt enrichment', () => {
  let testRoot: string;
  let previousUserDataDir: string | undefined;
  let previousNodeExecutable: string | undefined;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-knowledge-excerpts-'));
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

  test('enriches only the top two managed entries with revision-bound excerpts; raw docs stay raw', async () => {
    const root = path.join(testRoot, 'knowledge');
    // Raw source sorts before managed KB ids, so it ranks first for 'alpha'.
    writeSourceDoc(root, 'documents/00-raw-notes.md', '# Raw notes\n\nalpha raw material must not be promoted.');
    const bodyA = '# Alpha doc\n\nalpha procedure: nginx stays read-only, rollback via flag.';
    const bodyB = '# Beta doc\n\nbeta environment: tail socket on 10000.';
    writeManagedDoc(root, KB_A, bodyA);
    writeManagedDoc(root, KB_B, bodyB);
    writeManagedDoc(root, KB_C, '# Gamma doc\n\ngamma unrelated.');

    const result = await searchLocalKnowledgeLane({ keywords: ['alpha', 'beta', 'gamma'], knowledgeRoot: root });
    assert.equal(result.status, 'ok');
    assert.equal(result.entries.length, 4);
    assert.deepEqual(result.entries.map(entry => entry.managed), [false, true, true, true]);
    assert.equal(result.excerptsRequested, 2);
    assert.equal(result.excerptsRetained, 2);
    assert.deepEqual(result.excerptGaps, []);

    const [raw, a, b, c] = result.entries;
    assert.equal(raw.excerpt, undefined, 'raw source documents are never enriched in v1');
    assert.equal(a.excerpt?.ref, a.ref, 'excerpt keeps the stable KB ref');
    assert.equal(a.excerpt?.revision, a.revision, 'excerpt keeps the search-time revision');
    assert.ok(a.excerpt?.text.includes('rollback via flag'), 'excerpt text comes from the managed body');
    assert.equal(b.excerpt?.ref, b.ref);
    assert.ok(b.excerpt?.text.includes('tail socket'));
    assert.equal(c.excerpt, undefined, 'only the top two managed entries are enriched');
    // Verbatim guarantee against the written file.
    assert.ok((a.excerpt?.text ?? '') !== '');
    const rawFile = fs.readFileSync(path.join(root, 'documents', `${KB_A}.md`), 'utf-8');
    assert.ok(rawFile.includes(a.excerpt?.text ?? 'never'), 'excerpt text is a verbatim slice of the document file');

    const invocations = readInvocations(testRoot);
    assert.equal(invocations.length, 0, 'the bundled script is used directly; no delegation happened here');
  });

  test('sends one structured read-batch process for at most two revision-bound requests', async () => {
    const root = path.join(testRoot, 'knowledge');
    const envelope = JSON.stringify({
      ok: true, total: 2, items: [
        { id: KB_A, title: 'a', summary: 's', category: 'deploy', updatedAt: '2026-09-01T00:00:00.000Z', revision: OLD_REVISION, managed: true, file: `documents/${KB_A}.md` },
        { id: KB_B, title: 'b', summary: 's', category: 'deploy', updatedAt: '2026-09-01T00:00:00.000Z', revision: 'b'.repeat(64), managed: true, file: `documents/${KB_B}.md` },
        { id: KB_C, title: 'c', summary: 's', category: 'deploy', updatedAt: '2026-09-01T00:00:00.000Z', revision: 'c'.repeat(64), managed: true, file: `documents/${KB_C}.md` },
      ],
    });
    const script = writeDelegatingScript(testRoot, envelope);
    const missingDocsRoot = path.join(testRoot, 'knowledge');
    fs.mkdirSync(missingDocsRoot, { recursive: true });

    const result = await searchLocalKnowledgeLane({ keywords: ['k'], knowledgeRoot: missingDocsRoot, scriptPath: script });
    const invocations = readInvocations(testRoot);
    assert.equal(invocations.length, 2, 'one search process + one batch read process');
    assert.equal(invocations[0][2], 'search-any');
    assert.equal(invocations[1][2], 'read-batch');
    const requests = JSON.parse(invocations[1][3]) as Array<Record<string, unknown>>;
    assert.equal(requests.length, 2, 'at most two reads per batch');
    assert.deepEqual(requests.map(request => request.id), [KB_A, KB_B]);
    for (const request of requests) {
      assert.match(String(request.expectedRevision), /^[a-f0-9]{64}$/);
      assert.equal(request.offset, 0);
    }
    // The documents do not exist: typed missing gaps, metadata hits preserved.
    assert.equal(result.status, 'ok');
    assert.equal(result.entries.length, 3);
    assert.equal(result.excerptsRetained, 0);
    assert.deepEqual(result.excerptGaps?.map(gap => gap.status), ['missing', 'missing']);
    assert.deepEqual(result.entries.map(entry => entry.excerpt), [undefined, undefined, undefined]);
  });

  test('raw-only hits need no enrichment and spawn no extra process', async () => {
    const root = path.join(testRoot, 'knowledge');
    writeSourceDoc(root, 'documents/notes.md', '# Notes\n\nonly raw alpha content.');
    const envelope = JSON.stringify({
      ok: true, total: 1, items: [
        { id: 'file:documents/notes.md', title: 'Notes', summary: 'raw', category: 'sources', updatedAt: '', revision: OLD_REVISION, managed: false, file: 'documents/notes.md' },
      ],
    });
    const script = writeDelegatingScript(testRoot, envelope);

    const result = await searchLocalKnowledgeLane({ keywords: ['alpha'], knowledgeRoot: root, scriptPath: script });
    assert.equal(result.status, 'ok');
    assert.equal(result.entries.length, 1);
    assert.equal(result.excerptsRequested, undefined, 'no enrichment requested');
    assert.equal(result.excerptsRetained, undefined);
    const invocations = readInvocations(testRoot);
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0][2], 'search-any');
  });

  test('a revision change between search and read never leaks the stale body', async () => {
    const root = path.join(testRoot, 'knowledge');
    writeManagedDoc(root, KB_A, `# Alpha doc\n\n${STALE_BODY_MARKER}: the current content after an update.`);
    const staleEnvelope = JSON.stringify({
      ok: true, total: 1, items: [
        { id: KB_A, title: 'a', summary: 's', category: 'deploy', updatedAt: '2026-09-01T00:00:00.000Z', revision: OLD_REVISION, managed: true, file: `documents/${KB_A}.md` },
      ],
    });
    const script = writeDelegatingScript(testRoot, staleEnvelope);

    const result = await searchLocalKnowledgeLane({ keywords: ['alpha'], knowledgeRoot: root, scriptPath: script });
    assert.equal(result.status, 'ok', 'metadata hit survives');
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].excerpt, undefined);
    assert.equal(result.excerptsRequested, 1);
    assert.equal(result.excerptsRetained, 0);
    assert.equal(result.excerptGaps?.length, 1);
    assert.equal(result.excerptGaps?.[0].status, 'stale_revision');
    assert.equal(result.excerptGaps?.[0].ref, `kb:${KB_A}`);
    assert.equal(result.excerptGaps?.[0].revision, OLD_REVISION);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(STALE_BODY_MARKER), false, 'the fresh body must never pass as the old citation');
  });

  test('entries with unbindable search revisions are skipped without losing metadata', async () => {
    const root = path.join(testRoot, 'knowledge');
    const envelope = JSON.stringify({
      ok: true, total: 1, items: [
        { id: KB_A, title: 'weird revision', summary: 's', category: 'deploy', updatedAt: '2026-09-01T00:00:00.000Z', revision: 'not-a-hash', managed: true, file: `documents/${KB_A}.md` },
      ],
    });
    const script = writeDelegatingScript(testRoot, envelope);
    fs.mkdirSync(root, { recursive: true });

    const result = await searchLocalKnowledgeLane({ keywords: ['k'], knowledgeRoot: root, scriptPath: script });
    assert.equal(result.status, 'ok');
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].revision, 'not-a-hash', 'metadata hit preserved');
    assert.equal(result.excerptsRequested, undefined, 'cannot bind without a strict revision: no read attempted');
    assert.equal(readInvocations(testRoot).length, 1);
  });

  test('the shared lane deadline bounds search plus enrichment together, not a fresh budget per read', async () => {
    const root = path.join(testRoot, 'knowledge');
    const envelope = JSON.stringify({
      ok: true, total: 1, items: [
        { id: KB_A, title: 'a', summary: 's', category: 'deploy', updatedAt: '2026-09-01T00:00:00.000Z', revision: OLD_REVISION, managed: true, file: `documents/${KB_A}.md` },
      ],
    });
    const script = writeDelegatingScript(testRoot, envelope, { sleepBeforeSearchMs: 250, sleepBeforeReadMs: 5000 });
    fs.mkdirSync(root, { recursive: true });

    const startedAt = Date.now();
    const result = await searchLocalKnowledgeLane({ keywords: ['k'], knowledgeRoot: root, scriptPath: script, timeoutMs: 700 });
    const elapsed = Date.now() - startedAt;
    assert.equal(result.status, 'ok', 'the search half completed inside the shared budget');
    assert.equal(result.entries.length, 1, 'metadata hit preserved');
    assert.equal(result.excerptsRequested, 1);
    assert.equal(result.excerptsRetained, 0);
    assert.equal(result.excerptGaps?.[0].status, 'unavailable');
    assert.match(String(result.excerptGaps?.[0].message), /timed out/);
    assert.ok(elapsed < 2500, `shared deadline must bound the whole lane (took ${elapsed}ms)`);
    assert.ok(elapsed >= 250, 'sanity: the search sleep actually consumed budget');
  });

  test('caller abort during enrichment settles promptly and keeps the metadata hits', async () => {
    const root = path.join(testRoot, 'knowledge');
    const envelope = JSON.stringify({
      ok: true, total: 1, items: [
        { id: KB_A, title: 'a', summary: 's', category: 'deploy', updatedAt: '2026-09-01T00:00:00.000Z', revision: OLD_REVISION, managed: true, file: `documents/${KB_A}.md` },
      ],
    });
    const script = writeDelegatingScript(testRoot, envelope, { sleepBeforeReadMs: 5000 });
    fs.mkdirSync(root, { recursive: true });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    try {
      const startedAt = Date.now();
      const result = await searchLocalKnowledgeLane({
        keywords: ['k'], knowledgeRoot: root, scriptPath: script, timeoutMs: 3000, signal: controller.signal,
      });
      const elapsed = Date.now() - startedAt;
      assert.equal(result.status, 'ok');
      assert.equal(result.entries.length, 1);
      assert.equal(result.excerptGaps?.[0].status, 'unavailable');
      assert.match(String(result.excerptGaps?.[0].message), /aborted/);
      assert.ok(elapsed < 1500, `abort must settle the lane promptly (took ${elapsed}ms)`);
    } finally {
      clearTimeout(timer);
    }
  });

  test('updatedAt ordering never narrows retrieval: older entries survive enrichment untouched', async () => {
    const root = path.join(testRoot, 'knowledge');
    writeManagedDoc(root, KB_A, '# old alpha\nalpha old', { updatedAt: '2020-01-01T00:00:00.000Z' });
    writeManagedDoc(root, KB_B, '# new alpha\nalpha new', { updatedAt: '2026-09-30T00:00:00.000Z' });
    writeManagedDoc(root, KB_C, '# middle alpha\nalpha middle', { updatedAt: '2023-06-01T00:00:00.000Z' });

    const result = await searchLocalKnowledgeLane({ keywords: ['alpha'], knowledgeRoot: root });
    assert.equal(result.status, 'ok');
    assert.equal(result.entries.length, 3, 'no entry dropped by enrichment');
    assert.deepEqual(result.entries.map(entry => entry.updated_at).sort(),
      ['2020-01-01T00:00:00.000Z', '2023-06-01T00:00:00.000Z', '2026-09-30T00:00:00.000Z']);
    assert.equal(result.excerptsRequested, 2);
    assert.equal(result.excerptsRetained, 2);
  });

  test('projection keeps refs, revision, truncation markers and the untrusted lane label; gaps are visible', async () => {
    const root = path.join(testRoot, 'knowledge');
    const rawA = writeManagedDoc(root, KB_A, '# Alpha doc\n\nalpha body with ' + 'long'.repeat(1200) + ' tail content beyond the budget.');
    const staleEnvelope = JSON.stringify({
      ok: true, total: 2, items: [
        { id: KB_A, title: 'a', summary: 's', category: 'deploy', updatedAt: '2026-09-01T00:00:00.000Z', revision: revisionOfRaw(rawA), managed: true, file: `documents/${KB_A}.md` },
        { id: KB_B, title: 'b', summary: 's', category: 'deploy', updatedAt: '2026-09-01T00:00:00.000Z', revision: 'b'.repeat(64), managed: true, file: `documents/${KB_B}.md` },
      ],
    });
    const script = writeDelegatingScript(testRoot, staleEnvelope);
    fs.mkdirSync(root, { recursive: true });

    const result = await searchLocalKnowledgeLane({ keywords: ['alpha'], knowledgeRoot: root, scriptPath: script });
    assert.equal(result.excerptsRetained, 1);
    assert.equal(result.excerptGaps?.length, 1);

    const pack = projectLocalKnowledgeLane(result, 16_000);
    assert.equal(pack.content_trust, 'local_distilled_knowledge', 'excerpt stays under the untrusted lane label');
    assert.equal(pack.excerpts_requested, 2);
    assert.equal(pack.excerpts_retained, 1);
    const gaps = pack.excerpt_gaps as Array<Record<string, unknown>>;
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].status, 'missing');
    assert.equal(gaps[0].ref, `kb:${KB_B}`);

    const entries = pack.entries as Array<Record<string, unknown>>;
    const excerpt = entries[0].excerpt as Record<string, unknown>;
    assert.equal(excerpt.ref, entries[0].ref, 'excerpt ref mirrors the entry ref');
    assert.equal(excerpt.revision, entries[0].revision, 'excerpt revision mirrors the entry revision');
    assert.equal(excerpt.status, 'retained');
    assert.ok((excerpt.text as string).length <= MAX_KNOWLEDGE_EXCERPT_CHARS);
    assert.equal(excerpt.truncated, true, 'explicit truncation marker');
    assert.equal(excerpt.omitted_after, true);
    assert.equal(excerpt.omitted_before, false);
    assert.equal(excerpt.next_offset, null);
    assert.equal(JSON.stringify(pack).includes('tail content beyond the budget'), false,
      'content outside the selected window is omitted');
  });

  test('lane-level excerpt budget constants stay within the shared 8k projection budget', () => {
    assert.equal(MAX_KNOWLEDGE_EXCERPT_ENTRIES, 2);
    assert.equal(MAX_KNOWLEDGE_EXCERPT_CHARS, 2000);
    assert.ok(MAX_KNOWLEDGE_EXCERPT_ENTRIES * MAX_KNOWLEDGE_EXCERPT_CHARS <= 4000);
    assert.ok(EXCERPT_LEAD_CONTEXT_CHARS < MAX_KNOWLEDGE_EXCERPT_CHARS);
    assert.equal(MAX_LOCAL_KNOWLEDGE_KEYWORDS, 3);
  });

  test('missing knowledge root still degrades before any enrichment attempt', async () => {
    const result = await searchLocalKnowledgeLane({
      keywords: ['alpha'],
      knowledgeRoot: path.join(testRoot, 'absent'),
      scriptPath: path.join(testRoot, 'absent.cjs'),
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.error, 'knowledge_root_missing');
    assert.equal(result.excerptsRequested, undefined);
    assert.deepEqual(result.entries, []);
  });
});
