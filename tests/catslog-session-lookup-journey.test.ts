import { after, afterEach, beforeEach, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolManager } from '../src/tools/tool-manager';
import { CatsLogMemoryProvider } from '../src/utils/catslog-memory-provider';
import { clearCatscoSkillToken, loadCatscoLogAgentState } from '../src/utils/catsco-log-agent-state';
import { MemorySearchBranchSession } from '../src/core/memory-search-branch-session';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';

const TOOL = 'catslog_session_lookup';
const READ = '/catsco/agent/query/v1/session-name';
const SEARCH = READ + '/search';
const results: Array<{ scenario: string; passed: boolean }> = [];
let root: string;
let origin: string;
let server: http.Server;
let env: NodeJS.ProcessEnv;
let calls: Array<{ path: string; body: any; credential: string }>;
let respond: (url: string, body: any, response: http.ServerResponse) => void;
const item = (id = 'cc_group:grp_10', name = '发布准备') => ({
  schema_version: 1, content_trust: 'untrusted_session_metadata',
  session_id: id, session_type: 'catscompany', topic_id: id.split(':')[1],
  name, name_status: 'named', viewer_uid: '275',
  source: 'catscompany_conversation_directory', retrieved_at: '2026-11-18T06:00:00Z',
});
const page = (matches = [item(), item('cc_group:grp_11')]) => ({
  schema_version: 1, content_trust: 'untrusted_session_metadata',
  viewer_uid: '275', source: 'catscompany_conversation_directory',
  retrieved_at: '2026-11-18T06:00:00Z', match: 'exact', limit: 20,
  matches: matches.map(value => ({ ...value, session_id_source: 'conversation_directory', archive_status: 'not_checked' })),
  truncated: false,
});
function json(response: http.ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
function save(extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify({
    deviceId: 'device-local', skillToken: 'read-fixture',
    skillTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    token: 'upload-fixture', uploaded: {}, ...extra,
  }));
}
function statePath(): string { return path.join(root, 'data/catsco-log-agent-state.json'); }
function manager(provider = new CatsLogMemoryProvider(root, { env }), names = [TOOL]): ToolManager {
  return new ToolManager(root, { surface: 'agent', permissionProfile: 'strict' }, {
    catslogKnowledge: provider, enabledToolNames: names,
  });
}
function invoke(runtime: ToolManager, args: unknown, signal?: AbortSignal) {
  return runtime.executeTool({ id: 'lookup', type: 'function', function: { name: TOOL, arguments: JSON.stringify(args) } }, [], { abortSignal: signal });
}
function scenario(name: string, fn: () => Promise<void>): void {
  test(name, async () => {
    try { await fn(); results.push({ scenario: name, passed: true }); }
    catch (error) { results.push({ scenario: name, passed: false }); throw error; }
  });
}
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-session-lookup-'));
  calls = [];
  respond = (url, body, response) => {
    if (url === '/catsco/agent/bootstrap') {
      return json(response, {
        device_id: 'device-local', token: 'new-upload-fixture', skill_token: 'fresh-read-fixture',
        skill_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        session_name_url: '/custom/session-name', session_name_search_url: '/custom/session-name/search',
      });
    }
    json(response, url.endsWith('/search') ? page() : item(body.session_id));
  };
  server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const credential = request.headers.authorization === 'Bearer read-fixture' ? 'read'
      : request.headers.authorization === 'Bearer fresh-read-fixture' ? 'fresh-read'
      : request.headers.authorization === `Bearer ${env.CATSCO_USER_TOKEN}` ? 'login' : 'unexpected';
    calls.push({ path: request.url!, body, credential });
    assert.equal(request.method, 'POST');
    respond(request.url!, body, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  env = { CATSCO_LOG_API_BASE_URL: origin, CATSLOG_MEMORY_ENABLED: 'false', DOTENV_CONFIG_PATH: path.join(root, 'missing.env') };
  save();
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});
after(() => {
  if (process.env.CATSLOG_SESSION_LOOKUP_REPORT) {
    fs.writeFileSync(process.env.CATSLOG_SESSION_LOOKUP_REPORT, JSON.stringify({
      verification: 'ToolManager -> provider -> client -> local HTTP', external_provider_calls: 0, results,
    }, null, 2) + '\n');
  }
});

