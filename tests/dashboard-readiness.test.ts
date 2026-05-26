import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import type { Server } from 'http';
import { createApiRouter } from '../src/dashboard/routes/api';
import { ServiceInfo } from '../src/dashboard/service-manager';

describe('dashboard readiness and service preflight API', () => {
  let testRoot: string;
  let originalCwd: string;
  let server: Server | undefined;
  let baseUrl: string;
  let services: Record<string, ServiceInfo>;
  let startCalls: string[];
  const envKeys = [
    'GAUZ_LLM_PROVIDER',
    'GAUZ_LLM_API_BASE',
    'GAUZ_LLM_API_KEY',
    'GAUZ_LLM_MODEL',
    'CATSCO_SERVER_URL',
    'CATSCO_HTTP_BASE_URL',
    'CATSCO_API_KEY',
    'CATSCO_USER_TOKEN',
    'CATSCO_USER_UID',
    'CATSCO_BOT_UID',
    'CATSCOMPANY_SERVER_URL',
    'CATSCOMPANY_HTTP_BASE_URL',
    'CATSCOMPANY_API_KEY',
    'CATSCOMPANY_USER_TOKEN',
    'CATSCOMPANY_USER_UID',
    'CATSCOMPANY_BOT_UID',
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'WEIXIN_TOKEN',
    'XIAOBA_CONFIG_PATH',
    'XIAOBA_RUNTIME_PROFILE_PATH',
  ];
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    originalCwd = process.cwd();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dashboard-readiness-'));
    process.chdir(testRoot);
    startCalls = [];
    services = createServices();

    for (const key of envKeys) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.XIAOBA_CONFIG_PATH = path.join(testRoot, 'user-config.json');
    process.env.XIAOBA_RUNTIME_PROFILE_PATH = path.join(testRoot, 'runtime-profile.json');

    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter({
      getAll: () => Object.values(services),
      getService: (name: string) => services[name],
      start: (name: string) => {
        startCalls.push(name);
        services[name] = {
          ...services[name],
          status: 'running',
          pid: 1234,
          startedAt: Date.now(),
        };
        return services[name];
      },
      restart: (name: string) => {
        startCalls.push(`restart:${name}`);
        services[name] = {
          ...services[name],
          status: 'running',
          pid: 1234,
          startedAt: Date.now(),
        };
        return services[name];
      },
      stop: (name: string) => {
        services[name] = {
          ...services[name],
          status: 'stopped',
          pid: undefined,
          startedAt: undefined,
        };
        return services[name];
      },
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
    process.chdir(originalCwd);
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('GET /readiness blocks startup when the primary model key is missing', async () => {
    const response = await fetch(`${baseUrl}/api/readiness`);
    const text = await response.text();
    const data = JSON.parse(text) as any;
    const model = data.sections.find((section: any) => section.id === 'model');

    assert.equal(response.status, 200);
    assert.equal(data.status, 'blocked');
    assert.equal(model.status, 'blocked');
    assert.equal(model.label, '模型来源');
    assert.equal(model.checks.some((check: any) => check.id === 'model.managed.account' && check.status === 'warning'), true);
    assert.equal(model.checks.some((check: any) => check.id === 'model.custom.credential' && check.status === 'fail'), true);
    assert.equal(text.includes('GAUZ_LLM_API_KEY'), false);
    assert.equal(text.includes('buildsense.asia'), false);
  });

  test('CatsCo readiness warns when account and binding are ready but connector is stopped', async () => {
    writeEnv([
      'GAUZ_LLM_PROVIDER=anthropic',
      'GAUZ_LLM_API_BASE=https://model.example.test/v1/messages',
      'GAUZ_LLM_API_KEY=sk-readiness-secret',
      'GAUZ_LLM_MODEL=MiniMax-M2.7-highspeed',
      'CATSCO_HTTP_BASE_URL=https://app.catsco.cc',
      'CATSCO_SERVER_URL=wss://app.catsco.cc/v0/channels',
      'CATSCO_API_KEY=catsco-agent-secret',
      'CATSCO_USER_TOKEN=user-token',
      'CATSCO_USER_UID=100',
      'CATSCO_BOT_UID=200',
    ]);

    const preflightResponse = await fetch(`${baseUrl}/api/services/catscompany/preflight`, { method: 'POST' });
    const preflightText = await preflightResponse.text();
    const preflight = JSON.parse(preflightText) as any;
    assert.equal(preflightResponse.status, 200);
    assert.equal(preflight.status, 'warning');
    assert.equal(preflight.canStart, true);
    assert.deepStrictEqual(preflight.blockingChecks, []);
    assert.equal(preflight.warningChecks.includes('model.managed.relay'), true);
    assert.equal(preflightText.includes('sk-readiness-secret'), false);
    assert.equal(preflightText.includes('catsco-agent-secret'), false);
    assert.equal(preflightText.includes(testRoot), false);

    const readinessResponse = await fetch(`${baseUrl}/api/readiness`);
    const readinessText = await readinessResponse.text();
    const readiness = JSON.parse(readinessText) as any;
    const catsco = readiness.sections.find((section: any) => section.id === 'catsco');
    assert.equal(catsco.status, 'warning');
    assert.equal(catsco.checks.some((check: any) => check.id === 'catsco.connector' && check.status === 'warning'), true);
    assert.equal(catsco.checks.some((check: any) => check.id === 'catsco.connector' && check.label === 'CatsCompany connector'), true);
    assert.equal(catsco.checks.some((check: any) => check.id === 'catsco.connector' && check.message === 'CatsCompany connector 尚未启动'), true);
    assert.equal(catsco.checks.some((check: any) => check.id === 'catsco.connector' && check.action?.label === '启动 CatsCompany connector'), true);
    assert.equal(readinessText.includes('sk-readiness-secret'), false);
    assert.equal(readinessText.includes('catsco-agent-secret'), false);
    assert.equal(readinessText.includes(testRoot), false);
  });

  test('Feishu and Weixin preflight block when connector credentials are missing', async () => {
    writeEnv([
      'GAUZ_LLM_PROVIDER=openai',
      'GAUZ_LLM_API_BASE=https://model.example.test/v1/chat/completions',
      'GAUZ_LLM_API_KEY=sk-readiness-secret',
      'GAUZ_LLM_MODEL=test-model',
    ]);

    const feishuResponse = await fetch(`${baseUrl}/api/services/feishu/preflight`, { method: 'POST' });
    const feishu = await feishuResponse.json() as any;
    assert.equal(feishuResponse.status, 200);
    assert.equal(feishu.status, 'blocked');
    assert.equal(feishu.blockingChecks.includes('service.feishu.appId'), true);
    assert.equal(feishu.blockingChecks.includes('service.feishu.appSecret'), true);

    const weixinResponse = await fetch(`${baseUrl}/api/services/weixin/preflight`, { method: 'POST' });
    const weixin = await weixinResponse.json() as any;
    assert.equal(weixinResponse.status, 200);
    assert.equal(weixin.status, 'blocked');
    assert.equal(weixin.blockingChecks.includes('service.weixin.token'), true);
  });

  test('preflight honors legacy user config inputs without leaking configured secrets', async () => {
    fs.writeFileSync(process.env.XIAOBA_CONFIG_PATH!, JSON.stringify({
      provider: 'anthropic',
      apiUrl: 'https://model.example.test/v1/messages',
      apiKey: 'sk-config-secret',
      model: 'config-model',
      catscompany: {
        serverUrl: 'wss://app.catsco.cc/v0/channels',
        apiKey: 'catsco-config-secret',
      },
      feishu: {
        appId: 'cli-config-app-id',
        appSecret: 'feishu-config-secret',
      },
    }), 'utf-8');

    const catscoResponse = await fetch(`${baseUrl}/api/services/catscompany/preflight`, { method: 'POST' });
    const catscoText = await catscoResponse.text();
    const catsco = JSON.parse(catscoText) as any;
    assert.equal(catsco.status, 'warning');
    assert.equal(catscoText.includes('sk-config-secret'), false);
    assert.equal(catscoText.includes('catsco-config-secret'), false);

    const feishuResponse = await fetch(`${baseUrl}/api/services/feishu/preflight`, { method: 'POST' });
    const feishuText = await feishuResponse.text();
    const feishu = JSON.parse(feishuText) as any;
    assert.equal(feishu.status, 'warning');
    assert.equal(feishuText.includes('sk-config-secret'), false);
    assert.equal(feishuText.includes('feishu-config-secret'), false);
  });

  test('runtime profile validation does not echo raw invalid tool values', async () => {
    writeEnv([
      'GAUZ_LLM_PROVIDER=anthropic',
      'GAUZ_LLM_API_BASE=https://model.example.test/v1/messages',
      'GAUZ_LLM_API_KEY=sk-readiness-secret',
      'GAUZ_LLM_MODEL=MiniMax-M2.7-highspeed',
      'CATSCO_SERVER_URL=wss://app.catsco.cc/v0/channels',
      'CATSCO_API_KEY=catsco-agent-secret',
    ]);
    fs.writeFileSync(process.env.XIAOBA_RUNTIME_PROFILE_PATH!, JSON.stringify({
      schemaVersion: 1,
      profile: {
        tools: {
          enabled: [
            'read_file',
            `unknown-${testRoot}-sk-profile-secret`,
          ],
        },
      },
    }), 'utf-8');

    const response = await fetch(`${baseUrl}/api/services/catscompany/preflight`, { method: 'POST' });
    const text = await response.text();
    const data = JSON.parse(text) as any;
    const profileCheck = data.checks.find((check: any) => check.id === 'runtime.profile');

    assert.equal(response.status, 200);
    assert.equal(data.status, 'blocked');
    assert.match(profileCheck.message, /Unknown runtime tool configured/);
    assert.equal(text.includes('sk-profile-secret'), false);
    assert.equal(text.includes(testRoot), false);
  });

  test('service start runs preflight first and does not spawn when blocked', async () => {
    const response = await fetch(`${baseUrl}/api/services/catscompany/start`, { method: 'POST' });
    const data = await response.json() as any;

    assert.equal(response.status, 400);
    assert.equal(data.error, 'Service preflight blocked');
    assert.equal(data.preflight.status, 'blocked');
    assert.deepStrictEqual(startCalls, []);
    assert.equal(services.catscompany.status, 'stopped');
  });

  test('service restart also runs preflight before touching a service', async () => {
    const response = await fetch(`${baseUrl}/api/services/catscompany/restart`, { method: 'POST' });
    const data = await response.json() as any;

    assert.equal(response.status, 400);
    assert.equal(data.error, 'Service preflight blocked');
    assert.deepStrictEqual(startCalls, []);
    assert.equal(services.catscompany.status, 'stopped');
  });

  test('force start remains an explicit diagnostics escape hatch', async () => {
    const response = await fetch(`${baseUrl}/api/services/catscompany/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    const data = await response.json() as any;

    assert.equal(response.status, 200);
    assert.equal(data.status, 'running');
    assert.deepStrictEqual(startCalls, ['catscompany']);
  });

  test('service start proceeds after readiness blockers are resolved', async () => {
    writeEnv([
      'GAUZ_LLM_PROVIDER=anthropic',
      'GAUZ_LLM_API_BASE=https://model.example.test/v1/messages',
      'GAUZ_LLM_API_KEY=sk-readiness-secret',
      'GAUZ_LLM_MODEL=MiniMax-M2.7-highspeed',
      'CATSCO_SERVER_URL=wss://app.catsco.cc/v0/channels',
      'CATSCO_API_KEY=catsco-agent-secret',
    ]);

    const response = await fetch(`${baseUrl}/api/services/catscompany/start`, { method: 'POST' });
    const text = await response.text();
    const data = JSON.parse(text) as any;

    assert.equal(response.status, 200);
    assert.equal(data.status, 'running');
    assert.deepStrictEqual(startCalls, ['catscompany']);
    assert.equal(text.includes('sk-readiness-secret'), false);
    assert.equal(text.includes('catsco-agent-secret'), false);
  });

  const windowsOnlyTest = process.platform === 'win32' ? test : test.skip;

  windowsOnlyTest('Windows command preflight accepts PATHEXT executable lookup', async () => {
    const previousPath = process.env.PATH;
    const previousPathExt = process.env.PATHEXT;
    const binDir = path.join(testRoot, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'node.exe'), '');
    services.catscompany.command = 'node';
    process.env.PATH = `${binDir}${path.delimiter}${previousPath || ''}`;
    process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
    writeEnv([
      'GAUZ_LLM_PROVIDER=anthropic',
      'GAUZ_LLM_API_BASE=https://model.example.test/v1/messages',
      'GAUZ_LLM_API_KEY=sk-readiness-secret',
      'GAUZ_LLM_MODEL=MiniMax-M2.7-highspeed',
      'CATSCO_SERVER_URL=wss://app.catsco.cc/v0/channels',
      'CATSCO_API_KEY=catsco-agent-secret',
    ]);

    try {
      const response = await fetch(`${baseUrl}/api/services/catscompany/preflight`, { method: 'POST' });
      const data = await response.json() as any;
      assert.equal(response.status, 200);
      assert.equal(data.blockingChecks.includes('runtime.command'), false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousPathExt === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = previousPathExt;
    }
  });
});

function createServices(): Record<string, ServiceInfo> {
  return {
    catscompany: service('catscompany', 'CatsCo agent'),
    feishu: service('feishu', '飞书机器人'),
    weixin: service('weixin', '微信机器人'),
  };
}

function service(name: string, label: string): ServiceInfo {
  return {
    name,
    label,
    command: process.execPath,
    args: ['dist/index.js', name],
    status: 'stopped',
  };
}

function writeEnv(lines: string[]): void {
  fs.writeFileSync(path.join(process.cwd(), '.env'), `${lines.join('\n')}\n`, 'utf-8');
}

function listen(app: express.Express): Promise<Server> {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}
