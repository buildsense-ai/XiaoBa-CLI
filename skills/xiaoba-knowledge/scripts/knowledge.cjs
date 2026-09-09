#!/usr/bin/env node
'use strict';

// No dependencies: this helper is shipped unchanged with CLI, desktop and Worker.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const MAX_FILE_BYTES = 256 * 1024;
const PAGE_SIZE = 30;
const READ_SIZE = 12000;
const ID_PATTERN = /^KB-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHORT_ID_PATTERN = /^KB-[a-f0-9]{8}$/;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function fileStat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

class KnowledgeStore {
  constructor(root) {
    if (!root || !path.isAbsolute(root)) fail('INVALID_ROOT', 'Knowledge root must be an absolute path.');
    this.root = path.resolve(root);
    this.safePath();
  }

  safePath(...parts) {
    const target = path.resolve(this.root, ...parts);
    const relative = path.relative(this.root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) fail('INVALID_PATH', 'Path escapes knowledge root.');
    let cursor = this.root;
    for (const component of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (component) cursor = path.join(cursor, component);
      const stat = fileStat(cursor);
      if (stat?.isSymbolicLink()) fail('UNSAFE_PATH', `Symbolic links are not supported: ${cursor}`);
      if (stat && cursor !== target && !stat.isDirectory()) fail('UNSAFE_PATH', `Expected directory: ${cursor}`);
      if (stat?.isFile() && stat.nlink > 1) fail('UNSAFE_PATH', `Hard linked files are not supported: ${cursor}`);
    }
    return target;
  }

