import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

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
export function visibleExpansions(messages: any[]): any[] {
  return messageObjects(messages).flatMap(object => [object, ...recordsIn(object, 'source_reference_expansions').flat()])
    .filter((entry: any) => poolRef(entry?.ref) && entry.status === 'expanded' && entry.semantic_view);
}
export function assertWhole(view: any, document: any) {
  for (const key of ['goal', 'summary', 'overall_coverage', 'gap_acknowledgement', 'conditions', 'omissions', 'nodes', 'edges']) {
    assert.deepEqual(view[key], document[key], `whole-view preservation failed: ${key}`);
  }
  if (document.aggregate) assert.deepEqual(view.aggregate?.gaps, document.aggregate.gaps, 'page gap lost');
  const semanticMappings = (document.mappings ?? []).map((mapping: any) => ({
    node_id: mapping.node_id,
    ...(poolRef(mapping.source_ref) ? { source_ref: mapping.source_ref } : {}),
    ...(typeof mapping.digest === 'string' ? { digest: mapping.digest } : {}),
    ...(typeof mapping.source_digest === 'string' ? { source_digest: mapping.source_digest } : {}),
  }));
  assert.deepEqual(view.mappings, semanticMappings, 'node/source mapping refs or digests lost');
}
export async function loadActual(targetRoot: string) {
  const imp = (file: string) => import(pathToFileURL(path.join(targetRoot, file)).href);
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
  forceSearch?: boolean; citeUndelivered?: boolean; finishRef?: string; readAll?: boolean;
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
      capability_matches_initial: new Headers(init.headers).get('authorization') === `Bearer ${options.token}` };
    requests.push(request);
    try {
      const response = await nativeFetch(input, init);
      const raw = await response.clone().text();
      request.status = response.status; request.response_bytes = Buffer.byteLength(raw); request.response_sha256 = hash(raw);
      let parsed: any;
      try { parsed = JSON.parse(raw); } catch { /* validator owns malformed transport */ }
      if (url.pathname.endsWith('/branch') && response.ok) {
        for (const branch of parsed?.branches ?? []) for (const item of branch.items ?? []) if (poolRef(item.ref)) observed.add(item.ref);
      }
      if (url.pathname.endsWith('/source/read') && response.ok && parsed?.projection?.Document) successfulReads.set(body.projection_ref, parsed);
      return response;
    } catch (error: any) { request.error_class = error?.name ?? 'transport_error'; throw error; }
  }) as typeof fetch;
  const branchCalls: any[] = [];
  const delivered = new Map<string, any>();
  const attemptedReads = new Set<string>();
  let searched = false;
  const tool = (name: string, args: any, index: number) => ({ content: null,
    toolCalls: [{ id: `f-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
  const branchAI = {
    isToolCallingSupported: () => true,
    async chat(messages: any[], tools: any[] = []) {
      const snapshot = clone(messages);
      const views = visibleExpansions(snapshot);
      for (const entry of views) delivered.set(entry.ref, entry.semantic_view);
      branchCalls.push({ messages: snapshot, tools: tools.map(t => t.name) });
      const index = branchCalls.length;
      if (index > 10) return tool('finish_memory_search', { summary: 'Bounded test stopped.', evidence: [], inject: false }, index);
      if (options.forceSearch && !searched && tools.some(t => t.name === 'memory_remote_search')) {
        searched = true;
        return tool('memory_remote_search', { keywords: [options.keyword] }, index);
      }
      const objects = messageObjects(snapshot);
      const candidates = objects.flatMap(object => recordsIn(object, 'items').flat()).filter(item => item?.kind === 'source_reference' && poolRef(item.ref));
      if (delivered.size === 0 || options.readAll) {
        const candidate = candidates.find(c => !attemptedReads.has(c.ref));
        if (candidate && tools.some(t => t.name === 'memory_source_read')) {
          attemptedReads.add(candidate.ref);
          options.beforeSourceRead?.(options.root);
          return tool('memory_source_read', { ref: candidate.ref }, index);
        }
        if (delivered.size === 0 && !searched && tools.some(t => t.name === 'memory_remote_search')) {
          searched = true; return tool('memory_remote_search', { keywords: [options.keyword] }, index);
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
  return { requests, successfulReads, observed: [...observed], delivered, retained, cited, observations, branchCalls, mainCalls, mainResponse,
    measurements: { branch_requests: branchCalls.map(c => summarize(c.messages)), main_requests: mainCalls.map(summarize) } };
}

export function assertPositiveFlow(run: Awaited<ReturnType<typeof runActualFlow>>, question: string, expectedRef?: string) {
  assert.ok(run.requests.some(r => r.path.endsWith('/branch')), 'active MemorySearchBranchSession never called /branch');
  const reads = run.requests.filter(r => r.path.endsWith('/source/read'));
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
