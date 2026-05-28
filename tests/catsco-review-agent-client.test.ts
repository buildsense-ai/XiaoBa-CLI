import { describe, test, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { CatscoReviewAgentClient } from '../src/utils/catsco-review-agent-client';

const originalFetch = globalThis.fetch;

describe('catsco review agent client', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('sends bearer token and query params to review API', async () => {
    let capturedUrl = '';
    let capturedHeaders: any = {};
    globalThis.fetch = (async (input: any, init?: any) => {
      capturedUrl = String(input);
      capturedHeaders = init?.headers || {};
      return new Response(JSON.stringify({
        page: { limit: 7, offset: 0, count: 0 },
        failures: [],
      }), { status: 200 });
    }) as any;

    const client = new CatscoReviewAgentClient('https://logs.example.test:8000', 'review-token');
    await client.failures(7, '2026-05-20T00:00:00Z');

    const url = new URL(capturedUrl);
    assert.equal(url.origin, 'https://logs.example.test:8000');
    assert.equal(url.pathname, '/catsco/review/failures');
    assert.equal(url.searchParams.get('limit'), '7');
    assert.equal(url.searchParams.get('offset'), '0');
    assert.equal(url.searchParams.get('uploaded_from'), '2026-05-20T00:00:00Z');
    assert.equal(capturedHeaders.Authorization, 'Bearer review-token');
    assert.equal(capturedHeaders.Accept, 'application/json');
  });

  test('encodes session ids for entries and turns', async () => {
    const paths: string[] = [];
    globalThis.fetch = (async (input: any) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname.endsWith('/entries')) {
        return new Response(JSON.stringify({ page: { limit: 10, offset: 0, count: 0 }, entries: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ page: { limit: 10, offset: 0, count: 0 }, turns: [] }), { status: 200 });
    }) as any;

    const client = new CatscoReviewAgentClient('https://logs.example.test:8000', 'review-token');
    await client.entries('session/a b', 10);
    await client.turns('session/a b', 10);

    assert.equal(paths[0], '/catsco/review/sessions/session%2Fa%20b/entries');
    assert.equal(paths[1], '/catsco/review/sessions/session%2Fa%20b/turns');
  });

  test('sends target filters for sessions and top-level turns', async () => {
    const capturedUrls: string[] = [];
    globalThis.fetch = (async (input: any) => {
      capturedUrls.push(String(input));
      const url = new URL(String(input));
      return new Response(JSON.stringify({
        page: { limit: 10, offset: 0, count: 0 },
        sessions: url.pathname.endsWith('/sessions') ? [] : undefined,
        turns: url.pathname.endsWith('/turns') ? [] : undefined,
      }), { status: 200 });
    }) as any;

    const client = new CatscoReviewAgentClient('https://logs.example.test:8000', 'review-token');
    const filters = {
      userId: 'catsco_116',
      deviceId: 'device-raw',
      deviceName: '教务处电脑',
      botId: 'bot-raw',
      personId: 'person-raw',
      actorExternalUserId: 'actor-external-raw',
      actorCatscoUserId: 'actor-catsco-raw',
      actorWeixinUserId: 'actor-weixin-raw',
      actorFeishuUserId: 'actor-feishu-raw',
      userKey: 'user-a',
      deviceKey: 'device-a',
      botKey: 'bot-a',
      personKey: 'person-a',
      actorKey: 'actor-a',
      actorCatscoUserKey: 'actor-catsco-a',
      actorWeixinUserKey: 'actor-weixin-a',
      actorFeishuUserKey: 'actor-feishu-a',
      sessionId: 'session-raw',
      sessionKey: 'session-a',
      sessionType: 'chat',
      orgKey: 'school-a',
      orgType: 'school',
      userRole: 'teacher',
      deviceRole: 'office',
      channelType: 'desktop',
      workspaceKey: 'workspace-a',
    };
    await client.sessions(10, '2026-05-20T00:00:00Z', 0, '2026-05-21T00:00:00Z', filters);
    await client.reviewTurns(10, '2026-05-20T00:00:00Z', 0, '2026-05-21T00:00:00Z', filters);

    const url = new URL(capturedUrls[0]);
    const turnsUrl = new URL(capturedUrls[1]);
    assert.equal(url.pathname, '/catsco/review/sessions');
    assert.equal(turnsUrl.pathname, '/catsco/review/turns');
    assert.equal(url.searchParams.get('user_id'), 'catsco_116');
    assert.equal(url.searchParams.get('device_id'), 'device-raw');
    assert.equal(url.searchParams.get('device_name'), '教务处电脑');
    assert.equal(url.searchParams.get('bot_id'), 'bot-raw');
    assert.equal(url.searchParams.get('person_id'), 'person-raw');
    assert.equal(url.searchParams.get('actor_external_user_id'), 'actor-external-raw');
    assert.equal(url.searchParams.get('actor_catsco_user_id'), 'actor-catsco-raw');
    assert.equal(url.searchParams.get('actor_weixin_user_id'), 'actor-weixin-raw');
    assert.equal(url.searchParams.get('actor_feishu_user_id'), 'actor-feishu-raw');
    assert.equal(url.searchParams.get('user_key'), 'user-a');
    assert.equal(url.searchParams.get('device_key'), 'device-a');
    assert.equal(url.searchParams.get('bot_key'), 'bot-a');
    assert.equal(url.searchParams.get('person_key'), 'person-a');
    assert.equal(url.searchParams.get('actor_key'), 'actor-a');
    assert.equal(url.searchParams.get('actor_catsco_user_key'), 'actor-catsco-a');
    assert.equal(url.searchParams.get('actor_weixin_user_key'), 'actor-weixin-a');
    assert.equal(url.searchParams.get('actor_feishu_user_key'), 'actor-feishu-a');
    assert.equal(url.searchParams.get('session_id'), 'session-raw');
    assert.equal(url.searchParams.get('session_key'), 'session-a');
    assert.equal(url.searchParams.get('session_type'), 'chat');
    assert.equal(url.searchParams.get('org_key'), 'school-a');
    assert.equal(url.searchParams.get('org_type'), 'school');
    assert.equal(url.searchParams.get('user_role'), 'teacher');
    assert.equal(url.searchParams.get('device_role'), 'office');
    assert.equal(url.searchParams.get('channel_type'), 'desktop');
    assert.equal(url.searchParams.get('workspace_key'), 'workspace-a');
    assert.equal(turnsUrl.searchParams.get('user_id'), 'catsco_116');
    assert.equal(turnsUrl.searchParams.get('person_key'), 'person-a');
    assert.equal(turnsUrl.searchParams.get('actor_key'), 'actor-a');
    assert.equal(turnsUrl.searchParams.get('workspace_key'), 'workspace-a');
  });

  test('surfaces API error detail without leaking token', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      detail: 'not allowed Bearer catslog_review_secret at E:\\Dirty Work\\XiaoBa-CLI\\log.txt',
    }), { status: 401 })) as any;

    const client = new CatscoReviewAgentClient('https://logs.example.test:8000', 'secret-review-token');
    await assert.rejects(
      () => client.summary(),
      (error: any) => {
        assert.match(error.message, /not allowed/);
        assert.equal(error.message.includes('secret-review-token'), false);
        assert.equal(error.message.includes('catslog_review_secret'), false);
        assert.equal(error.message.includes('Dirty Work'), false);
        return true;
      },
    );
  });

  test('strips raw identifier fields from Review API responses', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      page: { limit: 10, offset: 0, count: 1 },
      turns: [{
        session_record_id: 'session-record',
        turn_record_id: 'turn-1',
        turn_no: 1,
        user_id: 'catsco_116',
        device_id: 'device-raw',
        device_name: '教务处电脑',
        session_id: 'session-raw',
        bot_id: 'bot-raw',
        person_id: 'person-raw',
        actor_external_user_id: 'actor-external-raw',
        actor_catsco_user_id: 'actor-catsco-raw',
        actor_weixin_user_id: 'actor-weixin-raw',
        actor_feishu_user_id: 'actor-feishu-raw',
        actor_id: 'actor-raw',
        raw_actor_id: 'raw-actor',
        user_key: 'user-key',
        bot_key: 'bot-key',
        person_key: 'person-key',
        actor_key: 'actor-key',
        actor_weixin_user_key: 'actor-weixin-key',
        nested: { user_id: 'catsco_117', actorWeixinUserId: 'weixin-raw', person_key: 'person-key-nested' },
      }],
    }), { status: 200 })) as any;

    const client = new CatscoReviewAgentClient('https://logs.example.test:8000', 'review-token');
    const response = await client.reviewTurns(10);
    const turn = response.turns[0] as any;
    assert.equal(turn.user_id, undefined);
    assert.equal(turn.device_id, undefined);
    assert.equal(turn.device_name, undefined);
    assert.equal(turn.session_id, undefined);
    assert.equal(turn.bot_id, undefined);
    assert.equal(turn.person_id, undefined);
    assert.equal(turn.actor_external_user_id, undefined);
    assert.equal(turn.actor_catsco_user_id, undefined);
    assert.equal(turn.actor_weixin_user_id, undefined);
    assert.equal(turn.actor_feishu_user_id, undefined);
    assert.equal(turn.actor_id, undefined);
    assert.equal(turn.raw_actor_id, undefined);
    assert.equal(turn.nested.user_id, undefined);
    assert.equal(turn.nested.actorWeixinUserId, undefined);
    assert.equal(turn.user_key, 'user-key');
    assert.equal(turn.bot_key, 'bot-key');
    assert.equal(turn.person_key, 'person-key');
    assert.equal(turn.actor_key, 'actor-key');
    assert.equal(turn.actor_weixin_user_key, 'actor-weixin-key');
    assert.equal(turn.nested.person_key, 'person-key-nested');
  });

  test('rejects successful non-json responses', async () => {
    globalThis.fetch = (async () => new Response('not json', { status: 200 })) as any;

    const client = new CatscoReviewAgentClient('https://logs.example.test:8000', 'review-token');
    await assert.rejects(() => client.summary(), /invalid JSON/);
  });

  test('retries transient failures and respects response size guard', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ detail: 'busy' }), {
          status: 503,
          headers: { 'retry-after': '0' },
        });
      }
      return new Response(JSON.stringify({
        upload_count: 0,
        parsed_upload_count: 0,
        failed_upload_count: 0,
        session_count: 0,
        turn_count: 0,
        ai_call_count: 0,
        tool_call_count: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      }), { status: 200 });
    }) as any;

    const client = new CatscoReviewAgentClient('https://logs.example.test:8000', 'review-token', {
      maxRetries: 1,
      maxResponseBytes: 1024,
    });
    await client.summary();
    assert.equal(attempts, 2);

    globalThis.fetch = (async () => new Response('x'.repeat(20), { status: 200 })) as any;
    const guardedClient = new CatscoReviewAgentClient('https://logs.example.test:8000', 'review-token', {
      maxResponseBytes: 10,
    });
    await assert.rejects(() => guardedClient.summary(), /too large/);
  });
});
