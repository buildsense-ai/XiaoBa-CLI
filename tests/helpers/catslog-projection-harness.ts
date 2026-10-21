import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);

export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const poolRef = (value: unknown): value is string => typeof value === 'string' && /^ref_[a-f0-9]{64}$/.test(value);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function recordsIn(value: any, key: string): any[] {
  if (!value || typeof value !== 'object') return [];
  const found = value[key] !== undefined ? [value[key]] : [];
  return found.concat(Object.values(value).flatMap(child => recordsIn(child, key)));
}
export function messageObjects(messages: any[]): any[] {
  return messages.flatMap(message => {
    if (typeof message.content !== 'string') return [];
    try { return [JSON.parse(message.content)]; } catch { return []; }
  });
}
function decodedToolResultObjects(messages: any[]): any[] {
  const out: any[] = [];
  const visit = (value: any, depth: number) => {
    if (typeof value === 'string') {
      try { visit(JSON.parse(value), depth + 1); return; } catch { /* tool text need not be bare JSON */ }
      const start = value.indexOf('{');
      const end = value.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try { visit(JSON.parse(value.slice(start, end + 1)), depth + 1); } catch { /* ignore non-JSON tool text */ }
      }
      return;
    }
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (typeof value !== 'object') return;
    out.push(value);
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  for (const message of messages) if (message.role === 'tool') visit(message.content, 0);
  return out;
}
function summarizeToolResults(messages: any[]) {
  return messages.filter(message => message.role === 'tool').map(message => {
    const content = typeof message.content === 'string' ? message.content : '';
    const decoded = decodedToolResultObjects([message]);
    return {
      name: typeof message.name === 'string' ? message.name : 'unknown',
      content_bytes: Buffer.byteLength(content), content_sha256: hash(content),
      parsed_object_count: decoded.length,
      parsed_objects: decoded.map(object => ({
        keys: Object.keys(object).sort(),
        status: ['complete', 'bounded', 'not_found', 'reference_only'].includes(object.status) ? object.status : 'other',
        content_trust: ['derived_assertion_closure', 'derived_memory_projection', 'derived_membership_index'].includes(object.content_trust) ? object.content_trust : 'other',
        closure_keys: object.closure && typeof object.closure === 'object' ? Object.keys(object.closure).sort() : [],
        closure_status: object.closure?.status ?? null,
        closure_content_trust: object.closure?.content_trust ?? null,
        expansion_error: ['invalid_assertion_closure', 'semantic_view_over_budget', 'assertion_read_budget_exhausted', 'source_read_budget_exhausted', 'assertion_locator_not_in_delivered_membership', 'assertion_root_unavailable', 'not_a_discovered_root', 'capability_unavailable', 'aborted'].includes(object.expansion_error) ? object.expansion_error : null,
      })),
      assertion_closure_result_count: decoded.filter(object => poolRef(object.ref) && object.status === 'complete'
        && object.content_trust === 'derived_assertion_closure' && object.closure && typeof object.closure === 'object').length,
    };
  });
}
export function visibleNavigableExpansions(messages: any[]): any[] {
  return messageObjects(messages).flatMap(object => [object, ...recordsIn(object, 'source_reference_expansions').flat()])
    .filter((entry: any) => poolRef(entry?.ref) && entry.status === 'expanded' && entry.semantic_view);
}
export function visibleExpansions(messages: any[]): any[] {
  return visibleNavigableExpansions(messages).filter((entry: any) => entry.final_evidence !== false
    && entry.semantic_view?.final_evidence !== false
    && entry.content_trust !== 'derived_membership_index'
    && entry.semantic_view?.content_trust !== 'derived_membership_index');
}
export function assertWhole(view: any, document: any, onStage: (stage: string) => void = () => {}) {
  for (const key of ['goal', 'summary', 'transform_contract', 'overall_coverage', 'gap_acknowledgement', 'conditions', 'omissions', 'nodes', 'edges']) {
    onStage(`whole_view_${key}`);
    assert.deepEqual(view[key], document[key], `whole-view preservation failed: ${key}`);
  }
  if (document.aggregate) {
    onStage('whole_view_aggregate_gaps');
    const expectedGaps = (document.aggregate.gaps ?? decodeGapTable(document.aggregate) ?? [])
      .map((gap: any) => ({ first_page: gap.first_page, last_page: gap.last_page, status: gap.status }));
    assert.deepEqual(view.aggregate?.gaps, expectedGaps, 'page gap lost');
  }
  const semanticMappings = (document.mappings ?? []).map((mapping: any) => ({
    node_id: mapping.node_id,
    ...(poolRef(mapping.source_ref) ? { source_ref: mapping.source_ref } : {}),
    ...(typeof mapping.digest === 'string' ? { digest: mapping.digest } : {}),
    ...(typeof mapping.source_digest === 'string' ? { source_digest: mapping.source_digest } : {}),
  }));
  const actualMappings = Array.isArray(view.mappings) ? view.mappings : [];
  onStage('whole_view_mapping_count');
  assert.equal(actualMappings.length, semanticMappings.length, 'mapping count changed');
  onStage('whole_view_mapping_node_ids');
  assert.deepEqual(actualMappings.map((mapping: any) => mapping.node_id), semanticMappings.map(mapping => mapping.node_id), 'mapping node IDs changed');
  onStage('whole_view_mapping_source_refs');
  assert.deepEqual(actualMappings.map((mapping: any) => mapping.source_ref ?? null), semanticMappings.map(mapping => mapping.source_ref ?? null), 'mapping source refs changed');
  onStage('whole_view_mapping_digests');
  assert.deepEqual(actualMappings.map((mapping: any) => mapping.digest ?? null), semanticMappings.map(mapping => mapping.digest ?? null), 'mapping digests changed');
  onStage('whole_view_mapping_source_digests');
  assert.deepEqual(actualMappings.map((mapping: any) => mapping.source_digest ?? null), semanticMappings.map(mapping => mapping.source_digest ?? null), 'mapping source digests changed');
  onStage('whole_view_mapping_keys');
  assert.deepEqual(actualMappings.map((mapping: any) => Object.keys(mapping).sort()), semanticMappings.map(mapping => Object.keys(mapping).sort()), 'mapping fields changed');
  const actualRows = actualMappings.map((mapping: any) => [mapping.node_id, mapping.source_ref ?? null, mapping.digest ?? null, mapping.source_digest ?? null]);
  const expectedRows = semanticMappings.map(mapping => [mapping.node_id, mapping.source_ref ?? null, mapping.digest ?? null, mapping.source_digest ?? null]);
  const mismatches = actualRows.flatMap((row, index) => {
    const expected = expectedRows[index] ?? [];
    const fields = ['node_id', 'source_ref', 'digest', 'source_digest'].filter((_, field) => row[field] !== expected[field]);
    return fields.length ? [`${index}_${fields.join('_')}`] : [];
  });
  onStage(`whole_view_mapping_rows_${mismatches.length ? 'field_mismatch' : 'field_match'}`);
  assert.equal(JSON.stringify(actualRows), JSON.stringify(expectedRows), 'node/source mapping refs or digests lost');
}
export async function loadActual(targetRoot: string) {
  const imp = (file: string) => require(path.join(targetRoot, file));
  const [provider, session, synthetic, runner, executor] = await Promise.all([
    imp('src/utils/catslog-memory-provider.ts'), imp('src/core/sidecar-memory-branch.ts'),
    imp('src/core/synthetic-observation.ts'), imp('src/core/conversation-runner.ts'),
    imp('src/agents/agent-tool-executor.ts'),
  ]);
  return { ...provider, ...session, ...synthetic, ...runner, ...executor };
}