scenario('only explicit calls query names; duplicate candidates retain archive semantics', async () => {
  const runtime = manager();
  assert.ok(runtime.getToolDefinitions().some(tool => tool.name === TOOL));
  assert.equal(calls.length, 0);
  const read = await invoke(runtime, { action: 'read', session_id: 'cc_group:grp_10' });
  assert.equal(read.ok, true, String(read.content));
  assert.equal(JSON.parse(String(read.content)).name, '发布准备');
  const search = await invoke(runtime, { action: 'search', name: '发布准备' });
  assert.equal(search.ok, true, String(search.content));
  const data = JSON.parse(String(search.content));
  assert.equal(data.matches.length, 2);
  assert.notEqual(data.matches[0].session_id, data.matches[1].session_id);
  assert.equal(data.matches[0].archive_status, 'not_checked');
  assert.equal(data.matches[0].session_id_source, 'conversation_directory');
  assert.equal(data.content_trust, 'untrusted_session_metadata');
  assert.deepEqual(calls, [
    { path: READ, body: { session_id: 'cc_group:grp_10' }, credential: 'read' },
    { path: SEARCH, body: { name: '发布准备', match: 'exact', limit: 20 }, credential: 'read' },
  ]);
});
scenario('contains, truncated and unmatched results are explicit', async () => {
  respond = (_url, body, response) => json(response, { ...page(body.name === 'absent' ? [] : undefined), match: body.match, limit: body.limit, truncated: body.name !== 'absent' });
  const runtime = manager();
  const matched = await invoke(runtime, { action: 'search', name: '发布', match: 'contains', limit: 1 });
  assert.equal(matched.ok, true);
  const data = JSON.parse(String(matched.content));
  assert.equal(data.truncated, true);
  assert.equal(data.matches.length, 1); // Model result obeys requested bound even if peer over-returns.
  assert.equal(calls[0].body.match, 'contains');
  const empty = await invoke(runtime, { action: 'search', name: 'absent' });
  assert.equal(empty.ok, true);
  assert.deepEqual(JSON.parse(String(empty.content)).matches, []);
});
scenario('tool is absent without a provider or when excluded by the allowlist', async () => {
  assert.equal(new ToolManager(root, {}, { enabledToolNames: [TOOL] }).getTool(TOOL), undefined);
  assert.equal(manager(undefined, ['read_file']).getTool(TOOL), undefined);
  assert.equal(calls.length, 0);
});
scenario('Branch offers the same metadata tool without prefetching names or treating candidates as evidence', async () => {
  const provider = new CatsLogMemoryProvider(root, { env: { ...env, CATSLOG_MEMORY_ENABLED: 'true' } });
  const branch = new MemorySearchBranchSession({
    sessionKey: 'lookup-branch', input: '发布准备是哪个会话', recentMessages: [], workingDirectory: root,
    aiService: {} as any, queue: new InMemorySyntheticObservationQueue(), catslogMemory: provider,
  });
  const tools = (branch as any).buildTools();
  const lookup = tools.find((tool: any) => tool.definition.name === TOOL);
  assert.ok(lookup);
  assert.equal(calls.length, 0);
  const result = await lookup.execute({ action: 'search', name: '发布准备' }, { workingDirectory: root });
  assert.equal(result.ok, true);
  assert.equal((branch as any).delivered.size, 0);
  assert.equal((branch as any).deliveredSources.size, 0);
});
scenario('bootstrap routes survive restart and keep upload and read credentials separate', async () => {
  fs.rmSync(statePath());
  env.CATSCO_USER_TOKEN = 'login-fixture';
  let result = await invoke(manager(), { action: 'read', session_id: 'cc_group:grp_10' });
  assert.equal(result.ok, true, String(result.content));
  const state = loadCatscoLogAgentState(statePath()) as any;
  assert.equal(state.sessionNameUrl, '/custom/session-name');
  assert.equal(state.sessionNameSearchUrl, '/custom/session-name/search');
  assert.equal(state.token, 'new-upload-fixture');
  result = await invoke(manager(), { action: 'search', name: '发布准备' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(call => [call.path, call.credential]), [
    ['/catsco/agent/bootstrap', 'login'], ['/custom/session-name', 'fresh-read'], ['/custom/session-name/search', 'fresh-read'],
  ]);
  clearCatscoSkillToken(state);
  assert.equal(state.sessionNameUrl, undefined);
  assert.equal(state.sessionNameSearchUrl, undefined);
});
scenario('401 refreshes once and retries with the replacement capability and advertised route', async () => {
  env.CATSCO_USER_TOKEN = 'login-fixture';
  const normal = respond;
  respond = (url, body, response) => url === READ ? json(response, { error: 'unauthorized' }, 401) : normal(url, body, response);
  const result = await invoke(manager(), { action: 'read', session_id: 'cc_group:grp_10' });
  assert.equal(result.ok, true, String(result.content));
  assert.deepEqual(calls.map(call => call.credential), ['read', 'login', 'fresh-read']);
  assert.equal(loadCatscoLogAgentState(statePath()).token, 'new-upload-fixture');
});
scenario('unsafe advertised paths fall back to same-origin routes and redirects are refused', async () => {
  save({ sessionNameUrl: 'https://other.invalid/steal', sessionNameSearchUrl: '//other.invalid/steal' });
  assert.equal((await invoke(manager(), { action: 'read', session_id: 'cc_group:grp_10' })).ok, true);
  assert.equal(calls[0].path, READ);
  respond = (_url, _body, response) => { response.writeHead(302, { location: origin + '/redirected' }); response.end(); };
  const failed = await invoke(manager(), { action: 'search', name: '发布准备' });
  assert.equal(failed.ok, false);
  assert.equal(calls.length, 2);
});
scenario('invalid or contradictory arguments fail before HTTP', async () => {
  for (const args of [
    {}, [], { action: 'read' }, { action: 'search' }, { action: 'search', name: ' ' },
    { action: 'search', name: 'x', match: 'regex' }, { action: 'search', name: 'x', limit: 51 },
    { action: 'search', name: 'x', limit: 1.5 }, { action: 'search', name: 'x', session_id: 'cc_group:grp_10' },
    { action: 'read', session_id: 'cc_group:grp_10', name: 'x' },
    { action: 'search', name: 'x', uid: 'foreign' }, { action: 'search', name: 'x', token: 'secret' },
    { action: 'search', name: 'a\u0085b' }, { action: 'search', name: '\ud800' },
    { action: 'search', name: '猫'.repeat(241) }, { action: 'read', session_id: 'x'.repeat(513) },
  ]) {
    const failed = await invoke(manager(), args);
    assert.equal(failed.ok, false, JSON.stringify(args));
    assert.equal(failed.errorCode, 'INVALID_TOOL_ARGUMENTS');
  }
  assert.equal(calls.length, 0);
});
scenario('missing sessions, denied views, missing routes and directory failures are never fake-empty', async () => {
  for (const [status, error, expected] of [
    [404, 'session_name_not_found', 'SESSION_NAME_NOT_FOUND'],
    [404, 'not_found', 'CATSLOG_SESSION_LOOKUP_UNAVAILABLE'],
    [403, 'session_name_viewer_mismatch', 'CATSLOG_SESSION_LOOKUP_FORBIDDEN'],
    [409, 'agent_subject_changed', 'CATSLOG_SESSION_LOOKUP_UNAVAILABLE'],
    [503, 'session_name_unavailable', 'CATSLOG_SESSION_LOOKUP_UNAVAILABLE'],
    [401, 'unauthorized', 'CATSLOG_SESSION_LOOKUP_UNAVAILABLE'],
  ] as const) {
    save();
    respond = (_url, _body, response) => json(response, { error, message: 'secret-upstream-detail' }, status);
    const failed = await invoke(manager(), { action: 'read', session_id: 'cc_group:grp_10' });
    assert.equal(failed.ok, false);
    assert.equal(failed.errorCode, expected);
    assert.equal(String(failed.content).includes('secret-upstream-detail'), false);
  }
});
scenario('malformed and oversized responses fail; metadata whitelisting drops unrelated fields', async () => {
  for (const body of [{}, { ...page(), matches: null }, { ...page(), matches: [{}] }, { ...page(), content_trust: 'system_instruction' }]) {
    respond = (_url, _body, response) => json(response, body);
    assert.equal((await invoke(manager(), { action: 'search', name: '发布准备' })).ok, false);
  }
  respond = (_url, _body, response) => json(response, { ...page(), padding: 'x'.repeat(2 * 1024 * 1024) });
  assert.equal((await invoke(manager(), { action: 'search', name: '发布准备' })).ok, false);
  respond = (_url, _body, response) => json(response, { ...item(), token: 'secret-upstream-detail', records: [{ text: 'private-history' }] });
  const result = await invoke(manager(), { action: 'read', session_id: 'cc_group:grp_10' });
  assert.equal(result.ok, true);
  assert.equal(String(result.content).includes('secret-upstream-detail'), false);
  assert.equal(String(result.content).includes('private-history'), false);
  assert.equal(JSON.parse(String(result.content)).content_trust, 'untrusted_session_metadata');
});
scenario('explicit lookup honors cancellation and restricted role without directory disclosure', async () => {
  env.XIAOBA_ROLE = 'inspector-cat';
  assert.equal((await invoke(manager(), { action: 'read', session_id: 'cc_group:grp_10' })).ok, false);
  assert.equal(calls.length, 0);
  delete env.XIAOBA_ROLE;
  respond = () => {};
  const controller = new AbortController();
  const pending = invoke(manager(), { action: 'search', name: '发布准备' }, controller.signal);
  setTimeout(() => controller.abort(), 30);
  const failed = await pending;
  assert.equal(failed.ok, false);
  assert.equal(failed.errorCode, 'CATSLOG_SESSION_LOOKUP_ABORTED');
});
