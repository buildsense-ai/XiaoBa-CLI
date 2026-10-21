import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as assert from 'node:assert/strict';
import { runActualFlow, assertDeltaAssertionFlow, assertPositiveFlow, hash } from '../tests/helpers/catslog-projection-harness';

// Runtime logger writes are private stderr. Exactly one stdout JSON verdict.
for (const name of ['log', 'info', 'warn', 'debug'] as const) console[name] = (...args: any[]) => console.error(...args);
const artifactSchema = 'catslog.xiaoba_projection_e2e.artifact.v1';
const basename = 'catslog-projection-e2e-artifact.json';
const safeAssertionStages = new Set([
  'branch_request_protocol', 'source_read_protocol', 'query_candidate_and_capability', 'delivered_delta_contract',
  'delta_source_read_document', 'authored_node_locator', 'delta_semantic_view_contract', 'whole_delta_projection',
  'assertion_closure_count', 'complete_closure_shape', 'main_input_injection', 'main_formatted_observation_presence',
  'main_formatted_delta_closure_presence', 'main_input_entry_presence', 'main_input_delta_contract',
  'main_input_closure_count', 'main_input_closure_match', 'main_input_top_level_keys', 'main_input_document',
  'main_input_aggregate', 'main_input_nodes', 'main_input_mappings', 'main_input_whole_delta', 'main_input_closures',
  'main_input_closure_keys', 'main_input_closure_status', 'main_input_closure_read_required',
  'main_input_closure_content_trust', 'main_input_closure_source_completeness', 'main_input_closure_projection_ref',
  'main_input_closure_member_ref', 'main_input_closure_covered_ranges', 'main_input_closure_assertion',
  'main_input_closure_entries', 'main_input_closure_relations', 'main_input_closure_bytes', 'main_input_closure_nodes',
  'main_input_closure_all_fields', 'main_input_citation', 'delta_source_metadata', 'main_view_source_envelope',
  'main_input_private_scope_key', 'main_input_private_principal', 'main_input_private_scope',
]);
async function main() {
  assert.ok(path.isAbsolute(process.argv[2] ?? ''), 'manifest path must be absolute');
  const manifestStat = fs.lstatSync(process.argv[2]);
  assert.ok(manifestStat.isFile() && !manifestStat.isSymbolicLink(), 'manifest must be a regular file');
  assert.equal(manifestStat.mode & 0o077, 0, 'manifest must be private');
  const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  assert.equal(manifest.schema, 'catslog.xiaoba_projection_e2e.v1');
  assert.ok(path.isAbsolute(manifest.artifact_dir));
  assert.ok(manifest.question_text && manifest.query_text);
  assert.ok(manifest.assertion_mode === undefined || manifest.assertion_mode === 'delta_authored', 'unsupported assertion mode');
  const url = new URL(manifest.base_url);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'fixture must be loopback');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projection-crossrepo-'));
  const targetRoot = process.env.XIAOBA_PROJECTION_TARGET_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const artifact: any = { schema: artifactSchema, ok: false, provider_calls: 0, semantic_judgment: 'not_evaluated',
    started_at: new Date().toISOString(), checks: [], request_counts: {}, observed_refs: [], delivered_refs: [], retained_refs: [], cited_refs: [],
    source_sha256: Object.fromEntries([
      'src/core/memory-search-branch-session.ts', 'src/core/sidecar-memory-branch.ts', 'src/core/catslog-projection-reference.ts',
      'src/utils/catslog-memory-provider.ts', 'src/utils/catsco-log-agent-client.ts', 'src/tools/memory-branch-tools.ts', 'src/tools/local-tool-risk.ts',
      'scripts/catslog-projection-e2e-worker.ts', 'tests/helpers/catslog-projection-harness.ts',
    ].filter(file => fs.existsSync(path.join(targetRoot, file))).map(file => [file, hash(fs.readFileSync(path.join(targetRoot, file), 'utf8'))])),
  };
  let failureStage = 'run_actual_flow';
  try {
    const run = await runActualFlow({ targetRoot, root, baseUrl: manifest.base_url, token: manifest.device_skill_token,
      deviceId: manifest.device_id, skillTokenId: manifest.skill_token_id, tokenExpiresAt: manifest.skill_token_expires_at,
      question: manifest.question_text, keyword: manifest.query_text, forceSearch: true, signal: AbortSignal.timeout(65_000),
      ...(manifest.assertion_mode === 'delta_authored' ? { readAssertion: true, assertionMode: 'delta_authored' as const } : {}) });
    artifact.requests = run.requests;
    artifact.root_ref_sha256 = hash(manifest.root_ref);
    artifact.source_read_structure = [...run.successfulReads].map(([ref, response]: [string, any]) => {
      const projection = response?.projection;
      const document = projection?.Document;
      const aggregate = document?.aggregate;
      return {
        requested_ref_sha256: hash(ref),
        schema_version: response?.schema_version,
        content_trust: response?.content_trust,
        projection_keys: projection && typeof projection === 'object' ? Object.keys(projection).sort() : [],
        revision_matches_requested_ref: Boolean(projection?.Revision && projection?.StreamID),
        document_keys: document && typeof document === 'object' ? Object.keys(document).sort() : [],
        document_contract: document?.transform_contract ?? null,
        document_array_counts: Object.fromEntries(['nodes', 'edges', 'mappings', 'conditions', 'omissions'].map(key => [key, Array.isArray(document?.[key]) ? document[key].length : null])),
        node_kinds: Array.isArray(document?.nodes) ? document.nodes.reduce((counts: Record<string, number>, node: any) => { const kind = typeof node?.kind === 'string' ? node.kind : 'invalid'; counts[kind] = (counts[kind] ?? 0) + 1; return counts; }, {}) : {},
        aggregate_keys: aggregate && typeof aggregate === 'object' ? Object.keys(aggregate).sort() : [],
        aggregate_contract: aggregate?.contract ?? null,
        aggregate_array_counts: Object.fromEntries(['leaves', 'pages', 'ranges', 'gaps', 'qualifier_bindings', 'delta_relations'].map(key => [key, Array.isArray(aggregate?.[key]) ? aggregate[key].length : null])),
        source_count: Array.isArray(response?.sources) ? response.sources.length : null,
      };
    });
    artifact.request_counts = Object.fromEntries(['branch', 'source_read', 'bootstrap'].map(name => [name,
      run.requests.filter(r => r.path === ({ branch: '/catsco/agent/branch', source_read: '/catsco/agent/knowledge/source/read', bootstrap: '/catsco/agent/bootstrap' } as any)[name]).length]));
    if (manifest.assertion_mode === 'delta_authored') artifact.request_counts.assertion_read =
      run.requests.filter(r => r.path.endsWith('/source/read') && r.body_keys.includes('assertion')).length;
    artifact.requests = run.requests.map(r => ({ method: r.method, path: r.path, body_keys: r.body_keys.slice().sort(),
      ...(r.query_text !== undefined ? { query_codepoints: Array.from(r.query_text).length, query_sha256: hash(r.query_text) } : {}),
      ...(r.projection_ref !== undefined ? { projection_ref_sha256: hash(r.projection_ref) } : {}),
      ...(r.assertion_body_keys ? { assertion_body_keys: r.assertion_body_keys,
        assertion_member_is_projection_root: r.assertion_member_is_projection_root,
        assertion_node_id_sha256: r.assertion_node_id_sha256,
        assertion_max_bytes: r.assertion_max_bytes, assertion_max_nodes: r.assertion_max_nodes } : {}),
      status: r.status, response_bytes: r.response_bytes, response_sha256: r.response_sha256,
      capability_matches_initial: r.capability_matches_initial, ...(r.error_class ? { error_class: r.error_class } : {}) }));
    artifact.observed_refs = run.observed.map(hash);
    artifact.delivered_refs = [...run.delivered.keys()].map(hash);
    artifact.retained_refs = run.retained.map(e => hash(e.ref));
    artifact.cited_refs = run.cited.map(hash);
    artifact.main_model_calls = run.mainCalls.length;
    artifact.measurements = Object.fromEntries(Object.entries(run.measurements).map(([key, requests]: [string, any]) => [key,
      requests.map((request: any) => ({ input_bytes: request.input_bytes, input_sha256: request.input_sha256,
        evidence: request.evidence.map((e: any) => ({ ref_sha256: hash(e.ref), bytes: e.bytes, sha256: e.sha256 })) }))]));
    artifact.branch_requests = artifact.measurements.branch_requests;
    artifact.main_requests = artifact.measurements.main_requests;
    artifact.branch_tool_results = run.branchToolResults;
    artifact.formatted_content = run.observations.map(o => ({ bytes: Buffer.byteLength(o.formattedContent), sha256: hash(o.formattedContent) }));
    if (manifest.assertion_mode === 'delta_authored') {
      assertDeltaAssertionFlow(run, manifest.question_text, manifest.root_ref, stage => {
        failureStage = safeAssertionStages.has(stage) ? stage : 'delta_assertion_flow';
      });
      failureStage = 'delta_artifact_fields';
      const semanticView = run.retained[0].semantic_view;
      const closure = semanticView.assertion_closures[0];
      artifact.assertion_closure = { complete: closure.status === 'complete' && closure.read_required === false,
        content_trust: closure.content_trust, source_completeness: closure.source_completeness,
        member_is_root: closure.member_ref === manifest.root_ref, projection_is_root: closure.projection_ref === manifest.root_ref,
        assertion_node_id_sha256: hash(closure.assertion.id), covered_range_count: closure.covered_ranges.length,
        entry_count: closure.entries.length, relation_count: closure.relations.length,
        bytes: closure.bytes, nodes: closure.nodes, semantic_sha256: hash(JSON.stringify(closure)) };
      const mainEntry = run.mainCalls.flatMap(messages => messages.flatMap(message => {
        if (typeof message.content !== 'string') return [];
        try { return JSON.parse(message.content).retained_remote_evidence ?? []; } catch { return []; }
      })).find(entry => entry.ref === manifest.root_ref);
      artifact.main_input_contains_complete_assertion_closure = Boolean(mainEntry
        && JSON.stringify(mainEntry.semantic_view) === JSON.stringify(semanticView));
      failureStage = 'main_input_closure_attestation';
      assert.equal(artifact.main_input_contains_complete_assertion_closure, true, 'main input omitted the complete closure');
      artifact.main_input_view_sha256 = mainEntry ? hash(JSON.stringify(mainEntry.semantic_view)) : undefined;
      artifact.checks.push('delta_authored_assertion_from_delivered_view', 'root_member_binding',
        'complete_closure_in_main_input', 'no_private_scope_or_token');
    } else {
      assertPositiveFlow(run, manifest.question_text, manifest.root_ref); // root_ref assertions ONLY
    }
    artifact.checks.push('active_session_wire_expansion', 'branch_whole_view', 'formatted_content_whole_view', 'main_actual_input_whole_view', 'safe_ref_subsets');
    failureStage = 'protocol_no_bootstrap';
    assert.equal(artifact.request_counts.bootstrap, 0, 'Skill capability was misused as login token');
    failureStage = 'capability_stability';
    assert.ok(run.requests.every(r => r.capability_matches_initial), 'unexpected capability used');
    failureStage = 'source_read_budget';
    assert.ok(run.requests.filter(r => r.path.endsWith('/source/read')).length <= 2, 'shared expansion call budget exceeded');
    if (manifest.assertion_mode === 'delta_authored') {
      failureStage = 'assertion_read_budget';
      assert.equal(artifact.request_counts.assertion_read, 1, 'exactly one assertion read expected');
    }
    const viewBytes = Buffer.byteLength(JSON.stringify({ retained_remote_evidence: [...run.delivered].map(([ref, semantic_view]) => ({ ref, semantic_view })) }), 'utf8');
    artifact.retained_evidence_bytes = viewBytes;
    failureStage = 'retained_view_budget';
    assert.ok(viewBytes <= 16_000, 'shared whole-view budget exceeded');
    const view = run.retained[0].semantic_view;
    artifact.projection_counts = { node_count: view.nodes.length, edge_count: view.edges.length, condition_count: view.conditions.length, omission_count: view.omissions.length };
    failureStage = 'projection_oracle_counts';
    for (const [key, expected] of Object.entries(manifest.oracle)) {
      if (key !== 'page_gaps') assert.equal(artifact.projection_counts[key], expected, `oracle ${key}`);
    }
    failureStage = 'projection_oracle_gaps';
    for (const page of manifest.oracle.page_gaps ?? []) assert.ok(view.aggregate.gaps.some((g: any) => g.first_page <= page && g.last_page >= page), 'required page gap lost');
    artifact.checks.push('oracle_counts_gaps', 'shared_run_budget', 'no_bootstrap', 'no_paid_provider');
    artifact.ok = true;
  } catch (error: any) {
    // Keep failed-run artifacts strictly hash/count-only. Assertion messages can
    // include refs, node IDs, queries, or source text, so persist no exception text.
    artifact.error_class = error?.name ?? 'Error';
    artifact.failure_stage = failureStage;
    artifact.failure_code = 'projection_e2e_failed';
    artifact.failure = 'E2E failure details withheld';
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  artifact.finished_at = new Date().toISOString();
  const artifactPath = path.join(manifest.artifact_dir, basename);
  if (fs.existsSync(manifest.artifact_dir)) {
    const dirStat = fs.lstatSync(manifest.artifact_dir);
    assert.ok(dirStat.isDirectory() && !dirStat.isSymbolicLink(), 'artifact_dir must be a real directory');
    assert.equal(dirStat.mode & 0o077, 0, 'artifact_dir must be private');
  } else fs.mkdirSync(manifest.artifact_dir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(artifactPath)) {
    const fileStat = fs.lstatSync(artifactPath);
    assert.ok(fileStat.isFile() && !fileStat.isSymbolicLink(), 'artifact must be a regular file');
    assert.equal(fileStat.mode & 0o077, 0, 'existing artifact must be private');
  }
  const artifactJson = JSON.stringify(artifact, null, 2);
  failureStage = 'artifact_token_privacy';
  assert.ok(!artifactJson.includes(manifest.device_skill_token), 'device capability leaked into artifact');
  failureStage = 'artifact_private_field_privacy';
  assert.ok(!artifactJson.includes('private-principal-sentinel') && !artifactJson.includes('private-scope-sentinel')
    && !artifactJson.includes('source_scope'), 'private source scope leaked into artifact');
  fs.writeFileSync(artifactPath, artifactJson, { mode: 0o600 });
  assert.equal(fs.statSync(artifactPath).mode & 0o077, 0, 'artifact must be private');
  process.stdout.write(JSON.stringify({ event: artifact.ok ? 'projection_e2e_pass' : 'projection_e2e_fail', artifact_path: artifactPath,
    artifact_schema: artifactSchema, request_counts: artifact.request_counts, observed_ref_count: artifact.observed_refs.length,
    delivered_ref_count: artifact.delivered_refs.length, retained_ref_count: artifact.retained_refs.length, cited_ref_count: artifact.cited_refs.length,
    main_request_count: artifact.main_model_calls ?? 0 }) + '\n');
  process.exitCode = artifact.ok ? 0 : 1;
}
main().catch(() => { process.stdout.write(JSON.stringify({ event: 'projection_e2e_fail', error: 'invalid_manifest_or_environment' }) + '\n'); process.exitCode = 2; });