export interface RunOptions {
  targetRoot: string; root: string; baseUrl: string; token: string; question: string; keyword: string;
  tokenExpiresAt?: string; deviceId?: string; skillTokenId?: string;
  forceSearch?: boolean; citeUndelivered?: boolean; finishRef?: string; readAll?: boolean; readAssertion?: boolean;
  assertionMode?: 'collection_fixture' | 'delta_authored';
  readSequence?: Array<'projection' | 'assertion'>;
  beforeSourceRead?: (root: string) => void;
  loginToken?: string; signal?: AbortSignal; cancelAtRead?: Promise<void>;
  injectedBackend?: (provider: any) => any;
}
/** Independent instrumentation: no pre-session reads and no production helper validation. */
export async function runActualFlow(options: RunOptions) {
  const actual = await loadActual(options.targetRoot);
  const env: any = { ...process.env, CATSCO_LOG_API_BASE_URL: options.baseUrl, CATSLOG_MEMORY_ENABLED: 'true',
    DOTENV_CONFIG_PATH: path.join(options.root, 'empty.env'), XIAOBA_USER_DATA_DIR: options.root };
  delete env.CATSCO_USER_TOKEN;
  delete env.CATSCOMPANY_USER_TOKEN;
  if (options.loginToken) env.CATSCO_USER_TOKEN = options.loginToken;
  fs.mkdirSync(path.join(options.root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(options.root, 'empty.env'), '');
  fs.writeFileSync(path.join(options.root, 'data/catsco-log-agent-state.json'), JSON.stringify({
    schemaVersion: 1, deviceId: options.deviceId ?? 'fixture-device', skillToken: options.token,
    ...(options.skillTokenId ? { skillTokenId: options.skillTokenId } : {}),
    skillTokenExpiresAt: options.tokenExpiresAt ?? new Date(Date.now() + 86_400_000).toISOString(), branchUrl: '/catsco/agent/branch', uploaded: {},
  }), { mode: 0o600 });
  const provider = new actual.CatsLogMemoryProvider(options.root, { env });
  const requests: any[] = [];
  const successfulReads = new Map<string, any>();
  const observed = new Set<string>();
  const branchCandidatePools: Array<{ queryText: string; refs: Set<string> }> = [];
  const nativeFetch = globalThis.fetch;
  const allowedOrigin = new URL(options.baseUrl).origin;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? input.toString());
    assert.equal(url.origin, allowedOrigin, 'outbound request escaped fixture origin');
    assert.ok(['/catsco/agent/branch', '/catsco/agent/knowledge/source/read', '/catsco/agent/bootstrap'].includes(url.pathname), 'unexpected HTTP route');
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const request: any = { method: init.method ?? 'GET', path: url.pathname, body_keys: Object.keys(body),
      ...(body.query_text !== undefined ? { query_text: body.query_text } : {}),
      ...(body.projection_ref !== undefined ? { projection_ref: body.projection_ref } : {}),
      ...(body.assertion && typeof body.assertion === 'object' ? {
        assertion_body_keys: Object.keys(body.assertion).sort(),
        assertion_member_is_projection_root: body.assertion.member_ref === body.projection_ref,
        assertion_node_id_sha256: hash(String(body.assertion.node_id ?? '')),
        assertion_max_bytes: body.assertion.max_bytes,
        assertion_max_nodes: body.assertion.max_nodes,
      } : {}),
      capability_matches_initial: new Headers(init.headers).get('authorization') === `Bearer ${options.token}` };
    requests.push(request);
    try {
      const response = await nativeFetch(input, init);
      const raw = await response.clone().text();
      request.status = response.status; request.response_bytes = Buffer.byteLength(raw); request.response_sha256 = hash(raw);
      let parsed: any;
      try { parsed = JSON.parse(raw); } catch { /* validator owns malformed transport */ }
      if (url.pathname.endsWith('/branch') && response.ok) {
        const refs = new Set<string>();
        for (const branch of parsed?.branches ?? []) for (const item of branch.items ?? []) {
          if (poolRef(item.ref)) observed.add(item.ref);
          if (item?.source === 'agent_memory' && item?.kind === 'source_reference' && poolRef(item.ref)) refs.add(item.ref);
        }
        branchCandidatePools.push({ queryText: typeof body.query_text === 'string' ? body.query_text : '', refs });
      }
      if (url.pathname.endsWith('/source/read') && response.ok && parsed?.projection?.Document) successfulReads.set(body.projection_ref, parsed);
      return response;
    } catch (error: any) { request.error_class = error?.name ?? 'transport_error'; throw error; }
  }) as typeof fetch;
  const branchCalls: any[] = [];
  const delivered = new Map<string, any>();
  const navigable = new Map<string, any>();
  const attemptedReads = new Set<string>();
  let searched = false;
  let selectedKeyword = '';
  let assertionRead = false;
  let sequenceIndex = 0;
  const tool = (name: string, args: any, index: number) => ({ content: null,
    toolCalls: [{ id: `f-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
  const branchAI = {
    isToolCallingSupported: () => true,
    async chat(messages: any[], tools: any[] = []) {
      const snapshot = clone(messages);
      for (const entry of visibleNavigableExpansions(snapshot)) navigable.set(entry.ref, entry.semantic_view);
      const views = visibleExpansions(snapshot);
      for (const entry of views) delivered.set(entry.ref, entry.semantic_view);
      const processedClosures = new Set<string>();
      for (const object of [...messageObjects(snapshot), ...decodedToolResultObjects(snapshot)]) {
        if (!poolRef(object.ref) || object.status !== 'complete' || object.content_trust !== 'derived_assertion_closure'
          || !object.closure || typeof object.closure !== 'object') continue;
        const closureJSON = JSON.stringify(object.closure);
        if (processedClosures.has(closureJSON)) continue;
        processedClosures.add(closureJSON);
        const prior = delivered.get(object.ref);
        if (prior?.aggregate?.contract === 'result_synthesis_delta/v1') {
          const priorClosures = Array.isArray(prior.assertion_closures) ? prior.assertion_closures : [];
          if (!priorClosures.some((closure: any) => JSON.stringify(closure) === closureJSON)) {
            delivered.set(object.ref, { ...prior, assertion_closures: [...priorClosures, object.closure] });
          }
        } else {
          delivered.set(object.ref, { schema_version: 1, content_trust: 'derived_assertion_closure',
            projection_ref: object.ref, ...object.closure });
        }
      }
      branchCalls.push({ messages: snapshot, tools: tools.map(t => t.name) });
      const index = branchCalls.length;
      if (index > 10) return tool('finish_memory_search', { summary: 'Bounded test stopped.', evidence: [], inject: false }, index);
      if (options.forceSearch && !searched && tools.some(t => t.name === 'memory_remote_search')) {
        searched = true;
        selectedKeyword = options.keyword;
        return tool('memory_remote_search', { keywords: [options.keyword] }, index);
      }
      const objects = messageObjects(snapshot);
      const candidates = objects.flatMap(object => recordsIn(object, 'items').flat()).filter(item => item?.kind === 'source_reference' && poolRef(item.ref));
      const latestLiteralPool = [...branchCandidatePools].reverse().find(pool => pool.queryText.trim().length > 0);
      const selectedCandidates = options.forceSearch && searched && latestLiteralPool
        ? candidates.filter(candidate => latestLiteralPool.refs.has(candidate.ref))
        : candidates;
      if (options.readSequence && sequenceIndex < options.readSequence.length) {
        const action = options.readSequence[sequenceIndex];
        if (action === 'projection') {
          const candidate = selectedCandidates.find(c => !attemptedReads.has(c.ref));
          if (candidate && tools.some(t => t.name === 'memory_source_read')) {
            sequenceIndex++; attemptedReads.add(candidate.ref); options.beforeSourceRead?.(options.root);
            return tool('memory_source_read', { ref: candidate.ref }, index);
          }
        } else if (tools.some(t => t.name === 'memory_assertion_read')) {
          const deltaAuthored = options.assertionMode === 'delta_authored';
          const candidateViews = deltaAuthored ? visibleExpansions(snapshot) : visibleNavigableExpansions(snapshot);
          const candidate = selectedCandidates.find(c => candidateViews.some(view => view.ref === c.ref
            && (deltaAuthored ? view.semantic_view?.aggregate?.contract === 'result_synthesis_delta/v1' : true)));
          const semanticView = candidate && candidateViews.find(view => view.ref === candidate.ref)?.semantic_view;
          const aggregate = semanticView?.aggregate;
          if (candidate && aggregate) {
            sequenceIndex++; assertionRead = true;
            return tool('memory_assertion_read', { ref: candidate.ref,
              member_ref: aggregate.leaves?.[0]?.leaf_ref ?? candidate.ref, node_id: 'a'.repeat(64) }, index);
          }
        }
      }
      if (options.readAssertion && !assertionRead && tools.some(t => t.name === 'memory_assertion_read')) {
        const deltaAuthored = options.assertionMode === 'delta_authored';
        const candidateViews = deltaAuthored ? visibleExpansions(snapshot) : visibleNavigableExpansions(snapshot);
        const candidate = selectedCandidates.find(c => candidateViews.some(view => view.ref === c.ref
          && (deltaAuthored ? view.semantic_view?.aggregate?.contract === 'result_synthesis_delta/v1' : true)));
        const expansion = candidate && candidateViews.find(view => view.ref === candidate.ref);
        const semanticView = expansion?.semantic_view;
        const aggregate = semanticView?.aggregate;
        const isDelta = aggregate?.contract === 'result_synthesis_delta/v1';
        const assertion = Array.isArray(semanticView?.nodes)
          ? semanticView.nodes.find((node: any) => node?.kind === 'assertion' && typeof node.id === 'string' && /^[a-f0-9]{64}$/.test(node.id)) : undefined;
        if (candidate && semanticView && (!deltaAuthored || isDelta) && (!deltaAuthored || assertion)) {
          assertionRead = true;
          const memberRef = deltaAuthored ? candidate.ref : aggregate?.leaves?.[0]?.leaf_ref ?? candidate.ref;
          const nodeId = assertion?.id ?? 'a'.repeat(64);
          return tool('memory_assertion_read', { ref: candidate.ref, member_ref: memberRef, node_id: nodeId }, index);
        }
      }
      if (delivered.size === 0 || options.readAll) {
        const candidate = selectedCandidates.find(c => !attemptedReads.has(c.ref));
        if (candidate && tools.some(t => t.name === 'memory_source_read')) {
          attemptedReads.add(candidate.ref);
          options.beforeSourceRead?.(options.root);
          return tool('memory_source_read', { ref: candidate.ref }, index);
        }
        if (delivered.size === 0 && !searched && tools.some(t => t.name === 'memory_remote_search')) {
          searched = true; selectedKeyword = options.keyword;
          return tool('memory_remote_search', { keywords: [options.keyword] }, index);
        }
      }
      const evidence = options.finishRef ? [options.finishRef]
        : options.citeUndelivered ? candidates.slice(0, 1).map(c => c.ref)
        : [...delivered.keys()].slice(0, 1);
      return tool('finish_memory_search', { summary: 'Synthetic mechanism inspection completed.', evidence, inject: evidence.length > 0 }, index);
    },
  };
  const queue = new actual.InMemorySyntheticObservationQueue();
  let observations: any[] = [];
  const mainCalls: any[][] = [];
  let mainResponse = '';
  try {
    const handle = actual.startMemorySidecarBranch({ sessionKey: 'independent-projection-e2e', input: options.question,
      recentMessages: [], workingDirectory: options.root, aiService: branchAI, queue, signal: options.signal, logEnabled: false,
      catslogMemory: options.injectedBackend?.(provider) ?? provider });
    if (options.cancelAtRead) await Promise.race([options.cancelAtRead.then(() => handle.cancel()), handle.done]);
    await handle.done;
    observations = queue.drain();
    const mainAI = { isToolCallingSupported: () => true, async chat(messages: any[]) {
      mainCalls.push(clone(messages));
      const retained = messageObjects(messages).flatMap(o => o.retained_remote_evidence ?? []);
      mainResponse = retained.map(entry => String(entry.ref)).join(' ');
      return { content: mainResponse || 'No retained remote evidence.', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    } };
    let drained = false;
    const mainRunner = new actual.ConversationRunner(mainAI, new actual.AgentToolExecutor([], options.root), {
      stream: false, maxTurns: 1,
      syntheticObservationProvider: () => { if (drained) return []; drained = true; return observations; },
    });
    await mainRunner.run([{ role: 'system', content: 'Inspect supplied untrusted memory evidence.' }, { role: 'user', content: options.question }]);
  } finally { globalThis.fetch = nativeFetch; }
  const retained = observations.flatMap(o => { try { return JSON.parse(o.formattedContent).retained_remote_evidence ?? []; } catch { return []; } });
  const cited = retained.filter(entry => mainResponse.includes(entry.ref)).map(entry => entry.ref);
  const summarize = (messages: any[]) => {
    const raw = JSON.stringify(messages);
    const expansions = visibleExpansions(messages);
    const injected = messageObjects(messages).flatMap(o => o.retained_remote_evidence ?? []);
    return { input_bytes: Buffer.byteLength(raw), input_sha256: hash(raw), evidence: [...expansions, ...injected].map(e => ({
      ref: e.ref, bytes: Buffer.byteLength(JSON.stringify(e.semantic_view)), sha256: hash(JSON.stringify(e.semantic_view)),
    })) };
  };
  return { requests, successfulReads, observed: [...observed], delivered, navigable, deliveredFromLiteralQuery: latestLiteralCandidateRefs(branchCandidatePools), retained, cited, observations, branchCalls, mainCalls, mainResponse, selectedKeyword,
    branchToolResults: branchCalls.map(call => summarizeToolResults(call.messages)),
    measurements: { branch_requests: branchCalls.map(c => summarize(c.messages)), main_requests: mainCalls.map(summarize) } };
}

function latestLiteralCandidateRefs(pools: Array<{ queryText: string; refs: Set<string> }>): string[] {
  const pool = [...pools].reverse().find(candidatePool => candidatePool.queryText.trim().length > 0);
  return pool ? [...pool.refs] : [];
}

function decodeGapTable(aggregate: any) {
  if (aggregate.gap_encoding !== 'synthesis-gap-table/v1' || !aggregate.gap_table) return undefined;
  return aggregate.gap_table.ranges.map(([first_page, last_page, reason]: number[]) => ({
    first_page, last_page, status: aggregate.gap_table.reasons[reason],
  }));
}
export function assertPositiveFlow(run: Awaited<ReturnType<typeof runActualFlow>>, question: string, expectedRef?: string) {
  assert.ok(run.requests.some(r => r.path.endsWith('/branch')), 'active MemorySearchBranchSession never called /branch');
  const reads = run.requests.filter(r => r.path.endsWith('/source/read') && JSON.stringify(r.body_keys) === '["projection_ref"]');
  assert.ok(reads.length > 0, 'no actual source/read expansion');
  for (const read of reads) {
    assert.equal(read.method, 'POST'); assert.deepEqual(read.body_keys, ['projection_ref']);
    assert.ok(poolRef(read.projection_ref), 'unsafe source ref'); assert.ok(run.observed.includes(read.projection_ref), 'read of a ref never observed on branch wire');
  }
  assert.ok(run.delivered.size > 0, 'metadata alone reached branch AI; no expanded view');
  assert.equal(run.observations.length, 1, 'finish failed to publish exactly one observation');
  assert.ok(run.retained.length > 0, 'main formattedContent lost retained whole view');
  assert.equal(run.mainCalls.length, 1, 'main model not called');
  assert.ok(JSON.stringify(run.branchCalls[0].messages).includes(question), 'natural question replaced by keyword');
  for (const entry of run.retained) {
    assert.ok(run.observed.includes(entry.ref)); assert.ok(run.delivered.has(entry.ref));
    const read = run.successfulReads.get(entry.ref);
    assert.ok(read?.projection?.Document, 'retained view has no successful real Go envelope');
    assertWhole(run.delivered.get(entry.ref), read.projection.Document);
    assert.deepEqual(entry.semantic_view, run.delivered.get(entry.ref), 'retention changed semantic view');
    const mainEntry = messageObjects(run.mainCalls[0]).flatMap(o => o.retained_remote_evidence ?? []).find(e => e.ref === entry.ref);
    assert.deepEqual(mainEntry?.semantic_view, entry.semantic_view, 'main actual input lost/changed retained view');
    if (expectedRef) assert.equal(entry.ref, expectedRef);
  }
  assert.ok(run.cited.length > 0, 'main fake output cited no supplied ref');
  for (const ref of run.cited) assert.ok(run.observed.includes(ref) && run.delivered.has(ref));
  const visible = JSON.stringify([...run.branchCalls.map(c => c.messages), ...run.mainCalls]);
  for (const response of run.successfulReads.values()) {
    for (const source of response.sources ?? []) {
      const sourceKind = source?.anchor?.kind;
      const sourceRole = source?.role;
      if (['derived_memory_projection', 'derived_membership_index'].includes(sourceKind)
        || ['derived_memory_projection', 'derived_membership_index'].includes(sourceRole)) continue;
      if (typeof source.text === 'string' && source.text.length > 256) assert.ok(!visible.includes(source.text), 'raw source proof page injected whole');
    }
    for (const key of ['PrincipalID', 'MemoryScopeID']) {
      const privateId = response.projection?.[key];
      if (typeof privateId === 'string' && privateId.length > 8) assert.ok(!visible.includes(privateId), `private ${key} leaked`);
    }
  }
  assert.ok(!visible.includes('RAW_SOURCE_PAGE_REPROOF_ONLY_SENTINEL'), 'raw source page injected');
  assert.ok(!visible.includes('private-principal-sentinel') && !visible.includes('private-scope-sentinel'), 'private identity leaked');
}

export function assertDeltaAssertionFlow(
  run: Awaited<ReturnType<typeof runActualFlow>>,
  question: string,
  expectedRootRef: string,
  onStage: (stage: string) => void = () => {},
) {
  onStage('branch_request_protocol');
  const branch = run.requests.filter(r => r.path.endsWith('/branch'));
  const reads = run.requests.filter(r => r.path.endsWith('/source/read'));
  assert.equal(branch.length, 2, 'normal empty + unique literal branch discovery expected');
  assert.equal(branch[0].query_text, '');
  assert.equal(branch[1].query_text, run.selectedKeyword);
  assert.ok(Array.from(branch[1].query_text ?? '').length > 0 && Array.from(branch[1].query_text ?? '').length <= 64,
    'Delta root was not discovered with one bounded literal query');
  onStage('source_read_protocol');
  assert.equal(reads.length, 2, 'one projection and one assertion-closure HTTP read expected');
  assert.deepEqual(reads[0].body_keys, ['projection_ref']);
  assert.equal(reads[1].method, 'POST');
  assert.deepEqual(reads[1].body_keys.slice().sort(), ['assertion', 'projection_ref']);
  assert.deepEqual(reads[1].assertion_body_keys, ['max_bytes', 'max_nodes', 'member_ref', 'node_id']);
  assert.equal(reads[1].assertion_member_is_projection_root, true, 'Delta-owned assertion must bind member_ref to root');
  assert.equal(reads[1].assertion_max_bytes, 12 * 1024);
  assert.equal(reads[1].assertion_max_nodes, 16);
  assert.match(reads[1].assertion_node_id_sha256, /^[a-f0-9]{64}$/);
  assert.ok(run.requests.every(r => r.status === 200 && r.capability_matches_initial), 'HTTP status/capability mismatch');
  assert.equal(run.requests.filter(r => r.path.endsWith('/bootstrap')).length, 0, 'bootstrap forbidden');
  onStage('query_candidate_and_capability');
  assert.ok(run.observed.includes(expectedRootRef), 'Delta root was not normally observed');
  assert.ok(run.deliveredFromLiteralQuery.includes(expectedRootRef), 'Delta root was absent from the latest literal-query response');
  assert.ok(run.delivered.has(expectedRootRef), 'Delta closure did not reach branch model messages');
  assert.equal(run.retained.length, 1); assert.equal(run.retained[0].ref, expectedRootRef);
  assert.deepEqual(run.cited, [expectedRootRef]);
  assert.equal(run.observations.length, 1); assert.equal(run.mainCalls.length, 1);
  assert.ok(JSON.stringify(run.branchCalls[0].messages).includes(question), 'natural question replaced by a keyword');
  onStage('delivered_delta_contract');
  const read = run.successfulReads.get(expectedRootRef);
  const doc = read?.projection?.Document;
  onStage('delta_source_read_document');
  assert.ok(doc && doc.transform_contract === 'result_synthesis_delta/v1', 'real Go read was not a Delta projection');
  assert.equal(read.content_trust, 'derived_memory_projection');
  onStage('authored_node_locator');
  const baseAssertion = doc.nodes?.find((node: any) => node.kind === 'assertion');
  assert.ok(baseAssertion && reads[1].assertion_node_id_sha256 === hash(baseAssertion.id), 'assertion node was not selected from delivered Delta semantics');
  const view = run.delivered.get(expectedRootRef);
  onStage('delta_semantic_view_contract');
  assert.equal(view.transform_contract, 'result_synthesis_delta/v1');
  assert.equal(view.aggregate?.contract, 'result_synthesis_delta/v1');
  assert.equal(view.content_trust, 'derived_memory_projection');
  const baseView = { ...view }; delete baseView.assertion_closures;
  onStage('whole_delta_projection');
  assertWhole(baseView, doc, stage => onStage(`delta_${stage}`));
  onStage('assertion_closure_count');
  assert.equal(view.assertion_closures?.length, 1);
  onStage('complete_closure_shape');
  const closure = view.assertion_closures[0];
  assert.equal(closure.status, 'complete'); assert.equal(closure.read_required, false);
  assert.equal(closure.content_trust, 'derived_assertion_closure');
  assert.equal(closure.source_completeness, 'not_asserted');
  assert.equal(closure.projection_ref, expectedRootRef); assert.equal(closure.member_ref, expectedRootRef);
  assert.equal(closure.assertion.id, baseAssertion.id);
  assert.deepEqual(run.retained[0].semantic_view, view);
  onStage('main_input_injection');
  const formattedObservation = run.mainCalls[0].find((message: any) => message.role === 'tool' && message.name === 'runtime_observation');
  onStage('main_formatted_observation_presence');
  assert.ok(formattedObservation && typeof formattedObservation.content === 'string');
  const formattedObject = JSON.parse(formattedObservation.content);
  const formattedEntry = formattedObject.retained_remote_evidence?.find((entry: any) => entry.ref === expectedRootRef);
  onStage('main_formatted_delta_closure_presence');
  assert.ok(formattedEntry?.semantic_view?.aggregate?.contract === 'result_synthesis_delta/v1'
    && formattedEntry.semantic_view.assertion_closures?.length === 1);
  const mainEntry = messageObjects(run.mainCalls[0]).flatMap(object => object.retained_remote_evidence ?? []).find(entry => entry.ref === expectedRootRef);
  onStage('main_input_entry_presence');
  assert.ok(mainEntry, 'main input omitted the retained Delta root');
  onStage('main_input_delta_contract');
  assert.equal(mainEntry.semantic_view?.aggregate?.contract, 'result_synthesis_delta/v1');
  onStage('main_input_closure_count');
  assert.equal(mainEntry.semantic_view?.assertion_closures?.length, 1);
  onStage('main_input_closure_match');
  onStage('main_input_top_level_keys');
  assert.deepEqual(Object.keys(mainEntry.semantic_view).sort(), Object.keys(view).sort());
  onStage('main_input_document');
  assert.deepEqual(mainEntry.semantic_view.Document, view.Document);
  onStage('main_input_aggregate');
  assert.deepEqual(mainEntry.semantic_view.aggregate, view.aggregate);
  onStage('main_input_nodes');
  assert.deepEqual(mainEntry.semantic_view.nodes, view.nodes);
  onStage('main_input_mappings');
  assert.deepEqual(mainEntry.semantic_view.mappings, view.mappings);
  onStage('main_input_whole_delta');
  assertWhole(mainEntry.semantic_view, doc);
  onStage('main_input_closures');
  const expectedClosure = view.assertion_closures[0];
  const actualClosure = mainEntry.semantic_view.assertion_closures[0];
  onStage('main_input_closure_keys');
  assert.deepEqual(Object.keys(actualClosure).sort(), Object.keys(expectedClosure).sort());
  for (const field of ['status', 'read_required', 'content_trust', 'source_completeness', 'projection_ref', 'member_ref',
    'covered_ranges', 'assertion', 'entries', 'relations', 'bytes', 'nodes']) {
    onStage(`main_input_closure_${field}`);
    onStage('main_input_closure_nodes');
    assert.deepEqual(actualClosure[field], expectedClosure[field]);
  }
  onStage('main_input_closure_all_fields');
  for (const field of Object.keys(expectedClosure)) assert.deepEqual(actualClosure[field], expectedClosure[field]);
  onStage('main_input_citation');
  assert.ok(run.mainResponse.includes(expectedRootRef), 'main output cited no supplied Delta root');
  const visible = JSON.stringify([...run.branchCalls.map(call => call.messages), ...run.mainCalls]);
  onStage('delta_source_metadata');
  assert.equal(read.sources?.length, 1, 'Delta source/read must return one derived summary, not raw proof pages');
  assert.ok(read.sources.every((source: any) => source?.anchor?.kind === 'derived_memory_projection'
    && source.role === 'derived_memory_projection' && source.text === doc.summary),
  'Delta source/read returned non-derived source material');
  onStage('main_view_source_envelope');
  for (const key of ['sources', 'PrincipalID', 'MemoryScopeID', 'source_scope', 'token', 'device_skill_token']) {
    assert.equal(recordsIn(mainEntry.semantic_view, key).length, 0, `private source envelope field ${key} reached main input`);
  }
  onStage('main_input_private_scope_key');
  assert.ok(!visible.includes('source_scope'), 'private source scope reached a model');
  onStage('main_input_private_principal');
  assert.ok(!visible.includes('private-principal-sentinel'), 'private principal reached a model');
  onStage('main_input_private_scope');
  assert.ok(!visible.includes('private-scope-sentinel'), 'private scope reached a model');
}
