import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startCatsLogProjectionFixture } from './helpers/catslog-projection-fixture';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function runChild(wrongRoot = false) {
  const fixture = await startCatsLogProjectionFixture({ hideRecency: true });
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'projection-launcher-'));
  for (const sub of ['home', 'tmp', 'artifacts']) fs.mkdirSync(path.join(sandbox, sub), { mode: 0o700 });
  const manifest = { schema: 'catslog.xiaoba_projection_e2e.v1', base_url: fixture.baseUrl, device_skill_token: fixture.token,
    question_text: 'For Meridian, what are the release conditions and the limits of the withheld metric?', query_text: 'Meridian',
    root_ref: wrongRoot ? `ref_${'f'.repeat(64)}` : fixture.identities[0].ref,
    artifact_dir: path.join(sandbox, 'artifacts'), oracle: { node_count: 10, edge_count: 7, condition_count: 3, omission_count: 2, page_gaps: [2] } };
  const filename = path.join(sandbox, 'manifest.json'); fs.writeFileSync(filename, JSON.stringify(manifest), { mode: 0o600 });
  try {
    const child = spawn(process.execPath, [path.join(root, 'scripts/catslog-projection-e2e.mjs'), '--manifest', filename], {
      cwd: root, env: { PATH: process.env.PATH, HOME: path.join(sandbox, 'home'), TMPDIR: path.join(sandbox, 'tmp'), LANG: 'C.UTF-8', NODE_ENV: 'test',
        ...(process.env.XIAOBA_PROJECTION_TARGET_ROOT ? { XIAOBA_PROJECTION_TARGET_ROOT: process.env.XIAOBA_PROJECTION_TARGET_ROOT } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    fs.writeFileSync('/tmp/catslog-f-launcher-private.log', stderr, { mode: 0o600 });
    const lines = stdout.trim().split('\n'); assert.equal(lines.length, 1, 'stdout must contain exactly one JSON verdict');
    const verdict = JSON.parse(lines[0]);
    assert.equal(path.basename(verdict.artifact_path), 'catslog-projection-e2e-artifact.json');
    assert.equal(fs.statSync(verdict.artifact_path).mode & 0o777, 0o600);
    const artifact = JSON.parse(fs.readFileSync(verdict.artifact_path, 'utf8'));
    assert.equal(artifact.schema, 'catslog.xiaoba_projection_e2e.artifact.v1');
    assert.ok(!JSON.stringify(artifact).includes(fixture.token), 'token in artifact');
    const counts = { branch: fixture.requests.filter(r => r.path.endsWith('/branch')).length,
      source_read: fixture.requests.filter(r => r.path.endsWith('/source/read')).length,
      bootstrap: fixture.bootstraps };
    assert.deepEqual(verdict.request_counts, counts, 'attested counts differ from server counts');
    if (wrongRoot) {
      assert.notEqual(code, 0); assert.equal(verdict.event, 'projection_e2e_fail'); assert.equal(artifact.ok, false);
      for (const request of fixture.requests.filter(r => r.path.endsWith('/source/read'))) assert.notEqual(request.body.projection_ref, manifest.root_ref, 'assert-only root leaked into reads');
    } else {
      assert.equal(code, 0, `runner failed: ${artifact.failure}`); assert.equal(verdict.event, 'projection_e2e_pass');
      assert.equal(artifact.ok, true); assert.equal(verdict.main_request_count, 1);
      assert.equal(verdict.delivered_ref_count, 1); assert.equal(verdict.retained_ref_count, 1); assert.equal(verdict.cited_ref_count, 1);
      assert.equal(artifact.provider_calls, 0); assert.equal(counts.bootstrap, 0);
      assert.deepEqual(artifact.delivered_refs, artifact.retained_refs); assert.deepEqual(artifact.retained_refs, artifact.cited_refs);
      assert.ok(artifact.main_requests[0].evidence.length > 0);
      // Optional persistent, body-free review artifact; default tests clean
      // every sandbox. This is explicitly a Node-loopback artifact, not PG.
      const output = process.env.CATSLOG_PROJECTION_TEST_ARTIFACT_DIR;
      if (output) {
        assert.ok(path.isAbsolute(output)); fs.mkdirSync(output, { recursive: true, mode: 0o700 });
        fs.copyFileSync(verdict.artifact_path, path.join(output, 'catslog-projection-e2e-artifact.json'));
        fs.writeFileSync(path.join(output, 'loopback-server-verification.json'), JSON.stringify({
          fixture: 'node_loopback', counts, verdict, server_counts_match_attestation: true,
        }, null, 2), { mode: 0o600 });
      }
    }
  } finally { await fixture.close(); fs.rmSync(sandbox, { recursive: true, force: true }); }
}
test('plain node launcher attests measured HTTP and actual MAIN input, under minimal Go-fixture environment', async () => { await runChild(); });
test('assert-only manifest.root_ref mismatch fails without ever reading that ref', async () => { await runChild(true); });