  documentPath(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) fail('INVALID_ID', 'Use the exact KB-ID returned by index or put.');
    return this.safePath('documents', `${id}.md`);
  }

  resolveReadId(id) {
    if (typeof id !== 'string' || !SHORT_ID_PATTERN.test(id)) return id;
    const directory = this.safePath('documents');
    const matches = fileStat(directory) ? fs.readdirSync(directory)
      .filter(name => name.endsWith('.md'))
      .map(name => name.slice(0, -3))
      .filter(name => ID_PATTERN.test(name) && name.startsWith(`${id}-`)) : [];
    if (!matches.length) fail('NOT_FOUND', `No document matches ${id}.`);
    if (matches.length > 1) fail('AMBIGUOUS_ID', `Multiple documents match ${id}. Search this ID prefix and use a complete ID.`);
    return matches[0];
  }

  readRaw(file) {
    const stat = fileStat(file);
    if (!stat) fail('NOT_FOUND', `Document not found: ${file}`);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) fail('INVALID_DOCUMENT', `Not a regular document or exceeds 256 KiB: ${file}`);
    return fs.readFileSync(file, 'utf8');
  }

  parse(raw, file) {
    const match = /^---\r?\n([^\n]+)\r?\n---\r?\n\r?\n?([\s\S]*)$/.exec(raw);
    if (!match) fail('INVALID_DOCUMENT', `Keep the JSON frontmatter intact: ${file}`);
    let metadata;
    try { metadata = JSON.parse(match[1]); }
    catch { fail('INVALID_DOCUMENT', `Invalid JSON frontmatter: ${file}`); }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
        || !ID_PATTERN.test(metadata.id) || typeof metadata.title !== 'string' || typeof metadata.summary !== 'string'
        || typeof metadata.category !== 'string' || typeof metadata.updatedAt !== 'string'
        || typeof metadata.change !== 'string' || !Array.isArray(metadata.sources)) {
      fail('INVALID_DOCUMENT', `Invalid metadata: ${file}`);
    }
    return { ...metadata, body: match[2], revision: hash(raw) };
  }

  read(id, offset = 0) {
    if (typeof id === 'string' && id.startsWith('file:')) {
      const relative = id.slice(5);
      const file = this.sourcePath(relative);
      return this.page(this.sourceDocument(relative, this.readRaw(file)), offset);
    }
    id = this.resolveReadId(id);
    const file = this.documentPath(id);
    const doc = this.parse(this.readRaw(file), file);
    if (doc.id !== id) fail('INVALID_DOCUMENT', 'Document ID differs from filename.');
    return this.page({ ...doc, managed: true, file: `documents/${id}.md` }, offset);
  }

  page(doc, offset) {
    const body = doc.body.slice(offset, offset + READ_SIZE);
    return { ...doc, body, offset, nextOffset: offset + body.length < doc.body.length ? offset + body.length : null };
  }

  sourcePath(relative) {
    if (!relative.startsWith('documents/') || !/\.md$/i.test(relative)
        || /[\\:\0]/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) {
      fail('INVALID_PATH', 'Use the exact file:documents/... Markdown reference returned by index or search.');
    }
    return this.safePath(relative);
  }

  sourceDocument(relative, raw) {
    const heading = /^#\s+(.+)$/m.exec(raw);
    return {
      id: `file:${relative}`, file: relative, managed: false,
      title: (heading?.[1]?.trim() || path.posix.basename(relative, path.posix.extname(relative))).slice(0, 200),
      summary: raw.replace(/\s+/g, ' ').slice(0, 200), category: 'sources',
      sources: [`file:${relative}`], body: raw, revision: hash(raw),
    };
  }

  documents(warnings = []) {
    const directory = this.safePath('documents');
    if (!fileStat(directory)) return [];
    const docs = [];
    const visit = relativeDirectory => {
      for (const name of fs.readdirSync(this.safePath(relativeDirectory)).sort()) {
        const relative = `${relativeDirectory}/${name}`;
        try {
          const file = this.safePath(relative);
          if (fileStat(file)?.isDirectory()) { visit(relative); continue; }
          if (!/\.md$/i.test(name)) continue;
          this.sourcePath(relative);
          const raw = this.readRaw(file);
          const id = name.slice(0, -3);
          if (relativeDirectory === 'documents' && name.endsWith('.md') && ID_PATTERN.test(id)) {
            try {
              const doc = this.parse(raw, file);
              if (doc.id !== id) fail('INVALID_DOCUMENT', 'Document ID differs from filename.');
              docs.push({ ...doc, managed: true, file: relative });
              continue;
            } catch (error) {
              warnings.push({ ...this.fileWarning(relative, error), readableAs: `file:${relative}` });
            }
          }
          docs.push(this.sourceDocument(relative, raw));
        } catch (error) { warnings.push(this.fileWarning(relative, error)); }
      }
    };
    visit('documents');
    return docs;
  }

  fileWarning(file, error) {
    return { file: file.split(path.sep).join('/'), code: error.code || 'INVALID_DOCUMENT', message: error.message };
  }

  index(query = '', offset = 0) {
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const warnings = [];
    const docs = this.documents(warnings).filter(doc => {
      const text = `${doc.id}\n${doc.title}\n${doc.summary}\n${doc.category}\n${doc.body}`.toLocaleLowerCase();
      return terms.every(term => text.includes(term));
    });
    return {
      total: docs.length,
      items: docs.slice(offset, offset + PAGE_SIZE).map(({ id, title, summary, category, updatedAt, revision, managed, file }) => ({
        id, title, summary, category, updatedAt, revision, managed, file,
      })),
      nextOffset: offset + PAGE_SIZE < docs.length ? offset + PAGE_SIZE : null,
      warnings,
    };
  }

  atomicWrite(file, content) {
    this.safePath(path.relative(this.root, file));
    const temporary = this.safePath(path.relative(this.root, path.join(path.dirname(file), `.tmp-${crypto.randomUUID()}`)));
    try {
      fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally {
      if (fileStat(temporary)) fs.unlinkSync(temporary);
    }
  }

  async withLock(operation) {
    this.safePath();
    fs.mkdirSync(this.root, { recursive: true });
    const lock = this.safePath('.write.lock');
    let handle;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { handle = fs.openSync(lock, 'wx', 0o600); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await delay(50);
      }
    }
    if (handle === undefined) fail('LOCK_BUSY', `Knowledge writer is busy. Retry; inspect ${lock} if the owning process has exited.`);
    const owner = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token: crypto.randomUUID() });
    const identity = fs.fstatSync(handle);
    try {
      fs.writeFileSync(handle, owner);
      return operation();
    } finally {
      fs.closeSync(handle);
      // Do not release a lock replaced by an operator or another process.
      // No automatic stale-lock reclamation: age/PID alone cannot establish ownership.
      const current = fileStat(lock);
      if (current?.isFile() && current.nlink === 1
          && current.dev === identity.dev && current.ino === identity.ino
          && fs.readFileSync(lock, 'utf8') === owner) {
        fs.unlinkSync(lock);
      }
    }
  }

  async put(input) {
    validateInput(input);
    return this.withLock(() => {
      const id = input.id || `KB-${crypto.randomUUID()}`;
      const file = this.documentPath(id);
      const oldRaw = fileStat(file) ? this.readRaw(file) : undefined;
      const old = oldRaw === undefined ? undefined : this.parse(oldRaw, file);
      if ((old?.revision ?? null) !== input.expectedRevision || (input.id && !old)) {
        fail('REVISION_CONFLICT', 'Document changed or disappeared. Read again and merge before retrying.');
      }
      const fields = { title: input.title, summary: input.summary, category: input.category, sources: input.sources, body: input.body };
      if (old && Object.entries(fields).every(([key, value]) => JSON.stringify(old[key]) === JSON.stringify(value))) {
        return { id, revision: old.revision, changed: false };
      }
      const metadata = {
        id, title: input.title, summary: input.summary, category: input.category, sources: input.sources,
        updatedAt: new Date().toISOString(), change: input.change,
      };
      const raw = `---\n${JSON.stringify(metadata)}\n---\n\n${input.body}`;
      if (Buffer.byteLength(raw) > MAX_FILE_BYTES) fail('INVALID_INPUT', 'Document exceeds 256 KiB.');
      fs.mkdirSync(this.safePath('documents'), { recursive: true });
      if (old) {
        const history = this.safePath('.history', id);
        fs.mkdirSync(history, { recursive: true });
        const archive = this.safePath('.history', id, `${old.revision}.md`);
        if (!fileStat(archive)) this.atomicWrite(archive, oldRaw);
      }
      this.atomicWrite(file, raw);
      const result = { id, revision: hash(raw), changed: true, saved: true };
      try {
        const { warnings } = this.reindexLocked();
        if (warnings.length) result.warnings = warnings;
      }
      catch (error) { result.warning = `Document saved, derived index needs repair: ${error.message}. Run reindex.`; }
      return result;
    });
  }

  reindexLocked() {
    const warnings = [];
    const docs = this.documents(warnings);
    const index = ['# 本地共享知识库', '', '由 xiaoba-knowledge 生成；正文位于 documents，修改后可运行 reindex。', '', '| ID / 标题 | 分类 | 摘要 |', '| --- | --- | --- |'];
    const events = [];
    for (const doc of docs) {
      const link = doc.file.split('/').map(encodeURIComponent).join('/').replace(/[()]/g, char => `%${char.charCodeAt(0).toString(16)}`);
      index.push(`| [${escapeCell(doc.id)} ${escapeCell(doc.title)}](${link}) | ${escapeCell(doc.category)} | ${escapeCell(doc.summary)} |`);
      if (!doc.managed) continue;
      events.push(doc);
      const historyRelative = path.join('.history', doc.id);
      try {
        const history = this.safePath(historyRelative);
        for (const name of (fileStat(history) ? fs.readdirSync(history) : []).sort()) {
          if (!/^[a-f0-9]{64}\.md$/.test(name)) continue;
          const relative = path.join(historyRelative, name);
          try {
            const file = this.safePath(relative);
            const raw = this.readRaw(file);
            const archived = this.parse(raw, file);
            if (archived.id !== doc.id || hash(raw) !== name.slice(0, -3)) {
              fail('INVALID_DOCUMENT', 'History ID or revision differs from its path.');
            }
            events.push(archived);
          } catch (error) { warnings.push(this.fileWarning(relative, error)); }
        }
      } catch (error) { warnings.push(this.fileWarning(historyRelative, error)); }
    }
    const changes = ['# 知识更新记录', '', '由当前文档与 .history 历史版本生成；用户直接编辑正文不会自动产生历史版本。', ''];
    for (const doc of events.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))) {
      changes.push(`- ${escapeCell(doc.updatedAt)} · ${doc.id} · ${doc.revision.slice(0, 12)} · ${escapeCell(doc.change)}`);
    }
    this.atomicWrite(this.safePath('index.md'), `${index.join('\n')}\n`);
    this.atomicWrite(this.safePath('changes.md'), `${changes.join('\n')}\n`);
    return { documents: docs.length, revisions: events.length, warnings };
  }

  async reindex() { return this.withLock(() => this.reindexLocked()); }
}

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function escapeCell(value) { return String(value).replace(/[\r\n]+/g, ' ').replace(/[\\|\[\]<>]/g, char => `&#${char.charCodeAt(0)};`); }
function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', 'Expected a JSON object.');
  for (const [key, maximum] of Object.entries({ title: 200, summary: 600, category: 50, change: 600, body: 200000 })) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > maximum) fail('INVALID_INPUT', `Invalid ${key}.`);
  }
  if (!/^[a-z][a-z0-9-]{0,49}$/.test(input.category)) fail('INVALID_INPUT', 'Category must be a short lowercase slug.');
  if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 20
      || input.sources.some(source => typeof source !== 'string' || !source.trim() || source.length > 1000)) {
    fail('INVALID_INPUT', 'Provide 1-20 source references (up to 1000 characters each).');
  }
  if (input.id !== undefined && (typeof input.id !== 'string' || !ID_PATTERN.test(input.id))) fail('INVALID_ID', 'Invalid KB-ID.');
  if (input.id === undefined ? input.expectedRevision !== null : !/^[a-f0-9]{64}$/.test(input.expectedRevision || '')) {
    fail('INVALID_INPUT', 'Creation requires expectedRevision:null; updating requires id and the revision from read.');
  }
}
function offset(value) {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail('INVALID_INPUT', 'Offset must be a nonnegative integer.');
  return Number(value);
}

