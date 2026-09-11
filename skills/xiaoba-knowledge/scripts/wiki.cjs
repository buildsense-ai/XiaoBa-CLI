'use strict';

// Read-only Skill entry. Executed in a bounded child process, never on the
// conversation event loop. Only managed KB IDs are visible through the Wiki.
const fs = require('node:fs');
const path = require('node:path');
const { KnowledgeStore } = require('./knowledge.cjs');
const ID = /^KB-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const integer = (v, max) => {
  if (v === undefined) return 0;
  if (!Number.isSafeInteger(v) || v < 0 || v > max) fail('INVALID_RANGE');
  return v;
};

function metadata(store, name) {
  const file = store.documentPath(name.slice(0, -3));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 256 * 1024) fail('INVALID_DOCUMENT');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(32 * 1024);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const match = /^---\r?\n([^\n]+)\r?\n---\r?\n/.exec(buffer.subarray(0, size).toString('utf8'));
    if (!match) fail('INVALID_DOCUMENT');
    const doc = JSON.parse(match[1]);
    if (doc.id !== name.slice(0, -3) || typeof doc.title !== 'string' || typeof doc.summary !== 'string') fail('INVALID_DOCUMENT');
    return { id: doc.id, title: doc.title.slice(0, 200), summary: doc.summary.slice(0, 600),
      category: String(doc.category || '').slice(0, 50), updatedAt: doc.updatedAt };
  } finally { fs.closeSync(fd); }
}

function call(root, operation, payload = {}) {
  const store = new KnowledgeStore(root);
  const offset = integer(payload.offset, 200000);
  if (operation === 'knowledge.document.list') {
    if (payload.query !== undefined && (typeof payload.query !== 'string' || payload.query.length > 200)) fail('INVALID_QUERY');
    const query = (payload.query || '').trim().toLowerCase();
    const directory = store.safePath('documents');
    if (!fs.existsSync(directory)) return { total: 0, items: [], nextOffset: null, warnings: 0 };
    const names = [];
    const dir = fs.opendirSync(directory);
    try {
      let entry;
      while ((entry = dir.readSync())) {
        if (names.length >= 10000) fail('CATALOG_LIMIT');
        if (entry.name.endsWith('.md') && ID.test(entry.name.slice(0, -3))) names.push(entry.name);
      }
    } finally { dir.closeSync(); }
    names.sort();
    const matches = []; let warnings = 0;
    for (const name of names) {
      try {
        const doc = metadata(store, name);
        if (!query || `${doc.title}\n${doc.summary}\n${doc.category}`.toLowerCase().includes(query)) matches.push(doc);
      } catch { warnings++; }
    }
    const items = []; let bytes = 0;
    for (const doc of matches.slice(offset, offset + 30)) {
      const size = Buffer.byteLength(JSON.stringify(doc));
      if (bytes + size > 24000) break;
      items.push(doc); bytes += size;
    }
    return { total: matches.length, items, nextOffset: offset + items.length < matches.length ? offset + items.length : null, warnings };
  }
  if (operation === 'knowledge.document.read') {
    if (typeof payload.id !== 'string' || !ID.test(payload.id)) fail('INVALID_ID');
    const doc = store.read(payload.id, offset);
    if (payload.revision && payload.revision !== doc.revision) fail('REVISION_CHANGED');
    const body = doc.body.slice(0, 3000);
    return { id: doc.id, title: doc.title, category: doc.category, summary: doc.summary,
      revision: doc.revision, updatedAt: doc.updatedAt, change: doc.change,
      sources: doc.sources, body, offset,
      nextOffset: body.length < doc.body.length || doc.nextOffset !== null ? offset + body.length : null };
  }
  fail('TOOL_NOT_FOUND');
}
module.exports = { call };
if (require.main === module) {
  try {
    const result = call(process.argv[2], process.argv[3], JSON.parse(process.argv[4] || '{}'));
    if (Buffer.byteLength(JSON.stringify(result)) > 46000) fail('RESPONSE_TOO_LARGE');
    process.stdout.write(JSON.stringify({ ok: true, ...result }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error.code || 'KNOWLEDGE_UNAVAILABLE' }));
  }
}
