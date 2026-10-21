#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildIsolatedTestEnvironment } from './test-environment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.CATSCOMPANY_REPO) throw new Error('Set CATSCOMPANY_REPO to the paired local checkout');
const cats = path.resolve(process.env.CATSCOMPANY_REPO);
for (const file of ['go.mod', 'server/device_selection_test.go']) {
  if (!fs.existsSync(path.join(cats, file))) throw new Error(`Missing paired server file: ${file}`);
}
// Test artifacts stay on the checkout's drive and never enter a release.
const scratch = path.join(root, '.audit-tmp');
fs.mkdirSync(scratch, { recursive: true });
const temp = fs.mkdtempSync(path.join(scratch, 'multi-device-paired-'));
for (const name of ['home', 'tmp']) fs.mkdirSync(path.join(temp, name));
const overlay = path.join(temp, 'overlay.json');
fs.writeFileSync(overlay, JSON.stringify({ Replace: {
  [path.join(cats, 'server', 'zz_xiaoba_multi_device_paired_test.go')]:
    path.join(root, 'tests', 'fixtures', 'multi-device-paired', 'contract_test.go'),
} }));
const result = spawnSync(process.env.GO_BINARY || 'go', ['test', '-overlay', overlay,
  './server', '-run', '^TestXiaoBaMultiDevicePairedContract$', '-count=1', '-timeout=120s', '-json'], {
  cwd: cats, shell: false, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
  env: { ...buildIsolatedTestEnvironment(process.env, { homeDir: path.join(temp, 'home'),
    tempDir: path.join(temp, 'tmp'), appRoot: root, dotenvPath: path.join(temp, 'absent.env') }),
    XIAOBA_PAIRED_ROOT: root, XIAOBA_PAIRED_NODE: process.execPath,
    CATSCO_XIAOBA_RUNTIME_V2_ENABLED: '1', CATSCO_DEVICE_GRANT_ENFORCEMENT: 'required' },
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.error || result.status !== 0 || result.signal) throw new Error(`Paired contract failed: ${result.error?.message || result.signal || result.status}`);
const events = result.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const suite = 'TestXiaoBaMultiDevicePairedContract';
const names = ['', '/multiple_devices_require_selection', '/selected_a', '/selected_b',
  '/no_default_explicit_B', '/selected_a/explicit_B_while_default_A', '/selected_a/both_targets_keep_default_A',
  '/explicit_A_while_default_B_offline',
  '/old_A_wire_rejected_after_switch', '/legacy_unscoped_wire_requires_upgrade',
  '/server_host_without_desktop_authorization', '/selected_B_offline_does_not_fallback_to_A'];
const passed = new Set(events.filter(event => event.Action === 'pass').map(event => event.Test));
if (names.some(name => !passed.has(suite + name)) || events.some(event => event.Action === 'skip' || event.Action === 'fail')) {
  throw new Error('Required paired scenarios did not all pass');
}
console.log('[multi-device-paired] 11 scenarios passed; real metadata/CLI wire/server dispatch, simulated storage/devices, not deployed E2E.');
