import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import express from 'express';
import type { Server } from 'node:http';
import { createApiRouter } from '../src/dashboard/routes/api';

describe('dashboard weixin agent channel binding', () => {
  let testRoot: string;
  let originalCwd: string;
  let server: Server | undefined;
  let baseUrl: string;
  let envKeys: string[];
  const originalFetch = globalThis.fetch;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    originalCwd = process.cwd();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-weixin-binding-'));
    process.chdir(testRoot);
    envKeys = isolatedEnvKeys();
    for (const key of envKeys) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }

    globalThis.fetch = async (input: any, init?: any) => {
      const url = String(input);
      if (url.includes('/ilink/bot/get_bot_qrcode')) {
        return jsonResponse({ qrcode: 'qr-1', qrcode_img_content: 'https://qr.example/1' });
      }
      if (url.includes('/ilink/bot/get_qrcode_status')) {
        return jsonResponse({ status: 'confirmed', bot_token: 'wx-secret-token-1234' });
      }
      return originalFetch(input, init);
    };

    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter({
      getAll: () => [],
      getService: () => undefined,
      getLogs: () => [],
    } as any));
    server = await listen(app);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>(resolve => server!.close(() => resolve()));
      server = undefined;
    }
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
      delete originalEnv[key];
    }
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('qrcode requires a selected CatsCo agent body', async () => {
    const response = await fetch(`${baseUrl}/api/weixin/qrcode`);
    const data = await response.json() as any;

    assert.equal(response.status, 409);
    assert.match(data.error, /agent/);
    assert.equal(data.channelStatus.configured, false);
  });

  test('confirmed qrcode binds Weixin channel to the current agent without returning token', async () => {
    writeCatsCoConfig({
      botUid: '42',
      botName: 'Dev Agent',
      bodyId: 'body-dev',
      userUid: '7',
      username: 'alice',
    });

    const qrResponse = await fetch(`${baseUrl}/api/weixin/qrcode`);
    const qr = await qrResponse.json() as any;
    assert.equal(qrResponse.status, 200);
    assert.equal(qr.agent_uid, '42');

    const statusResponse = await fetch(`${baseUrl}/api/weixin/qrcode-status?qrcode=${encodeURIComponent(qr.qrcode)}&agent_uid=${qr.agent_uid}`);
    const text = await statusResponse.text();
    const data = JSON.parse(text) as any;

    assert.equal(statusResponse.status, 200);
    assert.equal(data.status, 'confirmed');
    assert.equal(data.token_saved, true);
    assert.equal(data.bot_token, undefined);
    assert.equal(text.includes('wx-secret-token-1234'), false);
    assert.equal(data.binding.agentUid, '42');
    assert.equal(data.binding.agentName, 'Dev Agent');
    assert.equal(data.binding.bodyId, 'body-dev');
    assert.equal(data.binding.tokenLast4, '1234');
    assert.equal(data.binding.tokenHash, undefined);

    const env = dotenv.parse(fs.readFileSync(path.join(testRoot, '.env'), 'utf-8'));
    assert.equal(env.WEIXIN_TOKEN, 'wx-secret-token-1234');
    assert.equal(env.WEIXIN_BOUND_AGENT_UID, '42');
    assert.equal(env.WEIXIN_BOUND_AGENT_NAME, 'Dev Agent');
    assert.equal(env.WEIXIN_BOUND_BODY_ID, 'body-dev');

    const file = JSON.parse(fs.readFileSync(path.join(testRoot, '.xiaoba', 'channel-bindings.json'), 'utf-8'));
    assert.equal(file.weixin.agentUid, '42');
    assert.equal(file.weixin.tokenLast4, '1234');
    assert.equal(typeof file.weixin.tokenHash, 'string');

    delete process.env.WEIXIN_TOKEN;
    const bindingResponse = await fetch(`${baseUrl}/api/weixin/channel-binding`);
    const bindingText = await bindingResponse.text();
    const binding = JSON.parse(bindingText) as any;
    assert.equal(binding.configured, true);
    assert.equal(binding.binding.agentUid, '42');
    assert.equal(binding.binding.tokenHash, undefined);
    assert.equal(bindingText.includes('wx-secret-token-1234'), false);
  });

  test('qrcode confirmation rejects when the selected agent changed', async () => {
    writeCatsCoConfig({
      botUid: '42',
      botName: 'Dev Agent',
      bodyId: 'body-dev',
      userUid: '7',
      username: 'alice',
    });

    const response = await fetch(`${baseUrl}/api/weixin/qrcode-status?qrcode=qr-1&agent_uid=99`);
    const data = await response.json() as any;

    assert.equal(response.status, 409);
    assert.match(data.error, /扫码开始时的 agent/);
    assert.equal(fs.existsSync(path.join(testRoot, '.env')), false);
  });

  function writeCatsCoConfig(input: {
    botUid: string;
    botName: string;
    bodyId: string;
    userUid: string;
    username: string;
  }): void {
    fs.mkdirSync(path.join(testRoot, '.xiaoba'), { recursive: true });
    fs.writeFileSync(path.join(testRoot, '.xiaoba', 'catsco.json'), JSON.stringify({
      version: 1,
      account: {
        token: 'user-token',
        uid: input.userUid,
        username: input.username,
      },
      currentBot: {
        uid: input.botUid,
        name: input.botName,
        username: 'dev-agent',
        apiKey: 'bot-api-key',
        boundByUserUid: input.userUid,
        bindingSource: 'test',
      },
      device: {
        deviceId: 'device-dev',
        bodyId: input.bodyId,
        installationId: 'install-dev',
      },
      endpoints: {
        httpBaseUrl: 'https://app.catsco.cc',
        serverUrl: 'wss://app.catsco.cc/v0/channels',
      },
    }), 'utf-8');
  }
});

function isolatedEnvKeys(): string[] {
  const prefixes = ['CATSCO_', 'CATSCOMPANY_', 'WEIXIN_'];
  const explicit = [
    'CATSCO_LOCAL_CONFIG_PATH',
    'CATSCO_CONFIG_PATH',
  ];
  return Array.from(new Set([
    ...explicit,
    ...Object.keys(process.env).filter(key => prefixes.some(prefix => key.startsWith(prefix))),
  ]));
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function listen(app: express.Express): Promise<Server> {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}
