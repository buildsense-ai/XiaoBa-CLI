import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import { CatsConnectorAutoStart } from '../src/dashboard/cats-connector-autostart';

const dashboardDir = join(process.cwd(), 'dashboard');
const html = readFileSync(join(dashboardDir, 'connector.html'), 'utf-8');
const script = readFileSync(join(dashboardDir, 'connector.js'), 'utf-8');
const styles = readFileSync(join(dashboardDir, 'connector.css'), 'utf-8');
const serverSource = readFileSync(join(process.cwd(), 'src/dashboard/server.ts'), 'utf-8');

test('real Connector Dashboard exposes four runtime states without local Bot creation', () => {
  assert.match(html, /CatsCo Connector/);
  assert.match(html, /登录并连接/);
  assert.match(html, /正在连接这台电脑/);
  assert.match(script, /这台电脑已连接/);
  assert.match(html, /自动连接未完成/);
  assert.match(html, /可以直接关闭此窗口/);
  assert.doesNotMatch(html, /打开旧版控制台/);
  assert.doesNotMatch(html, /CONNECT THIS COMPUTER|READY FOR CATSCO/);
  assert.doesNotMatch(html, /创建 Bot|模型选择|System Prompt|Skill Hub|聊天输入/);
});

test('Connector lets an authenticated user switch the Agent bound to this computer', () => {
  assert.match(html, /id="agent-switch-open"[^>]*>切换/);
  assert.match(html, /切换 Agent/);
  assert.match(html, /一台电脑同一时间连接一个 Agent/);
  assert.match(script, /settled\('\/cats\/bots'\)/);
  assert.match(script, /request\('\/cats\/switch-bot'/);
  assert.match(script, /微信服务会停止/);
  assert.doesNotMatch(script, /\/cats\/create-bot/);
  assert.match(styles, /\.agent-switch-dialog/);
  assert.match(html, /id="logout-dialog"/);
  assert.match(html, /hero-actions[\s\S]*id="webapp-button"[\s\S]*id="logout-button"/);
  assert.doesNotMatch(html, /class="danger-zone"/);
  assert.doesNotMatch(script, /window\.confirm\(/);
  assert.match(script, /login-account'\)\?\.focus/);
  assert.match(script, /当前账号无权使用原 Agent（not your bot）/);
  assert.match(script, /setNotice\(`\$\{title\}：\$\{detail\}`/);
});

test('Connector local management restores channels and gives logs a full workspace', () => {
  assert.match(html, /本地管理/);
  assert.match(html, /通道与服务/);
  assert.match(html, /运行日志/);
  assert.match(html, /故障恢复/);
  assert.match(html, /飞书/);
  assert.match(html, /微信/);
  assert.match(html, /service-logs/);
  assert.match(script, /\/services\/\$\{encodeURIComponent\(name\)\}\/\$\{action\}/);
  assert.match(script, /\/weixin\/qrcode/);
  assert.match(script, /sanitizeLogLine/);
  assert.match(styles, /\.log-viewer\s*\{[\s\S]*flex: 1 1 auto/);
  assert.doesNotMatch(html, /<details class="diagnostics-panel"/);
});

test('Connector restores visible desktop update progress and explicit install confirmation', () => {
  assert.match(html, /id="update-dialog"/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /id="update-current-version"/);
  assert.match(html, /id="update-available-version"/);
  assert.match(html, /id="update-speed"/);
  assert.match(html, /id="update-remaining"/);
  assert.match(script, /安装并重启/);
  assert.match(styles, /\.update-dialog::backdrop/);
  assert.match(styles, /\.update-progress-track\.indeterminate/);
  assert.match(styles, /\.compact-card \.button\.update-active/);
  assert.match(script, /下载 \$\{Math\.round\(percent\)\}%/);
  assert.match(script, /settled\('\/update\/status'\)/);
  assert.match(script, /setInterval\(\(\) => \{ void refreshUpdateStatus\(\); \}, 1000\)/);
  assert.match(script, /request\('\/update\/download'/);
  assert.match(script, /request\('\/update\/install'/);
  assert.match(script, /previousStage === 'downloading'[\s\S]*\['downloaded', 'error'\]/);
  assert.match(script, /update-primary-action.*handleUpdatePrimaryAction/s);
});

test('Connector client uses real lifecycle APIs and remains syntax-valid', () => {
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(script, /\/cats\/bootstrap\/status/);
  assert.match(script, /\/cats\/auth\/login/);
  assert.match(script, /\/cats\/bootstrap/);
  assert.match(script, /\/cats\/auth\/logout/);
  assert.match(script, /\/services\/\$\{encodeURIComponent\(service\)\}\/logs/);
  assert.match(script, /cats\.connected/);
  assert.match(script, /cats\.chatReady/);
  assert.match(script, /service\.status === 'running'/);
  assert.match(script, /bodyStatus\?\.state !== 'offline'/);
  assert.match(script, /webapp-button.*addEventListener\('click'/s);
  assert.match(script, /openWebAppFromDashboard/);
  assert.match(styles, /\.channel-actions \.button[\s\S]*white-space: nowrap/);
});

test('Connector Dashboard is the real root and uses a viewport-bound desktop layout', () => {
  assert.match(serverSource, /app\.get\('\/',[\s\S]*connector\.html/);
  assert.match(serverSource, /SPA fallback[\s\S]*connector\.html/);
  assert.match(styles, /body\[data-view="ready"\]/);
  assert.match(styles, /html, body \{[^}]*height: 100%[^}]*overflow: hidden/s);
  assert.match(styles, /@media \(max-height: 700px\)/);
  assert.match(styles, /body\[data-view="connecting"\] \.primary-panel[\s\S]*overflow: hidden/);
  assert.match(styles, /body\[data-view="connecting"\] \.progress-list[\s\S]*width: 100%/);
});

test('background bootstrap waits for login without making network requests', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'catsco-connector-auth-'));
  let calls = 0;
  try {
    const controller = new CatsConnectorAutoStart({
      port: 3800,
      runtimeRoot,
      fetchImpl: async () => {
        calls += 1;
        throw new Error('unexpected network request');
      },
    });
    const snapshot = await controller.run('test');
    assert.equal(snapshot.stage, 'waiting_for_login');
    assert.equal(calls, 0);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('background bootstrap provisions once without rotating legacy relay credentials', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'catsco-connector-setup-'));
  const configDir = join(runtimeRoot, '.xiaoba');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'catsco.json'), JSON.stringify({
    version: 1,
    account: { token: 'test-user-token', uid: 'usr-test', username: 'tester' },
    endpoints: { httpBaseUrl: 'https://app.catsco.cc', serverUrl: 'wss://app.catsco.cc/v0/channels' },
    preferences: { autoConnect: true },
  }), 'utf-8');

  const requests: Array<{ url: string; init?: RequestInit }> = [];
  try {
    const controller = new CatsConnectorAutoStart({
      port: 3800,
      runtimeRoot,
      fetchImpl: async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.endsWith('/cats/status')) {
          return new Response(JSON.stringify({ connected: true, bodyConfigured: false, configured: false, service: { status: 'stopped' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.endsWith('/cats/setup')) {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 500 });
      },
    });

    const snapshot = await controller.run('test');
    assert.equal(snapshot.stage, 'connected');
    assert.equal(requests.filter((item) => item.url.endsWith('/cats/setup')).length, 1);
    const setupRequest = requests.find((item) => item.url.endsWith('/cats/setup'));
    assert.deepEqual(JSON.parse(String(setupRequest?.init?.body)), { setupRelayModel: false });
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('background bootstrap uses the fast start path for an existing binding', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'catsco-connector-start-'));
  const configDir = join(runtimeRoot, '.xiaoba');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'catsco.json'), JSON.stringify({
    version: 1,
    account: { token: 'test-user-token', uid: 'usr-test' },
    currentBot: {
      uid: 'bot-test',
      apiKey: 'test-bot-key',
      boundByUserUid: 'usr-test',
      bindingSource: 'test',
    },
    device: { deviceId: 'device-test', bodyId: 'device-test', installationId: 'device-test' },
    preferences: { autoConnect: true },
  }), 'utf-8');

  const paths: string[] = [];
  try {
    const controller = new CatsConnectorAutoStart({
      port: 3800,
      runtimeRoot,
      fetchImpl: async (input) => {
        const url = String(input);
        paths.push(url);
        if (url.endsWith('/cats/status')) {
          return new Response(JSON.stringify({ connected: true, bodyConfigured: true, configured: true, service: { status: 'stopped' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.endsWith('/cats/connector/start')) {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('{}', { status: 500 });
      },
    });
    const snapshot = await controller.run('startup');
    assert.equal(snapshot.stage, 'connected');
    assert.equal(paths.some((url) => url.endsWith('/cats/connector/start')), true);
    assert.equal(paths.some((url) => url.endsWith('/cats/setup')), false);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('background bootstrap is a no-op when the Connector is already running', async () => {
  const runtimeRoot = createRuntimeConfig('catsco-connector-running-', {
    version: 1,
    account: { token: 'test-user-token', uid: 'usr-test' },
    preferences: { autoConnect: true },
  });
  const paths: string[] = [];
  try {
    const controller = new CatsConnectorAutoStart({
      port: 3800,
      runtimeRoot,
      fetchImpl: async (input) => {
        paths.push(String(input));
        return jsonResponse({ connected: true, configured: true, service: { status: 'running' } });
      },
    });
    const snapshot = await controller.run('startup');
    assert.equal(snapshot.stage, 'connected');
    assert.equal(paths.filter((url) => url.endsWith('/cats/status')).length, 1);
    assert.equal(paths.some((url) => /\/cats\/(setup|connector\/start)$/.test(url)), false);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('invalid CatsCo login never provisions or starts a Connector', async () => {
  const runtimeRoot = createRuntimeConfig('catsco-connector-invalid-auth-', {
    version: 1,
    account: { token: 'expired-token', uid: 'usr-test' },
    preferences: { autoConnect: true },
  });
  const paths: string[] = [];
  try {
    const controller = new CatsConnectorAutoStart({
      port: 3800,
      runtimeRoot,
      fetchImpl: async (input) => {
        paths.push(String(input));
        return jsonResponse({ connected: false, authStatus: 'invalid', authError: '登录已过期' });
      },
    });
    const snapshot = await controller.run('startup');
    assert.equal(snapshot.stage, 'waiting_for_login');
    assert.equal(snapshot.error, '登录已过期');
    assert.equal(paths.some((url) => /\/cats\/(setup|connector\/start)$/.test(url)), false);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('disabled auto-connect performs no loopback requests unless forced', async () => {
  const runtimeRoot = createRuntimeConfig('catsco-connector-disabled-', {
    version: 1,
    account: { token: 'test-user-token', uid: 'usr-test' },
    preferences: { autoConnect: false },
  });
  let calls = 0;
  try {
    const controller = new CatsConnectorAutoStart({
      port: 3800,
      runtimeRoot,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({});
      },
    });
    const snapshot = await controller.run('startup');
    assert.equal(snapshot.stage, 'disabled');
    assert.equal(calls, 0);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('concurrent identical bootstrap triggers share one setup attempt', async () => {
  const runtimeRoot = createRuntimeConfig('catsco-connector-singleflight-', {
    version: 1,
    account: { token: 'test-user-token', uid: 'usr-test' },
    preferences: { autoConnect: true },
  });
  const setup = deferred<Response>();
  let statusCalls = 0;
  let setupCalls = 0;
  try {
    const controller = new CatsConnectorAutoStart({
      port: 3800,
      runtimeRoot,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('/cats/status')) {
          statusCalls += 1;
          return jsonResponse({ connected: true, bodyConfigured: false, configured: false, service: { status: 'stopped' } });
        }
        if (url.endsWith('/cats/setup')) {
          setupCalls += 1;
          return setup.promise;
        }
        return jsonResponse({ error: 'unexpected request' }, 500);
      },
    });
    const runs = Array.from({ length: 10 }, () => controller.run('startup'));
    await waitFor(() => setupCalls === 1);
    setup.resolve(jsonResponse({ ok: true }));
    const snapshots = await Promise.all(runs);
    assert.equal(snapshots.every((snapshot) => snapshot.stage === 'connected'), true);
    assert.equal(statusCalls, 1);
    assert.equal(setupCalls, 1);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('logout during setup fences the stale run and stops any late Connector', async () => {
  const runtimeRoot = createRuntimeConfig('catsco-connector-logout-race-', {
    version: 1,
    account: { token: 'test-user-token', uid: 'usr-test' },
    preferences: { autoConnect: true },
  });
  const setup = deferred<Response>();
  let setupCalls = 0;
  let stopCalls = 0;
  try {
    const controller = new CatsConnectorAutoStart({
      port: 3800,
      runtimeRoot,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('/cats/status')) {
          return jsonResponse({ connected: true, bodyConfigured: false, configured: false, service: { status: 'stopped' } });
        }
        if (url.endsWith('/cats/setup')) {
          setupCalls += 1;
          return setup.promise;
        }
        if (url.endsWith('/cats/connector/stop')) {
          stopCalls += 1;
          return jsonResponse({ ok: true });
        }
        return jsonResponse({ error: 'unexpected request' }, 500);
      },
    });

    const staleRun = controller.run('startup');
    await waitFor(() => setupCalls === 1);
    createCatsCoLocalConfigService({ runtimeRoot }).clearAccount();
    controller.invalidateAndSchedule('logout');
    setup.resolve(jsonResponse({ ok: true }));
    await staleRun;
    await waitFor(() => controller.getSnapshot().stage === 'waiting_for_login' && stopCalls === 1);
    assert.equal(controller.getSnapshot().trigger, 'logout');
    assert.equal(stopCalls, 1);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('loopback bootstrap requests include the configured Dashboard API key', async () => {
  const runtimeRoot = createRuntimeConfig('catsco-connector-api-key-', {
    version: 1,
    account: { token: 'test-user-token', uid: 'usr-test' },
    preferences: { autoConnect: true },
  });
  const headers: Headers[] = [];
  try {
    const controller = new CatsConnectorAutoStart({
      port: 3800,
      apiKey: 'dashboard-test-key',
      runtimeRoot,
      fetchImpl: async (_input, init) => {
        headers.push(new Headers(init?.headers));
        return jsonResponse({ connected: true, configured: true, service: { status: 'running' } });
      },
    });
    await controller.run('startup');
    assert.equal(headers.length, 1);
    assert.equal(headers[0].get('X-API-Key'), 'dashboard-test-key');
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('account or Agent transition clears a stale bootstrap error immediately', async () => {
  const runtimeRoot = createRuntimeConfig('catsco-connector-transition-', {
    version: 1,
    account: { token: 'test-user-token', uid: 'usr-test' },
    preferences: { autoConnect: true },
  });
  try {
    const controller = new CatsConnectorAutoStart({
      port: 3800,
      runtimeRoot,
      fetchImpl: async () => jsonResponse({ error: 'not your bot' }, 403),
    });
    const failed = await controller.run('login');
    assert.equal(failed.stage, 'error');
    assert.equal(failed.error, 'not your bot');

    const transition = controller.invalidateAndSchedule('switch-bot', 10_000, { force: true });
    assert.equal(transition.stage, 'connecting');
    assert.equal(transition.trigger, 'switch-bot');
    assert.equal(transition.error, undefined);
    controller.stop();
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

function createRuntimeConfig(prefix: string, value: Record<string, unknown>): string {
  const runtimeRoot = mkdtempSync(join(tmpdir(), prefix));
  const configDir = join(runtimeRoot, '.xiaoba');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'catsco.json'), JSON.stringify(value), 'utf-8');
  return runtimeRoot;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
