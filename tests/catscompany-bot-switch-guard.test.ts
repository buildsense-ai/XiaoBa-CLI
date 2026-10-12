import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  CatsCoBotSwitchGuardError,
  verifyCatsCoBotSwitchBinding,
} from '../src/catscompany/bot-switch-guard';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('CatsCo bot switch guard', () => {
  test('refuses to switch to a platform-managed cloud employee', async () => {
    const fetchImpl = (async () => jsonResponse(200, {
      bot_uid: 199,
      bound: true,
      body_id: 'cloud-official-body',
      cloud_deployed: true,
    })) as unknown as typeof fetch;

    await assert.rejects(
      verifyCatsCoBotSwitchBinding({
        token: 'token',
        botUid: '199',
        localBodyId: 'body-local',
        httpBaseUrl: 'https://app.catsco.test',
        fetchImpl,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CatsCoBotSwitchGuardError);
        assert.equal((error as CatsCoBotSwitchGuardError).code, 'BOT_CLOUD_MANAGED');
        return true;
      },
    );
  });

  test('still allows switching to an ordinary bot bound to this runtime', async () => {
    const fetchImpl = (async () => jsonResponse(200, {
      bot_uid: 199,
      bound: true,
      body_id: 'body-local',
    })) as unknown as typeof fetch;

    const verified = await verifyCatsCoBotSwitchBinding({
      token: 'token',
      botUid: '199',
      localBodyId: 'body-local',
      httpBaseUrl: 'https://app.catsco.test',
      fetchImpl,
    });

    assert.equal(verified.botUid, '199');
    assert.equal(verified.platformBodyId, 'body-local');
  });
});
