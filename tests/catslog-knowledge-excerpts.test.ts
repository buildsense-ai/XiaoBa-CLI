import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

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
  options: { sleepBeforeReadMs?: number; sleepBeforeSearchMs?: number; trapSigterm?: boolean } = {},
): string {
  const log = path.join(dir, 'invocations.jsonl');
  const file = path.join(dir, 'fake-then-real-knowledge.cjs');
  fs.writeFileSync(file, `
    const fs = require('node:fs');
    const LOG = ${JSON.stringify(log)};
    const REAL = ${JSON.stringify(REAL_SCRIPT)};
    const args = process.argv.slice(2);
    // The child logs its own PID so tests can assert it was actually
    // reaped (SIGKILL), not merely that the caller stopped waiting.
    fs.appendFileSync(LOG, JSON.stringify({ pid: process.pid, args }) + '\\n');
    function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
    ${options.trapSigterm ? "process.on('SIGTERM', () => { /* ignore graceful shutdown */ });" : ''}
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

interface LoggedInvocation { pid: number; args: string[] }

function readInvocations(dir: string): LoggedInvocation[] {
  const log = path.join(dir, 'invocations.jsonl');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as LoggedInvocation);
}

/** Polls until the logged child process is actually reaped (ESRCH), not a zombie or alive. */
async function assertChildReaped(invocation: LoggedInvocation | undefined, timeoutMs: number = 1_500): Promise<void> {
  assert.ok(invocation, 'expected at least one logged child invocation');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(invocation.pid, 0);
    } catch (error: any) {
      if (error?.code === 'ESRCH') return; // reaped — the pid is gone
      // EPERM means the process exists; anything else is unexpected.
      assert.equal(error?.code, undefined, `unexpected kill(0) error for pid ${invocation.pid}: ${error?.code}`);
    }
    if (Date.now() >= deadline) {
      assert.fail(`child pid ${invocation.pid} still alive ${timeoutMs}ms after the call — supervisor did not SIGKILL it`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
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
    assert.equal(invocations[0].args[2], 'search-any');
    assert.equal(invocations[1].args[2], 'read-batch');
    const requests = JSON.parse(invocations[1].args[3]) as Array<Record<string, unknown>>;
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
    assert.equal(invocations[0].args[2], 'search-any');
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
    const script = writeDelegatingScript(testRoot, envelope, { sleepBeforeReadMs: 5000, trapSigterm: true });
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
      // Caller abort must SIGKILL the child as well, not leave it running.
      await assertChildReaped(readInvocations(testRoot).at(-1));
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

describe('review follow-ups: projection budget, unicode edges, strict protocol, supervisor deadline, diagnostics hygiene', () => {
  let scratch: string;
  beforeEach(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-kb-followup-')); });
  afterEach(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

  /** Hand-built retained excerpt over a synthetic body (text === body.slice(charStart, charEnd)). */
  function retainedExcerpt(ref: string, id: string, body: string, revision: string) {
    const charStart = 0;
    const charEnd = Math.min(body.length, 2000);
    return {
      status: 'retained' as const,
      ref,
      revision,
      text: body.slice(charStart, charEnd),
      charStart,
      charEnd,
      omittedBefore: charStart > 0,
      omittedAfter: charEnd < body.length,
      truncated: charStart > 0 || charEnd < body.length,
      truncatedByPaging: false,
      pageChars: body.length,
      offset: 0,
      nextOffset: null as number | null,
    };
  }

  function nearLimitEntry(index: number) {
    const id = `KB-0000000${index}-aaaa-4bbb-8ccc-00000000000${index}`;
    const body = `# Doc ${index}\n\n${'内容'.repeat(1000)}\n锚点${index} TAIL-MARKER-${index}`;
    const revision = crypto.createHash('sha256').update(body).digest('hex');
    return {
      entry: {
        ref: `kb:${id}`,
        id,
        title: `近限文档 ${index} 的一个相当长的标题用于撑大投影`,
        summary: `摘要${index}：${'近'.repeat(600)}`,
        category: 'deploy',
        updated_at: '2026-09-01T00:00:00.000Z',
        revision,
        managed: true,
        ...(index < 2 ? { excerpt: retainedExcerpt(`kb:${id}`, id, body, revision) } : {}),
      },
      body,
    };
  }

  /**
   * FROZEN verbatim port of the pre-feature (c444) projectLocalKnowledgeLane:
   * metadata-only entry projection, no excerpt diagnostics. Used as the
   * independent floor oracle — the new function must keep every ref this
   * function keeps, never the other way around.
   */
  function frozenC444Project(
    result: {
      status: 'ok' | 'empty' | 'truncated' | 'unavailable';
      entries: Array<Record<string, unknown>>;
      keywordsQueried: string[];
      keywordsCapped: boolean;
      keywordsFailed: number;
      entriesCapped: boolean;
      error?: string;
    },
    maxLength: number = 8_000,
  ): Record<string, unknown> {
    if (result.status === 'unavailable') {
      return {
        content_trust: 'local_distilled_knowledge',
        provenance: 'local_knowledge',
        scope: 'per_instance_shared',
        status: 'unavailable',
        ...(result.error ? { note: `Local knowledge search failed: ${result.error}` } : {}),
      };
    }
    const entries = result.entries.map(entry => ({
      ref: entry.ref,
      id: entry.id,
      title: entry.title,
      summary: entry.summary,
      category: entry.category,
      updated_at: entry.updated_at,
      revision: entry.revision,
      managed: entry.managed,
    }));
    const projected: Record<string, unknown> = {
      content_trust: 'local_distilled_knowledge',
      provenance: 'local_knowledge',
      scope: 'per_instance_shared',
      status: result.status,
      entries,
      keywords_queried: result.keywordsQueried.length,
      ...(result.keywordsCapped ? { keywords_capped: true } : {}),
      ...(result.entriesCapped ? { entries_capped: true } : {}),
      ...(result.keywordsFailed > 0 ? { keywords_failed: result.keywordsFailed } : {}),
      truncated: result.entriesCapped,
    };
    let encoded = JSON.stringify(projected);
    while (encoded.length > maxLength && entries.length > 0) {
      entries.pop();
      projected.truncated = true;
      projected.projection_capped = true;
      projected.status = 'truncated';
      encoded = JSON.stringify(projected);
    }
    return projected;
  }

  test('coordinator case r2-7867: 8 metadata-only hits at the exact 7867-char boundary keep all 8', () => {
    // Exact coordinator counterexample shape: the pre-feature projection of
    // the 8 metadata hits serializes to 7867 chars at the default 8000 cap
    // (retains all 8). r2 added excerpt diagnostics first and dropped a ref
    // even though there was no body to budget. The floor envelope must be
    // the original one; counts/gaps are spare-only and visibly omittable.
    const built = Array.from({ length: 8 }, (_, index) => {
      const id = `KB-0000000${index + 1}-aaaa-4bbb-8ccc-00000000000${index + 1}`;
      const revision = crypto.createHash('sha256').update(`doc-${index + 1}`).digest('hex');
      return {
        ref: `kb:${id}`,
        id,
        title: `Doc ${index + 1}`,
        summary: `hit-${index + 1}:${'q'.repeat(600)}`,
        category: 'deploy',
        updated_at: '2026-09-01T00:00:00.000Z',
        revision,
        managed: true,
      };
    });
    const base = {
      status: 'ok' as const,
      entries: built,
      keywordsQueried: ['hit'],
      keywordsCapped: false,
      keywordsFailed: 0,
      entriesCapped: false,
    };
    // Pin the boundary: pad entry summaries so the frozen full-8 envelope
    // serializes to exactly 7867 chars.
    const current = JSON.stringify(frozenC444Project({ ...base }, Number.MAX_SAFE_INTEGER)).length;
    const padNeeded = 7_867 - current;
    assert.ok(padNeeded > 0, `fixture sanity: base envelope below target (${current})`);
    base.entries[0] = { ...base.entries[0], summary: `${base.entries[0].summary}${'r'.repeat(padNeeded)}` };
    const pinned = JSON.stringify(frozenC444Project({ ...base }, Number.MAX_SAFE_INTEGER)).length;
    assert.equal(pinned, 7_867, 'fixture must reproduce the exact 7867-char boundary');

    const result = {
      ...base,
      excerptsRequested: 2,
      excerptsRetained: 0,
      excerptGaps: [{
        status: 'unavailable' as const,
        ref: `kb:${'KB-99999999-9999-4999-8999-999999999999'}`,
        revision: OLD_REVISION,
        message: 'knowledge script timed out',
      }],
    };

    const frozen = frozenC444Project(result, 8_000) as { entries: Array<Record<string, unknown>> };
    assert.equal(frozen.entries.length, 8, 'pre-feature projection retains all 8 at 7867 chars');
    const pack = projectLocalKnowledgeLane(result, 8_000);
    const enrichedIds = (pack.entries as Array<Record<string, unknown>>).map(entry => entry.id);
    assert.equal(enrichedIds.length, 8, 'r3 must retain all 8 refs — diagnostics are spare-only');
    assert.deepEqual(enrichedIds, frozen.entries.map(entry => entry.id));
    const encoded = JSON.stringify(pack);
    assert.ok(encoded.length <= 8_000, `projection JSON stays within the cap (${encoded.length})`);
    // No bodies existed; nothing may claim one was read.
    assert.equal((pack.entries as Array<Record<string, unknown>>).some(entry => 'excerpt' in entry), false);
    if ('excerpts_retained' in pack) {
      assert.equal(pack.excerpts_retained, 0);
      assert.equal(pack.excerpts_requested, 2);
      // Gaps are spare-budgeted: present when they fit, otherwise the
      // omission is visible via the marker.
      assert.ok(Array.isArray(pack.excerpt_gaps) || pack.excerpt_diagnostics_omitted === true);
    } else {
      assert.equal(pack.excerpt_diagnostics_omitted, true, 'omitted diagnostics are visible when markable');
    }
  });

  test('floor regression vs frozen pre-feature projection: 8 padded hits keep every old ID', () => {
    // Boundary-tight fixture: summaries are padded so the ORIGINAL
    // metadata-only projection keeps 7 entries with less spare room than the
    // excerpt diagnostics would occupy — the exact boundary where the r2
    // implementation displaced a fact. The new function must keep the same
    // 7 IDs (and only spend spare bytes on diagnostics/excerpts).
    const built = Array.from({ length: 8 }, (_, index) => {
      const id = `KB-0000000${index + 1}-aaaa-4bbb-8ccc-00000000000${index + 1}`;
      const body = `# Doc ${index + 1}\n\n${'p'.repeat(2400)}\nTAIL-MARKER-${index + 1}`;
      const revision = crypto.createHash('sha256').update(body).digest('hex');
      return {
        entry: {
          ref: `kb:${id}`,
          id,
          title: `Doc ${index + 1}`,
          summary: `padded-summary-${index + 1}:${'q'.repeat(800)}`,
          category: 'deploy',
          updated_at: '2026-09-01T00:00:00.000Z',
          revision,
          managed: true,
          ...(index < 2 ? { excerpt: retainedExcerpt(`kb:${id}`, id, body, revision) } : {}),
        },
        body,
      };
    });
    const result = {
      status: 'ok' as const,
      entries: built.map(b => b.entry),
      keywordsQueried: ['p'],
      keywordsCapped: false,
      keywordsFailed: 0,
      entriesCapped: false,
      excerptsRequested: 2,
      excerptsRetained: 2,
      excerptGaps: [],
    };

    const envelopeLength = (keep: number): number =>
      JSON.stringify(frozenC444Project(
        { ...result, entries: result.entries.slice(0, keep) },
        Number.MAX_SAFE_INTEGER,
      )).length;

    // Tune entry[0]'s summary so the 7-entry floor sits within the excerpt
    // diagnostics' byte width below the cap (the r2 diagnostics cost ≈100
    // chars; a 60-char window guarantees they force one extra pop).
    const diagnosticsWidth = 60;
    let length7 = envelopeLength(7);
    const target = 8_000 - diagnosticsWidth + 20;
    if (length7 < target) {
      const pad = target - length7;
      result.entries[0] = { ...result.entries[0], summary: `${result.entries[0].summary}${'r'.repeat(pad)}` };
      length7 = envelopeLength(7);
    }
    assert.ok(length7 > 8_000 - diagnosticsWidth && length7 <= 8_000,
      `fixture sanity: 7-entry floor must sit just under the cap (${length7})`);

    const frozen = frozenC444Project(result, 8_000) as { entries: Array<Record<string, unknown>> };
    const frozenIds = frozen.entries.map(entry => entry.id);
    assert.equal(frozenIds.length, 7, `fixture sanity: frozen baseline pops exactly one (kept ${frozenIds.length})`);

    const pack = projectLocalKnowledgeLane(result, 8_000);
    const enrichedIds = (pack.entries as Array<Record<string, unknown>>).map(entry => entry.id);
    assert.deepEqual(enrichedIds, frozenIds, 'every ref the pre-feature projection kept must survive');

    const encoded = JSON.stringify(pack);
    assert.ok(encoded.length <= 8_000, `projection JSON must stay within the lane cap (${encoded.length})`);
    const projectedExcerpts = (pack.entries as Array<Record<string, unknown>>)
      .map(entry => entry.excerpt as Record<string, unknown> | undefined)
      .filter((excerpt): excerpt is Record<string, unknown> => Boolean(excerpt));
    const totalText = projectedExcerpts.reduce((sum, excerpt) => sum + String(excerpt.text).length, 0);
    assert.ok(totalText <= 4_000, `projected excerpt text must stay within 2×2000 (${totalText})`);

    // Counters: present and truthful when they fit; otherwise omission is
    // allowed only when the flag/marker physically could not fit in the
    // remaining spare. The raw lane result always carries the counters.
    const cap = 8_000;
    if ('excerpts_projected' in pack) {
      assert.equal(pack.excerpts_projected, projectedExcerpts.length);
    } else {
      const markerCost = 1 + JSON.stringify('excerpt_diagnostics_omitted').length + 1 + JSON.stringify(true).length;
      assert.ok(JSON.stringify(pack).length + markerCost > cap,
        `omission marker must be present when it fits (spare ${cap - JSON.stringify(pack).length} < cost ${markerCost})`);
    }
    if (projectedExcerpts.length < 2 && !('excerpt_projection_capped' in pack)) {
      const flagCost = 1 + JSON.stringify('excerpt_projection_capped').length + 1 + JSON.stringify(true).length;
      assert.ok(JSON.stringify(pack).length + flagCost > cap,
        `capped flag must be present when it fits (spare ${cap - JSON.stringify(pack).length} < cost ${flagCost})`);
    }
    // The raw lane result keeps the real counters even when the projection omits them.
    assert.equal(result.excerptsRequested, 2);
    assert.equal(result.excerptsRetained, 2);

    const bodyByRef = new Map(built.map(b => [b.entry.ref, b.body]));
    for (const entry of pack.entries as Array<Record<string, unknown>>) {
      const excerpt = entry.excerpt as Record<string, unknown> | undefined;
      if (!excerpt) continue;
      const text = String(excerpt.text);
      const charStart = Number(excerpt.char_start);
      const charEnd = Number(excerpt.char_end);
      assert.equal(bodyByRef.get(String(entry.ref))!.slice(charStart, charEnd), text, 'projected excerpt stays a verbatim slice');
      assert.ok(charEnd - charStart <= 2_000);
      if (excerpt.projection_shortened === true) {
        assert.equal(charEnd, charStart + text.length, 'shortened excerpts are re-ranged honestly');
        assert.equal(excerpt.omitted_after, true);
        assert.equal(excerpt.truncated, true);
      }
      assertNoSplitSurrogates(text);
    }
  });

  test('projection never displaces baseline metadata for excerpts at the 8k cap (8 near-limit hits)', () => {
    const built = Array.from({ length: 8 }, (_, index) => nearLimitEntry(index + 1));
    const result = {
      status: 'ok' as const,
      entries: built.map(b => b.entry),
      keywordsQueried: ['锚点'],
      keywordsCapped: false,
      keywordsFailed: 0,
      entriesCapped: false,
      excerptsRequested: 2,
      excerptsRetained: 2,
      excerptGaps: [],
    };

    // Independent pre-feature oracle (frozen algorithm), not the new
    // function on stripped input.
    const frozen = frozenC444Project(result, 8_000) as { entries: Array<Record<string, unknown>> };
    const pack = projectLocalKnowledgeLane(result, 8_000);

    const baselineRefs = frozen.entries.map(entry => entry.ref);
    const enrichedRefs = (pack.entries as Array<Record<string, unknown>>).map(entry => entry.ref);
    assert.deepEqual(enrichedRefs, baselineRefs, 'excerpt prefetch must not cost any baseline metadata hit');

    const encoded = JSON.stringify(pack);
    assert.ok(encoded.length <= 8_000, `projection JSON must stay within the lane cap (${encoded.length})`);
    const projectedExcerpts = (pack.entries as Array<Record<string, unknown>>)
      .map(entry => entry.excerpt as Record<string, unknown> | undefined)
      .filter((excerpt): excerpt is Record<string, unknown> => Boolean(excerpt));
    const totalText = projectedExcerpts.reduce((sum, excerpt) => sum + String(excerpt.text).length, 0);
    assert.ok(totalText <= 4_000, `projected excerpt text must stay within 2×2000 (${totalText})`);
    // Read-truth counters: in the projection, or visibly omitted (the raw
    // lane result always carries them).
    const cap = 8_000;
    if ('excerpts_retained' in pack) {
      assert.equal(pack.excerpts_retained, 2);
      assert.equal(pack.excerpts_requested, 2);
      assert.equal(pack.excerpts_projected, projectedExcerpts.length);
    } else {
      const markerCost = 1 + JSON.stringify('excerpt_diagnostics_omitted').length + 1 + JSON.stringify(true).length;
      assert.ok(JSON.stringify(pack).length + markerCost > cap,
        `omission marker must be present when it fits (spare ${cap - JSON.stringify(pack).length} < cost ${markerCost})`);
    }
    if (projectedExcerpts.length < 2 && !('excerpt_projection_capped' in pack)) {
      const flagCost = 1 + JSON.stringify('excerpt_projection_capped').length + 1 + JSON.stringify(true).length;
      assert.ok(JSON.stringify(pack).length + flagCost > cap,
        `capped flag must be present when it fits (spare ${cap - JSON.stringify(pack).length} < cost ${flagCost})`);
    }

    const rawFileByRef = new Map(built.map(b => [b.entry.ref, b.body]));
    for (const entry of pack.entries as Array<Record<string, unknown>>) {
      const excerpt = entry.excerpt as Record<string, unknown> | undefined;
      if (!excerpt) continue;
      const text = String(excerpt.text);
      const charStart = Number(excerpt.char_start);
      const charEnd = Number(excerpt.char_end);
      assert.equal(rawFileByRef.get(String(entry.ref))!.slice(charStart, charEnd), text, 'verbatim slice');
      if (excerpt.projection_shortened === true) {
        assert.equal(charEnd, charStart + text.length);
        assert.equal(excerpt.omitted_after, true);
      }
      assertNoSplitSurrogates(text);
    }
  });

  test('roomy projection keeps both full excerpts and separates actual-projected from read-retained', () => {
    const idA = 'KB-10000000-aaaa-4bbb-8ccc-000000000001';
    const idB = 'KB-20000000-aaaa-4bbb-8ccc-000000000002';
    const bodyA = `# A\n${'a'.repeat(2400)}`;
    const bodyB = `# B\n${'b'.repeat(2400)}`;
    const result = {
      status: 'ok' as const,
      entries: [
        { ref: `kb:${idA}`, id: idA, title: 'A', summary: 'short', category: 'deploy', updated_at: 'u', revision: OLD_REVISION, managed: true, excerpt: retainedExcerpt(`kb:${idA}`, idA, bodyA, OLD_REVISION) },
        { ref: `kb:${idB}`, id: idB, title: 'B', summary: 'short', category: 'deploy', updated_at: 'u', revision: 'b'.repeat(64), managed: true, excerpt: retainedExcerpt(`kb:${idB}`, idB, bodyB, 'b'.repeat(64)) },
      ],
      keywordsQueried: ['k'],
      keywordsCapped: false,
      keywordsFailed: 0,
      entriesCapped: false,
      excerptsRequested: 2,
      excerptsRetained: 2,
      excerptGaps: [],
    };
    const pack = projectLocalKnowledgeLane(result, 8_000);
    assert.equal(pack.excerpts_projected, 2);
    assert.equal(pack.excerpts_retained, 2);
    assert.equal('excerpt_projection_capped' in pack, false, 'nothing was shortened or skipped');
    const projected = (pack.entries as Array<Record<string, unknown>>).map(entry => entry.excerpt as Record<string, unknown>);
    assert.equal(projected.reduce((sum, excerpt) => sum + String(excerpt.text).length, 0), 4_000);
    assert.equal(JSON.stringify(pack).length <= 8_000, true);
  });

  test('window end is recomputed within budget after start edge alignment', () => {
    // Line boundary at 30, pair at 90/91, anchor term at 100. maxChars 10
    // forces the minStart clamp; the start edge alignment then moves start
    // back onto the pair — the end must stay within budget.
    const body = `line-one\n${'x'.repeat(58)}${'\uD83D\uDE00'}anchor${'y'.repeat(3000)}`;
    // positions: '\n' at 8; pair at 66; 'anchor' at 68.
    const anchorIndex = body.indexOf('anchor');
    assert.equal(body.charCodeAt(anchorIndex - 2) >= 0xd800, true, 'fixture: pair right before the anchor');
    const terms = ['anchor'];
    const selection = selectKnowledgeExcerpt(body, terms, { maxChars: 10, nextOffset: null });
    assert.equal(selection.text.length <= 10, true, `budget is absolute (got ${selection.text.length})`);
    assert.equal(body.slice(selection.charStart, selection.charEnd), selection.text);
    assertNoSplitSurrogates(selection.text);
    assert.ok(selection.charStart <= anchorIndex && selection.charEnd > anchorIndex, 'anchor start stays inside the window');
  });

  test('paged page-0 ending on a dangling high surrogate is not split at the read boundary', () => {
    const body = `${'x'.repeat(11999)}\uD83D`;
    const selection = selectKnowledgeExcerpt(body, [], { maxChars: 12_000, nextOffset: 12_000 });
    assert.equal(selection.charEnd, 11_999, 'the dangling high surrogate is excluded');
    assert.equal(selection.text.includes('\uD83D'), false);
    assert.equal(body.slice(selection.charStart, selection.charEnd), selection.text);
    assert.equal(selection.truncated, true);
    assert.equal(selection.truncatedByPaging, true);
  });

  test('verbatim ranges are exact slices at start, end, offset and paging edges', () => {
    const body = `# 边界\n${'m'.repeat(5000)}`;
    for (const [offsetOption, nextOffset] of [[undefined, undefined], [0, null], [0, 12_000], [100, null]] as const) {
      const selection = selectKnowledgeExcerpt(body, ['m'], { offset: offsetOption, nextOffset, maxChars: 2_000 });
      assert.equal(selection.text.length <= 2_000, true);
      assert.equal(body.slice(selection.charStart - (offsetOption ?? 0), selection.charEnd - (offsetOption ?? 0)), selection.text,
        `text must equal the body slice between char_start and char_end (offset=${offsetOption}, next=${nextOffset})`);
      assert.equal(selection.charEnd - selection.charStart, selection.text.length);
      if (offsetOption === 100) {
        assert.equal(selection.charStart, 100);
        assert.equal(selection.omittedBefore, true, 'offset>0 means prior content exists');
      }
    }
  });

  function writeRawScript(name: string, body: string): string {
    const file = path.join(scratch, name);
    fs.writeFileSync(file, body, 'utf-8');
    return file;
  }

  const twoRequests: KnowledgeExcerptRequest[] = [
    { ref: `kb:${KB_A}`, id: KB_A, revision: OLD_REVISION },
    { ref: `kb:${KB_B}`, id: KB_B, revision: 'b'.repeat(64) },
  ];

  function leaked(batch: { retained: Map<string, unknown>; gaps: Array<Record<string, unknown>> }, marker: string): boolean {
    return JSON.stringify(batch).includes(marker);
  }

  test('forged ok response with a wrong offset is a typed gap and the body is discarded', async () => {
    const script = writeRawScript('forged-offset.cjs', `
      process.stdout.write(JSON.stringify({ ok: true, results: [
        { index: 0, id: ${JSON.stringify(KB_A)}, status: 'ok', revision: ${JSON.stringify(OLD_REVISION)}, body: 'FORGED-OFFSET-LEAK', offset: 12000, nextOffset: null },
        { index: 1, id: ${JSON.stringify(KB_B)}, status: 'ok', revision: ${JSON.stringify('b'.repeat(64))}, body: 'ok-body-b', offset: 0, nextOffset: null },
      ] }) + '\\n');
    `);
    const batch = await readKnowledgeExcerpts({ scriptPath: script, knowledgeRoot: scratch, requests: twoRequests, timeoutMs: 3000 });
    assert.equal(batch.retained.has(`kb:${KB_A}`), false);
    assert.equal(batch.gaps[0].status, 'read_error');
    assert.match(String(batch.gaps[0].message), /protocol violation: response offset/);
    assert.equal(leaked(batch, 'FORGED-OFFSET-LEAK'), false);
    assert.equal(batch.retained.has(`kb:${KB_B}`), true, 'the conforming sibling still binds');
  });

  test('malformed offset objects cannot invoke coercion or escape as an exception', async () => {
    const script = writeRawScript('offset-object.cjs', `
      process.stdout.write(JSON.stringify({ ok: true, results: [
        { index: 0, id: ${JSON.stringify(KB_A)}, status: 'ok', revision: ${JSON.stringify(OLD_REVISION)}, body: 'OFFSET-OBJECT-LEAK', offset: { toString: null }, nextOffset: null },
      ] }) + '\\n');
    `);
    const batch = await readKnowledgeExcerpts({ scriptPath: script, knowledgeRoot: scratch, requests: [twoRequests[0]], timeoutMs: 3000 });
    assert.equal(batch.retained.size, 0);
    assert.equal(batch.gaps[0].status, 'read_error');
    assert.match(String(batch.gaps[0].message), /response offset/);
    assert.equal(leaked(batch, 'OFFSET-OBJECT-LEAK'), false);
  });

  test('read page size and nextOffset must agree with the official reader contract', async () => {
    for (const [body, nextOffset] of [['P'.repeat(12001), null], ['short-page', 12000]] as const) {
      const script = writeRawScript('bad-page.cjs', `
        process.stdout.write(JSON.stringify({ ok: true, results: [
          { index: 0, id: ${JSON.stringify(KB_A)}, status: 'ok', revision: ${JSON.stringify(OLD_REVISION)}, body: ${JSON.stringify(body)}, offset: 0, nextOffset: ${JSON.stringify(nextOffset)} },
        ] }) + '\\n');
      `);
      const batch = await readKnowledgeExcerpts({ scriptPath: script, knowledgeRoot: scratch, requests: [twoRequests[0]], timeoutMs: 3000 });
      assert.equal(batch.retained.size, 0);
      assert.equal(batch.gaps[0].status, 'read_error');
      assert.match(String(batch.gaps[0].message), /protocol violation/);
    }
  });

  test('duplicate result indices poison the whole batch with typed gaps and no bodies', async () => {
    const script = writeRawScript('dup-index.cjs', `
      const item = { status: 'ok', body: 'DUP-INDEX-LEAK', offset: 0, nextOffset: null };
      process.stdout.write(JSON.stringify({ ok: true, results: [
        { index: 0, id: ${JSON.stringify(KB_A)}, revision: ${JSON.stringify(OLD_REVISION)}, ...item },
        { index: 0, id: ${JSON.stringify(KB_B)}, revision: ${JSON.stringify('b'.repeat(64))}, ...item },
      ] }) + '\\n');
    `);
    const batch = await readKnowledgeExcerpts({ scriptPath: script, knowledgeRoot: scratch, requests: twoRequests, timeoutMs: 3000 });
    assert.equal(batch.retained.size, 0);
    assert.equal(batch.gaps.length, 2);
    for (const gap of batch.gaps) {
      assert.equal(gap.status, 'unavailable');
      assert.match(String(gap.message), /duplicate result index/);
    }
    assert.equal(leaked(batch, 'DUP-INDEX-LEAK'), false);
  });

  test('out-of-range result indices are rejected as a protocol violation', async () => {
    const script = writeRawScript('range-index.cjs', `
      process.stdout.write(JSON.stringify({ ok: true, results: [
        { index: 0, id: ${JSON.stringify(KB_A)}, status: 'ok', revision: ${JSON.stringify(OLD_REVISION)}, body: 'in-range', offset: 0, nextOffset: null },
        { index: 7, id: ${JSON.stringify(KB_B)}, status: 'ok', revision: 'x', body: 'RANGE-LEAK', offset: 0, nextOffset: null },
      ] }) + '\\n');
    `);
    const batch = await readKnowledgeExcerpts({ scriptPath: script, knowledgeRoot: scratch, requests: twoRequests, timeoutMs: 3000 });
    assert.equal(batch.retained.size, 0);
    assert.match(String(batch.gaps[0].message), /result index out of range/);
    assert.equal(leaked(batch, 'RANGE-LEAK'), false);
    assert.equal(leaked(batch, 'in-range'), false, 'unattributable batches discard every body');
  });

  test('malformed or non-forward nextOffset is rejected, never read as full coverage', async () => {
    const cases: Array<[string, string, RegExp]> = [
      ['string nextOffset', 'nextOffset: "x"', /malformed nextOffset/],
      ['missing nextOffset', '', /malformed nextOffset/],
      ['non-forward nextOffset', 'nextOffset: 0', /malformed nextOffset/],
    ];
    for (const [label, nextField, expected] of cases) {
      const script = writeRawScript(`next-${label.replace(/\W+/g, '-')}.cjs`, `
        process.stdout.write(JSON.stringify({ ok: true, results: [
          { index: 0, id: ${JSON.stringify(KB_A)}, status: 'ok', revision: ${JSON.stringify(OLD_REVISION)}, body: 'NEXT-LEAK', offset: 0, ${nextField} },
        ] }) + '\\n');
      `);
      const batch = await readKnowledgeExcerpts({
        scriptPath: script,
        knowledgeRoot: scratch,
        requests: [twoRequests[0]],
        timeoutMs: 3000,
      });
      assert.equal(batch.retained.size, 0, label);
      assert.equal(batch.gaps[0].status, 'read_error', label);
      assert.match(String(batch.gaps[0].message), expected, label);
      assert.equal(leaked(batch, 'NEXT-LEAK'), false, label);
    }
  });

  test('plan cap is hard at two regardless of the optional argument; ref must be kb:+id', () => {
    const forged = { ref: 'kb:KB-99999999-9999-4999-8999-999999999999', id: KB_MISSING, title: 'forged ref', summary: '', category: 'deploy', updated_at: '', revision: OLD_REVISION, managed: true };
    const entries = [
      nearLimitEntry(1).entry, nearLimitEntry(2).entry, nearLimitEntry(3).entry, nearLimitEntry(4).entry, forged,
    ];
    assert.equal(planKnowledgeExcerptRequests(entries, 10).length, 2, 'cannot raise the cap above 2');
    assert.equal(planKnowledgeExcerptRequests(entries, 99).length, 2);
    assert.equal(planKnowledgeExcerptRequests(entries, 0).length, 0);
    const planned = planKnowledgeExcerptRequests(entries);
    for (const request of planned) {
      assert.equal(request.ref, `kb:${request.id}`, 'ref/id binding must be canonical');
    }
  });

  test('SIGTERM-trapping never-settling enrichment child is killed at the shared deadline', async () => {
    const root = path.join(scratch, 'knowledge');
    fs.mkdirSync(root, { recursive: true });
    const envelope = JSON.stringify({
      ok: true, total: 1, items: [
        { id: KB_A, title: 'a', summary: 's', category: 'deploy', updatedAt: '2026-09-01T00:00:00.000Z', revision: OLD_REVISION, managed: true, file: `documents/${KB_A}.md` },
      ],
    });
    const script = writeDelegatingScript(scratch, envelope, { sleepBeforeReadMs: 60_000, trapSigterm: true });

    const startedAt = Date.now();
    let hardcapFired = false;
    const result = await Promise.race([
      searchLocalKnowledgeLane({ keywords: ['k'], knowledgeRoot: root, scriptPath: script, timeoutMs: 500 }),
      new Promise<never>((_resolve, reject) => setTimeout(() => { hardcapFired = true; reject(new Error('supervisor hardcap exceeded')); }, 2_500)),
    ]);
    const elapsed = Date.now() - startedAt;
    assert.equal(hardcapFired, false, 'the lane must settle under its own deadline, not the test hardcap');
    assert.equal(result.status, 'ok', 'metadata hits survive the killed child');
    assert.equal(result.entries.length, 1);
    assert.equal(result.excerptGaps?.[0].status, 'unavailable');
    assert.match(String(result.excerptGaps?.[0].message), /timed out/);
    assert.ok(elapsed < 2_000, `never-settling child must not extend the lane (took ${elapsed}ms)`);
    // PID-level proof: the SIGTERM-trapping child is actually reaped (SIGKILL), not abandoned.
    await assertChildReaped(readInvocations(scratch).at(-1));
  });

  test('never-settling search child cannot extend the lane deadline either', async () => {
    const root = path.join(scratch, 'knowledge');
    fs.mkdirSync(root, { recursive: true });
    const script = writeDelegatingScript(scratch, JSON.stringify({ ok: true, total: 0, items: [] }), { sleepBeforeSearchMs: 60_000, trapSigterm: true });

    const startedAt = Date.now();
    const result = await Promise.race([
      searchLocalKnowledgeLane({ keywords: ['k'], knowledgeRoot: root, scriptPath: script, timeoutMs: 400 }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('supervisor hardcap exceeded')), 2_500)),
    ]);
    const elapsed = Date.now() - startedAt;
    assert.equal(result.status, 'unavailable');
    assert.match(String(result.error), /timed out/);
    assert.ok(elapsed < 1_500, `search phase must honor the shared deadline (took ${elapsed}ms)`);
    await assertChildReaped(readInvocations(scratch).at(-1));
  });

  test('non-JSON child stderr carrying a stale secret never reaches lane results or projected gaps', async () => {
    const SECRET = 'STALE-SECRET-BODY-7f3a9c';
    // Search-any succeeds (fabricated); read-batch crashes with a raw,
    // non-JSON stderr dump that embeds the secret and the command line.
    const script = writeRawScript('noisy-crash.cjs', `
      const args = process.argv.slice(2);
      if (args[2] === 'search-any') {
        process.stdout.write(JSON.stringify({ ok: true, total: 1, items: [
          { id: ${JSON.stringify(KB_A)}, title: 'a', summary: 's', category: 'deploy', updatedAt: '2026-09-01T00:00:00.000Z', revision: ${JSON.stringify(OLD_REVISION)}, managed: true, file: 'documents/${KB_A}.md' },
        ] }) + '\\n');
        return;
      }
      process.stderr.write('fatal: read failed near "${SECRET}"\\ncommand: node knowledge.cjs --root /data read-batch "{\\"id\\":\\"KB-11111111-2222-4333-8444-555555555555\\"}"\\n');
      process.exit(1);
    `);
    const requests: KnowledgeExcerptRequest[] = [{ ref: `kb:${KB_A}`, id: KB_A, revision: OLD_REVISION }];

    const helperBatch = await readKnowledgeExcerpts({ scriptPath: script, knowledgeRoot: scratch, requests, timeoutMs: 3000 });
    assert.equal(helperBatch.retained.size, 0);
    assert.equal(helperBatch.gaps[0].status, 'unavailable');
    assert.equal(leaked(helperBatch, SECRET), false, 'raw stderr is never surfaced');
    assert.equal(JSON.stringify(helperBatch).includes('read-batch'), false, 'command dumps are never surfaced');

    // Lane level: the same crash must degrade to typed gaps over intact metadata hits.
    const root = path.join(scratch, 'knowledge');
    fs.mkdirSync(root, { recursive: true });
    const laneResult = await searchLocalKnowledgeLane({ keywords: ['k'], knowledgeRoot: root, scriptPath: script });
    assert.equal(laneResult.status, 'ok');
    assert.equal(laneResult.excerptGaps?.[0].status, 'unavailable');
    const pack = projectLocalKnowledgeLane(laneResult, 8_000);
    assert.equal(JSON.stringify(pack).includes(SECRET), false);
    assert.equal(JSON.stringify(pack).includes('read-batch'), false);
  });

  test('isolated node:test runner exits promptly; abandoned knowledge children cannot hang it', async () => {
    // Fresh isolated test file: the lane runs against a SIGTERM-trapping
    // 60s child under a 500ms shared deadline. The spawned node --test
    // PROCESS itself must exit well under the 5s supervisor — before this
    // fix the survived child kept the runner's event loop alive for the
    // full sleep.
    const root = path.join(scratch, 'knowledge');
    fs.mkdirSync(root, { recursive: true });
    const fakeScript = path.join(scratch, 'trap-child.cjs');
    fs.writeFileSync(fakeScript, `
      const args = process.argv.slice(2);
      process.on('SIGTERM', () => { /* ignore graceful shutdown */ });
      if (args[2] === 'search-any') {
        process.stdout.write(JSON.stringify({ ok: true, total: 1, items: [
          { id: ${JSON.stringify(KB_A)}, title: 'a', summary: 's', category: 'deploy', updatedAt: '2026-09-01T00:00:00.000Z', revision: ${JSON.stringify(OLD_REVISION)}, managed: true, file: 'documents/${KB_A}.md' },
        ] }) + '\\n');
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
    `);
    const miniTest = path.join(scratch, 'isolated-exit.test.ts');
    fs.writeFileSync(miniTest, `
      import { test } from 'node:test';
      import assert from 'node:assert/strict';
      import { searchLocalKnowledgeLane } from ${JSON.stringify(path.resolve('src/core/catslog-knowledge-lane.ts'))};

      test('never-settling knowledge child cannot hang the runner', async () => {
        const result = await searchLocalKnowledgeLane({
          keywords: ['k'],
          knowledgeRoot: ${JSON.stringify(root)},
          scriptPath: ${JSON.stringify(fakeScript)},
          timeoutMs: 500,
        });
        assert.equal(result.status, 'ok');
        assert.equal(result.excerptGaps?.[0]?.status, 'unavailable');
      });
    `);
    const tsxCli = path.resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
    const startedAt = Date.now();
    let timedOut = false;
    // A fresh runner must not inherit NODE_TEST_CONTEXT, or its node --test
    // run() thinks it is nested inside the parent's test file and skips
    // every file.
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const spawned = execFileAsync(process.execPath, [tsxCli, '--test', miniTest], {
      timeout: 5_000,
      killSignal: 'SIGKILL',
      cwd: process.cwd(),
      env: childEnv,
      windowsHide: true,
    }).catch((error: any) => {
      if (error?.killed === true) {
        timedOut = true;
        return { stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
      }
      throw error;
    });
    const outcome = await spawned;
    const elapsed = Date.now() - startedAt;
    assert.equal(timedOut, false, `isolated runner hung until the supervisor killed it (${elapsed}ms)`);
    assert.ok(elapsed < 5_000, `isolated runner must exit well before the supervisor (took ${elapsed}ms)`);
    assert.match(String(outcome.stdout), /fail 0/, `isolated runner output: stdout=${String(outcome.stdout).slice(0, 300)} stderr=${String((outcome as any).stderr ?? '').slice(0, 300)}`);
  });

  test('spawn failures degrade to the generic bounded diagnostic with no command dump', async () => {
    const batch = await readKnowledgeExcerpts({
      scriptPath: path.join(scratch, 'does-not-exist.cjs'),
      knowledgeRoot: scratch,
      requests: [twoRequests[0]],
      timeoutMs: 3000,
    });
    assert.equal(batch.retained.size, 0);
    assert.equal(batch.gaps[0].status, 'unavailable');
    // Newer Node collapses spawn-ENOENT into a numeric exit-code error that
    // only carries the command dump; the diagnostic must stay generic and
    // bounded rather than surface it.
    assert.equal(String(batch.gaps[0].message), 'knowledge script failed');
    assert.equal(JSON.stringify(batch).includes('read-batch'), false);
    assert.equal(JSON.stringify(batch).includes('does-not-exist'), false);
  });
});
