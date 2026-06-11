import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WeixinBot } from '../src/weixin';

describe('weixin session expiry', () => {
  test('stops polling, clears local cursor state, and notifies the command when the token expires', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-weixin-state-'));
    const bufPath = path.join(stateDir, 'get_updates.buf');
    const tokensPath = path.join(stateDir, 'context_tokens.json');
    fs.writeFileSync(bufPath, 'stale-cursor', 'utf-8');
    fs.writeFileSync(tokensPath, JSON.stringify({ 'user:old': 'stale-context' }), 'utf-8');

    let expiredCalls = 0;
    let bot: WeixinBot | undefined;

    try {
      bot = new WeixinBot({
        token: 'expired-token',
        baseUrl: 'https://weixin.example.test',
        cdnBaseUrl: 'https://cdn.example.test',
        stateDir,
        onSessionExpired: () => {
          expiredCalls += 1;
        },
      });

      (bot as any).isRunning = true;
      await (bot as any).handleSessionExpired();

      assert.equal(expiredCalls, 1);
      assert.equal((bot as any).isRunning, false);
      assert.equal(fs.existsSync(bufPath), false);
      assert.equal(fs.existsSync(tokensPath), false);
    } finally {
      bot?.destroy();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
