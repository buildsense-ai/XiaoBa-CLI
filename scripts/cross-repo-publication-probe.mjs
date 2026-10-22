#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cats = path.resolve(process.env.CATSCOMPANY_REPO || path.join(root, '..', 'cats-company'));
const expected = ['TestXiaoBaPublicationProbePairedAdmission', 'TestXiaoBaPublicationProbePairedFailures', 'TestXiaoBaPublicationProbePairedDeliveryRecovery'];
const expectedRuns = [...expected,
  ...['normal', 'malformed'].map(name => `${expected[0]}/${name}`),
  ...['change', 'remove', 'disable', 'owner'].map(name => `${expected[1]}/${name}`),
];
for (const file of ['go.mod', 'server/skillhub_publication_workspace_test.go', 'server/skillhub_publication_delivery_test.go', 'server/skillhub_publication_probe_errors.go']) {
  if (!fs.existsSync(path.join(cats, file))) throw new Error(`Required CatsCo contract file missing: ${file}`);
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-publication-paired-'));
try {
  const overlay = path.join(temp, 'overlay.json');
  fs.writeFileSync(overlay, JSON.stringify({ Replace: {
    [path.join(cats, 'server', 'zz_xiaoba_publication_probe_paired_test.go')]: path.join(root, 'tests', 'fixtures', 'publication-probe-paired', 'contract_test.go'),
  } }));
  const result = spawnSync('go', ['test', '-overlay', overlay, './server', '-run', '^TestXiaoBaPublicationProbePaired', '-count=1', '-json'], {
    cwd: cats, shell: false, encoding: 'utf8', timeout: 240_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, XIAOBA_PAIRED_ROOT: root, XIAOBA_PAIRED_NODE: process.execPath },
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error || result.status !== 0 || result.signal) throw new Error(`Paired test failed: ${result.error?.message || result.signal || result.status}`);
  const events = result.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const passed = new Set(events.filter(e => e.Action === 'pass').map(e => e.Test));
  const ran = events.filter(e => e.Action === 'run' && e.Test);
  if (events.some(e => e.Action === 'skip' || e.Action === 'fail') ||
    expectedRuns.some(name => !passed.has(name)) || ran.length !== expectedRuns.length || ran.some(e => !passed.has(e.Test))) {
    throw new Error('Expected all three suites and six admission/error subcases to execute without skips');
  }
  console.log('[publication-paired] Real CatsCo request -> XiaoBa handler -> CatsCo result passed; in-memory store/transport, not deployed E2E.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
