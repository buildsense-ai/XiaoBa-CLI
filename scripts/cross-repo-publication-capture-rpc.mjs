#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cats = path.resolve(process.env.CATSCOMPANY_REPO || path.join(root, '..', 'cats-company'));
const suites = ['TestXiaoBaPublicationCapturePairedReplay', 'TestXiaoBaPublicationCapturePairedFailures', 'TestXiaoBaPublicationCapturePairedLateOwnerChange'];
const expected = [...suites,
  ...['normal', 'malformed'].map(n => `${suites[0]}/${n}`),
  ...['change', 'remove', 'disable', 'owner', 'switching'].map(n => `${suites[1]}/${n}`),
];
for (const file of ['go.mod', 'server/skillhub_publication_capture_transport.go', 'server/skillhub_publication_capture_transport_test.go']) {
  if (!fs.existsSync(path.join(cats, file))) throw new Error(`Required CatsCo capture contract missing: ${file}`);
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-capture-rpc-paired-'));
try {
  const overlay = path.join(temp, 'overlay.json');
  fs.writeFileSync(overlay, JSON.stringify({ Replace: {
    [path.join(cats, 'server', 'zz_xiaoba_publication_probe_paired_test.go')]: path.join(root, 'tests', 'fixtures', 'publication-probe-paired', 'contract_test.go'),
    [path.join(cats, 'server', 'zz_xiaoba_publication_capture_paired_test.go')]: path.join(root, 'tests', 'fixtures', 'publication-probe-paired', 'capture_contract_test.go'),
  } }));
  const result = spawnSync('go', ['test', '-overlay', overlay, './server', '-run', '^TestXiaoBaPublicationCapturePaired', '-count=1', '-json'], {
    cwd: cats, shell: false, encoding: 'utf8', timeout: 240_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, XIAOBA_PAIRED_ROOT: root, XIAOBA_PAIRED_NODE: process.execPath },
  });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error || result.status !== 0 || result.signal) throw new Error(`Capture RPC contract failed: ${result.error?.message || result.signal || result.status}`);
  const events = result.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const passed = new Set(events.filter(e => e.Action === 'pass').map(e => e.Test));
  const ran = events.filter(e => e.Action === 'run' && e.Test);
  if (events.some(e => e.Action === 'skip' || e.Action === 'fail') || expected.some(n => !passed.has(n)) ||
    ran.length !== expected.length || ran.some(e => !passed.has(e.Test))) {
    throw new Error('All three capture suites and seven subcases must run without skips');
  }
  console.log('[capture-rpc-paired] Real CatsCo transport -> XiaoBa capture -> CatsCo receipt passed; synthetic socket/store, not deployed E2E.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
