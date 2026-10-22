import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as assert from 'node:assert/strict';
import { runActualFlow, assertPositiveFlow, hash } from '../tests/helpers/catslog-projection-harness';

// Runtime logger writes are private stderr. Exactly one stdout JSON verdict.
for (const name of ['log', 'info', 'warn', 'debug'] as const) console[name] = (...args: any[]) => console.error(...args);
const artifactSchema = 'catslog.xiaoba_projection_e2e.artifact.v1';
const basename = 'catslog-projection-e2e-artifact.json';
async function main() {
  const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  assert.equal(manifest.schema, 'catslog.xiaoba_projection_e2e.v1');
  assert.ok(path.isAbsolute(manifest.artifact_dir));
  assert.ok(manifest.question_text && manifest.query_text);
  const url = new URL(manifest.base_url);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'fixture must be loopback');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projection-crossrepo-'));
  const targetRoot = process.env.XIAOBA_PROJECTION_TARGET_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const artifact: any = { schema: artifactSchema, ok: false, provider_calls: 0, semantic_judgment: 'not_evaluated',
    started_at: new Date().toISOString(), checks: [], request_counts: {}, observed_refs: [], delivered_refs: [], retained_refs: [], cited_refs: [],
    source_sha256: Object.fromEntries([
      'src/core/memory-search-branch-session.ts', 'src/core/sidecar-memory-branch.ts', 'src/core/catslog-projection-reference.ts',
      'src/utils/catslog-memory-provider.ts', 'src/utils/catsco-log-agent-client.ts', 'src/tools/memory-branch-tools.ts', 'src/tools/local-tool-risk.ts',
    ].filter(file => fs.existsSync(path.join(targetRoot, file))).map(file => [file, hash(fs.readFileSync(path.join(targetRoot, file), 'utf8'))])),
  };
  try {
    const run = await runActualFlow({ targetRoot, root, baseUrl: manifest.base_url, token: manifest.device_skill_token,
      deviceId: manifest.device_id, skillTokenId: manifest.skill_token_id, tokenExpiresAt: manifest.skill_token_expires_at,
      question: manifest.question_text, keyword: manifest.query_text, forceSearch: true, signal: AbortSignal.timeout(65_000) });
    artifact.requests = run.requests;
    artifact.request_counts = Object.fromEntries(['branch', 'source_read', 'bootstrap'].map(name => [name,
      run.requests.filter(r => r.path === ({ branch: '/catsco/agent/branch', source_read: '/catsco/agent/knowledge/source/read', bootstrap: '/catsco/agent/bootstrap' } as any)[name]).length]));
    artifact.observed_refs = run.observed;
    artifact.delivered_refs = [...run.delivered.keys()];
    artifact.retained_refs = run.retained.map(e => e.ref);
    artifact.cited_refs = run.cited;
    Object.assign(artifact, run.measurements);
    artifact.formatted_content = run.observations.map(o => ({ bytes: Buffer.byteLength(o.formattedContent), sha256: hash(o.formattedContent), refs: JSON.parse(o.formattedContent).refs }));
    assertPositiveFlow(run, manifest.question_text, manifest.root_ref); // root_ref assertions ONLY
    artifact.checks.push('active_session_wire_expansion', 'branch_whole_view', 'formatted_content_whole_view', 'main_actual_input_whole_view', 'safe_ref_subsets');
    assert.equal(artifact.request_counts.bootstrap, 0, 'Skill capability was misused as login token');
    assert.ok(run.requests.every(r => r.capability_matches_initial), 'unexpected capability used');
    assert.ok(run.requests.filter(r => r.path.endsWith('/source/read')).length <= 2, 'shared expansion call budget exceeded');
    const viewBytes = Buffer.byteLength(JSON.stringify({ retained_remote_evidence: [...run.delivered].map(([ref, semantic_view]) => ({ ref, semantic_view })) }), 'utf8');
    artifact.retained_evidence_bytes = viewBytes;
    assert.ok(viewBytes <= 16_000, 'shared whole-view budget exceeded');
    const view = run.retained[0].semantic_view;
    artifact.projection_counts = { node_count: view.nodes.length, edge_count: view.edges.length, condition_count: view.conditions.length, omission_count: view.omissions.length };
    for (const [key, expected] of Object.entries(manifest.oracle)) {
      if (key !== 'page_gaps') assert.equal(artifact.projection_counts[key], expected, `oracle ${key}`);
    }
    for (const page of manifest.oracle.page_gaps ?? []) assert.ok(view.aggregate.gaps.some((g: any) => g.first_page <= page && g.last_page >= page), 'required page gap lost');
    artifact.checks.push('oracle_counts_gaps', 'shared_run_budget', 'no_bootstrap', 'no_paid_provider');
    artifact.ok = true;
  } catch (error: any) {
    // Assertion text is harness-owned; never serialize transport payloads,
    // bearer values, raw documents, or stack traces into the public verdict.
    artifact.error_class = error?.name ?? 'Error';
    artifact.failure = String(error?.message ?? 'flow failed').replaceAll(manifest.device_skill_token, '[redacted]').slice(0, 500);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  artifact.finished_at = new Date().toISOString();
  fs.mkdirSync(manifest.artifact_dir, { recursive: true, mode: 0o700 });
  const artifactPath = path.join(manifest.artifact_dir, basename);
  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ event: artifact.ok ? 'projection_e2e_pass' : 'projection_e2e_fail', artifact_path: artifactPath,
    artifact_schema: artifactSchema, request_counts: artifact.request_counts, observed_ref_count: artifact.observed_refs.length,
    delivered_ref_count: artifact.delivered_refs.length, retained_ref_count: artifact.retained_refs.length, cited_ref_count: artifact.cited_refs.length,
    main_request_count: artifact.main_requests?.length ?? 0 }) + '\n');
  process.exitCode = artifact.ok ? 0 : 1;
}
main().catch(() => { process.stdout.write(JSON.stringify({ event: 'projection_e2e_fail', error: 'invalid_manifest_or_environment' }) + '\n'); process.exitCode = 2; });
