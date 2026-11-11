import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import { fetchWithRetry } from '../src/catscompany/client';
import { orderCatsCoCandidatesWithCoolOff, type CatsCoFamilyCoolOff } from '../src/utils/catsco-domains';

const APP_CC = 'https://app.catsco.cc';
const APP_CN = 'https://app.catsco.cn';

describe('domain family cool-off', () => {
  test('moves a cooling family to the back without dropping it', () => {
    const coolOff: CatsCoFamilyCoolOff = new Map([['cc', 2_000]]);
    // Both families must stay in the list: if the other one is poisoned too,
    // there still has to be a road to try.
    assert.deepEqual(
      orderCatsCoCandidatesWithCoolOff([APP_CC, APP_CN], coolOff, 1_000),
      [APP_CN, APP_CC],
    );
  });

  test('restores the original order once the cool-off expires', () => {
    const coolOff: CatsCoFamilyCoolOff = new Map([['cc', 2_000]]);
    assert.deepEqual(
      orderCatsCoCandidatesWithCoolOff([APP_CC, APP_CN], coolOff, 2_000),
      [APP_CC, APP_CN],
    );
  });

  test('leaves hosts outside the cc/cn pair where they were', () => {
    const coolOff: CatsCoFamilyCoolOff = new Map([['cc', 2_000]]);
    const custom = 'https://gateway.internal.example';
    assert.deepEqual(
      orderCatsCoCandidatesWithCoolOff([APP_CC, custom], coolOff, 1_000),
      [custom, APP_CC],
    );
  });
});

describe('fetchWithRetry domain family callbacks', () => {
  const realFetch = global.fetch;
  let calls = 0;
  let behaviour: (() => Promise<Response>)[] = [];

  beforeEach(() => {
    calls = 0;
    behaviour = [];
    (global as any).fetch = async () => {
      const step = behaviour[calls] ?? behaviour[behaviour.length - 1];
      calls += 1;
      return step();
    };
  });

  afterEach(() => {
    (global as any).fetch = realFetch;
  });

  function transportFailure(code = 'ECONNRESET'): Promise<Response> {
    const error = new TypeError('fetch failed');
    (error as any).cause = { code };
    return Promise.reject(error);
  }

  const ok = () => Promise.resolve(new Response('{}', { status: 200 }));

  test('reports the failed target, then the reachable one', async () => {
    const failed: string[] = [];
    const reachable: string[] = [];
    behaviour = [() => transportFailure(), ok];
    const response = await fetchWithRetry([APP_CC, APP_CN], {}, {
      attempts: 1,
      baseDelayMs: 1,
      onTargetFailure: target => failed.push(String(target)),
      onTargetReachable: target => reachable.push(String(target)),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(failed, [APP_CC]);
    assert.deepEqual(reachable, [APP_CN]);
  });

  test('does not report a failure when the first target answers', async () => {
    const failed: string[] = [];
    const reachable: string[] = [];
    behaviour = [ok];
    await fetchWithRetry([APP_CN, APP_CC], {}, {
      attempts: 1,
      baseDelayMs: 1,
      onTargetFailure: target => failed.push(String(target)),
      onTargetReachable: target => reachable.push(String(target)),
    });
    assert.deepEqual(failed, []);
    assert.deepEqual(reachable, [APP_CN]);
  });

  test('does not report a failure for a non-transient error it surfaces', async () => {
    const failed: string[] = [];
    const reachable: string[] = [];
    behaviour = [() => Promise.reject(new Error('CatsCompany agent context history failed: 401'))];
    await assert.rejects(
      fetchWithRetry([APP_CN, APP_CC], {}, {
        attempts: 1,
        baseDelayMs: 1,
        onTargetFailure: target => failed.push(String(target)),
        onTargetReachable: target => reachable.push(String(target)),
      }),
      /history failed: 401/,
    );
    // A 401 means the host answered; only transport failures should cool a family down.
    assert.deepEqual(failed, []);
    assert.deepEqual(reachable, []);
  });
});
