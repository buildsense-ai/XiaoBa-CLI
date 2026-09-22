import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  JevCatsCompanyGroupActivationJudge,
  resolveCatsCompanyGroupActivation,
  resolveCatsCompanyGroupActivationJevConfig,
  type CatsCompanyGroupActivationJudge,
  type CatsCompanyGroupActivationJevConfig,
} from '../src/catscompany/jev-group-activation';

const baseConfig: CatsCompanyGroupActivationJevConfig = {
  enabled: true,
  apiBase: 'https://jev.example.test',
  apiKey: 'jev-secret',
  model: 'jev-test',
  timeoutMs: 1_000,
  signalFloor: 0.6,
};

function jevResponse(
  choice: 'activate' | 'silent',
  options: { signal?: number; confidence?: number } = {},
): Response {
  return new Response(JSON.stringify({
    model: 'jev-test',
    answers: {
      has_activation_signal: {
        type: 'noul',
        noul: options.signal ?? 0.9,
      },
      activation: {
        type: 'choice',
        choice,
        confidence: options.confidence ?? 0.85,
        probabilities: {},
      },
    },
  }), { status: 200 });
}

describe('CatsCompany JEV group activation', () => {
  test('resolves explicit opt-in configuration with bounded defaults', () => {
    const config = resolveCatsCompanyGroupActivationJevConfig({
      XIAOBA_GROUP_ACTIVATION_JEV_ENABLED: 'true',
      XIAOBA_GROUP_ACTIVATION_JEV_API_KEY: 'secret',
      XIAOBA_GROUP_ACTIVATION_JEV_TIMEOUT_MS: '999999',
      XIAOBA_GROUP_ACTIVATION_JEV_SIGNAL_FLOOR: 'invalid',
    });

    assert.equal(config.enabled, true);
    assert.equal(config.apiBase, 'https://api.typesafe.ai');
    assert.equal(config.apiKey, 'secret');
    assert.equal(config.model, 'jev-1.13.0');
    assert.equal(config.timeoutMs, 2_500);
    assert.equal(config.signalFloor, 0.6);
  });

  test('sends one bounded typed choice request and decodes activation', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const judge = new JevCatsCompanyGroupActivationJudge(baseConfig, async (url, init) => {
      requestUrl = String(url);
      requestInit = init;
      return jevResponse('activate');
    });

    const result = await judge.judge({
      text: `请处理这个问题${'x'.repeat(5_000)}`,
      seq: 12,
      memberCount: 4,
      explicitlyMentioned: false,
      trustedChannelTriggered: false,
    });

    assert.deepEqual(result, { decision: 'activate', confidence: 0.85 });
    assert.equal(requestUrl, 'https://jev.example.test/v1/systemone');
    assert.equal(requestInit?.method, 'POST');
    assert.equal(new Headers(requestInit?.headers).get('authorization'), 'Bearer jev-secret');
    const body = JSON.parse(String(requestInit?.body));
    assert.equal(body.model, 'jev-test');
    assert.equal(body.questions.has_activation_signal.type, 'noul');
    assert.equal(body.questions.activation.type, 'choice');
    assert.equal(body.state[0].texts[0].text.length, 4_000);
    assert.deepEqual(JSON.parse(body.state[0].texts[1].text), {
      explicitly_mentioned: false,
      trusted_channel_triggered: false,
      member_count: 4,
    });
  });

  test('preserves abstention for weak signal or low-confidence choices', async () => {
    const weakSignal = new JevCatsCompanyGroupActivationJudge(
      baseConfig,
      async () => jevResponse('activate', { signal: 0.2 }),
    );
    assert.deepEqual(await weakSignal.judge({
      text: '随口一提', explicitlyMentioned: false, trustedChannelTriggered: false,
    }), { decision: 'abstain', confidence: 0.8 });

    const weakChoice = new JevCatsCompanyGroupActivationJudge(
      baseConfig,
      async () => jevResponse('silent', { confidence: 0.4 }),
    );
    assert.deepEqual(await weakChoice.judge({
      text: '也许不用回复', explicitlyMentioned: true, trustedChannelTriggered: false,
    }), { decision: 'abstain', confidence: 0.4 });
  });

  test('lets JEV broaden or narrow native group activation', async () => {
    const activateJudge: CatsCompanyGroupActivationJudge = {
      judge: async () => ({ decision: 'activate', confidence: 0.91 }),
    };
    const broadened = await resolveCatsCompanyGroupActivation({
      topic: 'grp_80', senderId: 'usr7', text: '请继续处理', seq: 20,
      isGroup: true, mentions: [], memberCount: 4,
    }, 'usr43', false, activateJudge);
    assert.deepEqual(broadened, { activate: true, source: 'jev', confidence: 0.91 });

    const silentJudge: CatsCompanyGroupActivationJudge = {
      judge: async input => {
        assert.equal(input.explicitlyMentioned, true);
        return { decision: 'silent', confidence: 0.88 };
      },
    };
    const narrowed = await resolveCatsCompanyGroupActivation({
      topic: 'grp_80', senderId: 'usr7', text: '@AI 谢谢', seq: 21,
      isGroup: true, mentions: ['usr43'], memberCount: 4,
    }, '43', true, silentJudge);
    assert.deepEqual(narrowed, { activate: false, source: 'jev', confidence: 0.88 });
  });

  test('keeps external channel trust as a hard fence and fails back deterministically', async () => {
    let calls = 0;
    const judge: CatsCompanyGroupActivationJudge = {
      judge: async () => {
        calls += 1;
        throw new Error('offline');
      },
    };

    const fenced = await resolveCatsCompanyGroupActivation({
      topic: 'grp_80', senderId: 'usr7', text: '未触发消息', seq: 22,
      isGroup: true,
      metadata: { source_channel: 'feishu', channel_native_group_triggered: false },
    }, 'usr43', false, judge);
    assert.deepEqual(fenced, { activate: false, source: 'deterministic' });
    assert.equal(calls, 0);

    const fallback = await resolveCatsCompanyGroupActivation({
      topic: 'grp_80', senderId: 'usr7', text: '@AI 请处理', seq: 23,
      isGroup: true, mentions: ['usr43'], memberCount: 4,
    }, 'usr43', true, judge);
    assert.equal(fallback.activate, true);
    assert.equal(fallback.source, 'jev_error');
    assert.match(fallback.error?.message || '', /offline/);
  });

  test('rejects malformed typed answers instead of guessing', async () => {
    const judge = new JevCatsCompanyGroupActivationJudge(baseConfig, async () => new Response(JSON.stringify({
      answers: {
        has_activation_signal: { type: 'noul', noul: 0.9 },
        activation: { type: 'choice', choice: 'maybe', confidence: 1 },
      },
    }), { status: 200 }));

    await assert.rejects(() => judge.judge({
      text: '请处理', explicitlyMentioned: true, trustedChannelTriggered: false,
    }), /invalid activation answer/);
  });
});
