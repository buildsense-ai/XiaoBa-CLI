#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cats = path.resolve(process.env.CATSCOMPANY_REPO || path.join(root, '..', 'cats-company'));
const suite = 'TestXiaoBaPublicationUploadPaired';
const expected = [suite, ...['normal', 'changed-source', 'owner', 'disabled', 'cloud-reject'].map(n => `${suite}/${n}`)];
for (const file of ['go.mod', 'server/skillhub_publication_upload_transport.go', 'server/skillhub_publication_upload_transport_test.go']) {
  if (!fs.existsSync(path.join(cats, file))) throw new Error(`Required CatsCo upload contract missing: ${file}`);
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-upload-rpc-paired-'));
try {
  const overlay = path.join(temp, 'overlay.json');
  const Replace = {};
  for (const [name, source] of [['probe', 'contract_test.go'], ['capture', 'capture_contract_test.go'], ['upload', 'upload_contract_test.go']]) {
    Replace[path.join(cats, 'server', `zz_xiaoba_publication_${name}_paired_test.go`)] =
      path.join(root, 'tests', 'fixtures', 'publication-probe-paired', source);
  }
  fs.writeFileSync(overlay, JSON.stringify({ Replace }));
  const result = spawnSync('go', ['test', '-overlay', overlay, './server', '-run', `^${suite}$`, '-count=1', '-json'], {
    cwd: cats, shell: false, encoding: 'utf8', timeout: 240_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, XIAOBA_PAIRED_ROOT: root, XIAOBA_PAIRED_NODE: process.execPath },
  });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error || result.status !== 0 || result.signal) throw new Error(`Upload RPC contract failed: ${result.error?.message || result.signal || result.status}`);
  const events = result.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const passed = new Set(events.filter(e => e.Action === 'pass').map(e => e.Test));
  const ran = events.filter(e => e.Action === 'run' && e.Test);
  if (events.some(e => e.Action === 'skip' || e.Action === 'fail') || expected.some(n => !passed.has(n)) ||
    ran.length !== expected.length || ran.some(e => !passed.has(e.Test))) {
    throw new Error('Upload suite and all five subcases must run without skips');
  }
  console.log('[upload-rpc-paired] Real transports and TLS upload passed; synthetic authority/socket/Cloud, not deployed E2E.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
