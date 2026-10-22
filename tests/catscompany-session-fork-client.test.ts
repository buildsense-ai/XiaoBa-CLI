import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CatsClient } from '../src/catscompany/client';

const control = { request_id: 'r1', source_topic_id: 'p2p_7_9', target_topic_id: 'grp_22',
  actor_user_id: 7, agent_uid: 9, source_last_seq: 12, message_id_map: { '12': 103 } };
const status = { request_id: 'r1', source_topic_id: 'p2p_7_9', target_topic_id: 'grp_22', state: 'ready' };
const config = { serverUrl: 'ws://127.0.0.1:1', httpBaseUrl: 'http://127.0.0.1:1', apiKey: 'test-key', bodyId: 'test-body' };

test('session_fork control emits a typed non-chat event and never emits ordinary input', () => {
  const client = new CatsClient(config);
  const events: unknown[] = [];
  client.on('session_fork', value => events.push(value));
  client.on('message', () => assert.fail('fork was delivered as chat'));
  (client as any).handleMessage({ session_fork: control });
  assert.equal(events.length, 1);
  assert.equal((events[0] as any).agent_uid, 'usr9');
  (client as any).handleMessage({ session_fork: { ...control, message_id_map: { bad: 9 } } });
  assert.equal(events.length, 1);
});

test('completion uses bot auth/body identity and validates the acknowledged target and request', async t => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    requests.push({ url: String(url), init });
    return Response.json(status);
  });
  const client = new CatsClient(config);
  const payload = { request_id: 'r1', target_topic_id: 'grp_22', state: 'ready' as const };
  assert.deepEqual(await client.completeSessionFork(payload), status);
  assert.equal(requests[0].url, 'http://127.0.0.1:1/api/bot/session-forks/complete');
  assert.equal((requests[0].init.headers as any).Authorization, 'ApiKey test-key');
  assert.equal((requests[0].init.headers as any)['X-CatsCo-Body-ID'], 'test-body');
  assert.deepEqual(JSON.parse(requests[0].init.body as string), payload);
  assert.ok(requests[0].init.signal);
});

test('only an explicit scoped not-found response authorizes cloud restore', async t => {
  let response = Response.json({ error: 'session_fork_not_found' }, { status: 404 });
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    assert.equal(url.pathname, '/api/bot/session-forks');
    assert.equal(url.searchParams.get('topic_id'), 'grp_22');
    return response;
  });
  const client = new CatsClient(config);
  assert.equal(await client.getSessionFork('grp_22'), undefined);
  for (const invalid of [
    Response.json({ error: 'not found' }, { status: 404 }),
    new Response('route missing', { status: 404 }),
    Response.json({ error: 'session_fork_not_found' }, { status: 403 }),
    Response.json({ error: 'unavailable' }, { status: 503 }),
    Response.json(null), Response.json({}), Response.json({ ...status, target_topic_id: 'grp_999' }),
  ]) {
    response = invalid;
    await assert.rejects(client.getSessionFork('grp_22'));
  }
});

test('provenance returns pending and failed records, not absence', async t => {
  let state = 'pending';
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ...status, state }));
  const client = new CatsClient(config);
  assert.equal((await client.getSessionFork('grp_22'))?.state, 'pending');
  state = 'failed';
  assert.equal((await client.getSessionFork('grp_22'))?.state, 'failed');
});

test('completion rejects mismatched request or response state without retrying another payload', async t => {
  let response = { ...status, request_id: 'wrong' };
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(response); });
  const client = new CatsClient(config);
  await assert.rejects(client.completeSessionFork({ request_id: 'r1', target_topic_id: 'grp_22', state: 'ready' }), /mismatch/);
  response = { ...status, state: 'unknown' };
  await assert.rejects(client.completeSessionFork({ request_id: 'r1', target_topic_id: 'grp_22', state: 'ready' }), /invalid/);
  assert.equal(calls, 2);
});

test('terminal failed completion response is retained, not reopened', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ...status, state: 'failed', error: 'source_changed_retry_needed' }));
  const result = await new CatsClient(config).completeSessionFork({ request_id: 'r1', target_topic_id: 'grp_22', state: 'ready' });
  assert.equal(result.state, 'failed');
  assert.equal(result.error, 'source_changed_retry_needed');
});