async function main(args) {
  if (args[0] !== '--root') fail('INVALID_INPUT', 'Usage: knowledge.cjs --root ABSOLUTE_PATH index|search|read|put|reindex ...');
  const store = new KnowledgeStore(args[1]);
  const [command, ...rest] = args.slice(2);
  if (command === 'index' && rest.length <= 1) return store.index('', offset(rest[0]));
  if (command === 'search' && rest[0]?.trim() && rest.length <= 2) return store.index(rest[0], offset(rest[1]));
  if (command === 'read' && rest.length >= 1 && rest.length <= 2) return store.read(rest[0], offset(rest[1]));
  if (command === 'reindex' && !rest.length) return store.reindex();
  if (command === 'put' && rest.length === 1) {
    const input = fs.statSync(rest[0]);
    if (!input.isFile() || input.size > MAX_FILE_BYTES) fail('INVALID_INPUT', 'Input must be a JSON file up to 256 KiB.');
    return store.put(JSON.parse(fs.readFileSync(rest[0], 'utf8').replace(/^\uFEFF/, '')));
  }
  fail('INVALID_INPUT', 'Unknown command or invalid arguments.');
}

module.exports = { KnowledgeStore, main };
if (require.main === module) {
  main(process.argv.slice(2)).then(
    result => process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`),
    error => { process.stderr.write(`${JSON.stringify({ ok: false, code: error.code || 'KNOWLEDGE_ERROR', message: error.message })}\n`); process.exitCode = 1; },
  );
}
