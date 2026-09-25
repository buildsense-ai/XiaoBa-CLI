import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import { CatsConnectorAutoStart } from '../src/dashboard/cats-connector-autostart';
import { resolveDashboardConnectorPolicy } from '../src/dashboard/server';

const dashboardDir = join(process.cwd(), 'dashboard');
const html = readFileSync(join(dashboardDir, 'connector.html'), 'utf-8');
const script = readFileSync(join(dashboardDir, 'connector.js'), 'utf-8');
const styles = readFileSync(join(dashboardDir, 'connector.css'), 'utf-8');
const serverSource = readFileSync(join(process.cwd(), 'src/dashboard/server.ts'), 'utf-8');
const installSh = readFileSync(join(process.cwd(), 'install.sh'), 'utf-8');
const installPs1 = readFileSync(join(process.cwd(), 'install.ps1'), 'utf-8');

test('real Connector Dashboard exposes four runtime states without local Bot creation', () => {
  assert.match(html, /CatsCo Connector/);
  assert.match(html, /登录并连接/);
  assert.match(html, /placeholder="请用邮箱登录"/);
  assert.match(html, /正在连接这台电脑/);
  assert.match(script, /这台电脑已连接/);
  assert.match(html, /自动连接未完成/);
  assert.match(html, /可以直接关闭此窗口/);
  assert.doesNotMatch(html, /打开旧版控制台/);
  assert.doesNotMatch(html, /CONNECT THIS COMPUTER|READY FOR CATSCO/);
  assert.doesNotMatch(html, /创建 Bot|模型选择|System Prompt|Skill Hub|聊天输入/);
  assert.match(html, /id="device-connector-status"/);
  assert.doesNotMatch(html, /当前 Agent|切换 Agent|agent-switch-open/);
  assert.doesNotMatch(script, /\/cats\/switch-bot|\/cats\/bots/);
});

test('Connector UI does not expose legacy Bot identity or switching controls', () => {
  assert.match(html, /<span>本机连接<\/span>/);
  assert.match(html, /注册这台电脑/);
  assert.doesNotMatch(html, /id="agent-switch-open"|切换 Agent|当前 Agent/);
  assert.doesNotMatch(script, /settled\('\/cats\/bots'\)/);
  assert.doesNotMatch(script, /request\('\/cats\/switch-bot'/);
  assert.doesNotMatch(script, /\/cats\/create-bot/);
  assert.doesNotMatch(styles, /\.agent-switch-dialog/);
  assert.match(html, /id="logout-dialog"/);
  assert.match(html, /hero-actions[\s\S]*id="webapp-button"[\s\S]*id="logout-button"/);
  assert.doesNotMatch(html, /class="danger-zone"/);
  assert.doesNotMatch(script, /window\.confirm\(/);
  assert.match(script, /login-account'\)\?\.focus/);
  assert.match(script, /当前账号无法使用旧版 Bot 绑定/);
  assert.match(script, /setNotice\(`\$\{title\}：\$\{detail\}`/);
});

test('Connector local management keeps only the run log workspace', () => {
  assert.match(html, /<strong>运行日志<\/strong>/);
  assert.match(html, /查看 Connector 与本机服务的最近运行记录/);
  assert.match(html, /service-logs/);
  assert.match(script, /services\/catscompany\/logs/);
  assert.match(script, /sanitizeLogLine/);
  assert.match(script, /打开运行日志查看日志/);
  assert.doesNotMatch(script, /本地管理/);
  assert.match(styles, /\.log-viewer\s*\{[\s\S]*flex: 1 1 auto/);
  assert.doesNotMatch(html, /通道与服务|故障恢复|Cache Trace|Turn Errors|management-tabs|log-service-select|飞书|微信/);
  assert.doesNotMatch(script, /weixin\/qrcode|renderChannels|serviceAction|log-service-select/);
  assert.doesNotMatch(styles, /\.channel-card|\.recovery-row|\.management-tabs/);
  assert.doesNotMatch(html, /<details class="diagnostics-panel"/);
});

test('Connector log viewer drops the decorative startup banner', () => {
  const filters = script.match(/const LOG_BANNER_ART = (.+?);[\s\S]*?const LOG_BANNER_SLOGAN = (.+?);/);
  assert.ok(filters, 'connector.js declares the startup banner filters');
  const isBanner = vm.runInNewContext(`(line) => ${filters[1]}.test(line) || ${filters[2]}.test(line)`);

  const bannerLines = [
    '       ▄████▄             ▄████▄',
    '      ████████▄▄▄▄▄▄▄▄▄▄▄████████',
    '      ▐██▀  ▀██▀  ▀██▀  ▀██▀  ██▌',
    '   ██╗  ██╗██╗ █████╗  ██████╗     ██████╗  █████╗',
    '        ██▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓██            < Your AI Assistant !!! Meow Meow !!! >',
  ];
  for (const line of bannerLines) {
    assert.equal(isBanner(line), true, `banner line should be hidden: ${line}`);
  }

  const runtimeLines = [
    '[info] CatsCo bot 1156 已准备云端模型配置 revision=0。',
    '[info] [CatsCompany] 正在连接: wss://app.catsco.cc/v0/channels, apiKey=cc_484...78b0, bodyId=device_1da48e7b0e65',
    '[OK] CatsCo agent 已连接，uid=usr1156, name=CatsCo (Eason)',
  ];
  for (const line of runtimeLines) {
    assert.equal(isBanner(line), false, `runtime log line should stay visible: ${line}`);
  }

  assert.match(script, /filter\(line => !isBrandBannerLine\(line\)\)/);
  assert.match(script, /navigator\.clipboard\.writeText\(\$\('service-logs'\)\?\.textContent \|\| ''\)/);
  assert.doesNotMatch(script, /renderLogLines|log-banner|logTextFromViewer/);
});

test('Connector restores visible desktop update progress and explicit install confirmation', () => {
  assert.match(html, /id="update-dialog"/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /id="update-current-version"/);
  assert.match(html, /id="update-available-version"/);
  assert.match(html, /id="update-speed"/);
  assert.match(html, /id="update-remaining"/);
  assert.match(html, /id="update-manual-link"/);
  assert.match(script, /安装并重启/);
  assert.match(script, /case 'preparing_install'/);
  assert.match(script, /openReleasePage/);
  assert.match(styles, /\.update-dialog::backdrop/);
  assert.match(styles, /\.update-progress-track\.indeterminate/);
  assert.match(styles, /\.compact-card \.button\.update-active/);
  assert.match(script, /下载 \$\{Math\.round\(percent\)\}%/);
  assert.match(script, /settled\('\/update\/status'\)/);
  assert.match(script, /setInterval\(\(\) => \{ void refreshUpdateStatus\(\); \}, 1000\)/);
  assert.match(script, /request\('\/update\/download'/);
  assert.match(script, /request\('\/update\/install'/);
  assert.match(script, /\['downloading', 'preparing_install', 'installing'\]\.includes\(previousStage\)/);
  assert.match(script, /update-primary-action.*handleUpdatePrimaryAction/s);
});

test('Connector client uses real lifecycle APIs and remains syntax-valid', () => {
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(script, /\/cats\/bootstrap\/status/);
  assert.match(script, /\/cats\/auth\/login/);
  assert.match(script, /\/cats\/bootstrap/);
  assert.match(script, /\/cats\/auth\/logout/);
  assert.match(script, /\/services\/catscompany\/logs/);
  assert.match(script, /cats\.connected/);
  assert.match(script, /cats\.chatReady/);
  assert.match(script, /service\.status === 'running'/);
  assert.match(script, /bodyStatus\?\.state !== 'offline'/);
  assert.match(script, /webapp-button.*addEventListener\('click'/s);
  assert.match(script, /openWebAppFromDashboard/);
  assert.match(styles, /\.management-entry strong/);
  assert.match(styles, /\.toolbar-actions/);
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

test('background bootstrap provisions a device connector without invoking legacy Bot setup', async () => {
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
  let statusCalls = 0;
  try {
    const controller = new CatsConnectorAutoStart({
      port: 3800,
      runtimeRoot,
      fetchImpl: async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.endsWith('/cats/status')) {
          statusCalls += 1;
          return new Response(JSON.stringify({ connected: true, deviceConnectorMode: statusCalls > 1, bodyConfigured: false, configured: statusCalls > 1, service: { status: 'stopped' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.endsWith('/cats/device-connector/provision') || url.endsWith('/cats/connector/start')) {
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
    assert.equal(requests.filter((item) => item.url.endsWith('/cats/device-connector/provision')).length, 1);
    assert.equal(requests.some((item) => item.url.endsWith('/cats/setup')), false);
    assert.deepEqual(JSON.parse(String(requests.find((item) => item.url.endsWith('/cats/device-connector/provision'))?.init?.body)), {});
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
          return new Response(JSON.stringify({ connected: true, deviceConnectorMode: true, bodyConfigured: true, configured: true, service: { status: 'stopped' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.endsWith('/cats/device-connector/provision')) return jsonResponse({ ok: true, reused: true, refreshed: false });
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

test('background bootstrap migrates a legacy Bot installation to device Connector without deleting its binding', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'catsco-connector-migration-'));
  const configDir = join(runtimeRoot, '.xiaoba');
  mkdirSync(configDir, { recursive: true });
  const legacyBot = {
    uid: 'legacy-bot',
    apiKey: 'legacy-api-key',
    boundByUserUid: 'usr-test',
    bindingSource: 'legacy',
  };
  writeFileSync(join(configDir, 'catsco.json'), JSON.stringify({
    version: 1,
    account: { token: 'test-user-token', uid: 'usr-test' },
    currentBot: legacyBot,
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
          return jsonResponse({
            connected: true,
            deviceConnectorMode: false,
            bodyConfigured: true,
            configured: true,
            service: { status: 'running' },
          });
        }
        if (url.endsWith('/cats/device-connector/provision') || url.endsWith('/cats/connector/start')) {
          return jsonResponse({ ok: true });
        }
        return jsonResponse({ error: 'unexpected request' }, 500);
      },
    });

    const snapshot = await controller.run('startup');
    const savedConfig = createCatsCoLocalConfigService({ runtimeRoot }).load();
    assert.equal(snapshot.stage, 'connected');
    assert.deepEqual(paths.filter((url) => /\/cats\/(device-connector\/provision|connector\/start)$/.test(url)).map((url) => url.split('/').slice(-2).join('/')), [
      'device-connector/provision',
      'connector/start',
    ]);
    assert.equal(paths.some((url) => url.endsWith('/cats/setup')), false);
    assert.deepEqual(savedConfig.currentBot, legacyBot);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('dashboard connector policy keeps server ownership opt-in and preserves desktop override-off', () => {
  assert.deepEqual(resolveDashboardConnectorPolicy({}), {
    autoProvisionDeviceConnector: false,
    manageConnector: false,
  });
  assert.deepEqual(resolveDashboardConnectorPolicy({ XIAOBA_RUNTIME_ROLE: 'desktop' }), {
    autoProvisionDeviceConnector: true,
    manageConnector: true,
  });
  assert.deepEqual(resolveDashboardConnectorPolicy({ XIAOBA_RUNTIME_ROLE: 'desktop', XIAOBA_ENABLE_DEVICE_CONNECTOR_AUTOPROVISION: '0' }), {
    autoProvisionDeviceConnector: false,
    manageConnector: true,
  });
  assert.deepEqual(resolveDashboardConnectorPolicy({ XIAOBA_ENABLE_DEVICE_CONNECTOR_AUTOPROVISION: '1' }), {
    autoProvisionDeviceConnector: true,
    manageConnector: true,
  });
  for (const role of ['Desktop', 'DESKTOP', ' desktop ']) {
    assert.deepEqual(resolveDashboardConnectorPolicy({ XIAOBA_RUNTIME_ROLE: role }), {
      autoProvisionDeviceConnector: true,
      manageConnector: true,
    });
  }
  assert.match(installSh, /XIAOBA_RUNTIME_ROLE=desktop npx tsx src\/index\.ts dashboard/);
  assert.match(installPs1, /set "XIAOBA_RUNTIME_ROLE=desktop"/);
});

test('Windows installer generates a launcher that sets the child runtime role', () => {
  // Evaluate the actual generation block, not the installer main flow (which
  // installs software and creates a desktop shortcut).
  const generation = installPs1.match(/function Create-Launcher \{([\s\S]*?)\r?\n    Log /)?.[1];
  assert.ok(generation);
  for (const inheritedRole of [undefined, 'server']) {
    const root = mkdtempSync(join(tmpdir(), 'catsco-launcher-'));
    try {
      const env = { ...process.env, LAUNCHER_TEST_ROOT: root };
      if (inheritedRole === undefined) delete env.XIAOBA_RUNTIME_ROLE;
      else env.XIAOBA_RUNTIME_ROLE = inheritedRole;
      const source = '$ErrorActionPreference = "Stop"\n$InstallDir = $env:LAUNCHER_TEST_ROOT\n$DashboardPort = 3800\n' + generation;
      const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
      const generated = spawnSync(powershell, [
        '-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(source, 'utf16le').toString('base64'),
      ], { env, encoding: 'utf8', timeout: 15000 });
      assert.equal(generated.status, 0, generated.stderr);
      const launcher = readFileSync(join(root, 'start.bat'), 'utf8');
      assert.match(launcher, /set "XIAOBA_RUNTIME_ROLE=desktop"/);
      // This cross-platform test verifies the real here-string generation on
      // every CI runner, including Ubuntu. The generated batch file is not
      // executed by the repository's current CI jobs.
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('server bootstrap keeps a cloud Bot and does not auto-provision a device Connector', async () => {
  const runtimeRoot = createRuntimeConfig('catsco-connector-server-', {
    version: 1,
    account: { token: 'test-user-token', uid: 'usr-test' },
    currentBot: { uid: 'cloud-bot', apiKey: 'cloud-key', boundByUserUid: 'usr-test' },
    preferences: { autoConnect: true },
  });
  const paths: string[] = [];
  try {
    const controller = new CatsConnectorAutoStart({
      port: 3800,
      runtimeRoot,
      autoProvisionDeviceConnector: false,
      manageConnector: false,
      fetchImpl: async (input) => {
        const url = String(input);
        paths.push(url);
        if (url.endsWith('/cats/status')) {
          return jsonResponse({
            connected: true,
            deviceConnectorMode: false,
            bodyConfigured: true,
            configured: true,
            service: { status: 'stopped' },
          });
        }
        if (url.endsWith('/cats/connector/start')) return jsonResponse({ ok: true });
        return jsonResponse({ error: 'unexpected request' }, 500);
      },
    });

    const snapshot = await controller.run('startup');
    assert.equal(snapshot.stage, 'connected');
    assert.equal(paths.some((url) => url.endsWith('/cats/device-connector/provision')), false);
    assert.equal(paths.some((url) => url.endsWith('/cats/connector/start')), false);
    assert.equal(paths.some((url) => url.endsWith('/cats/setup')), false);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('background bootstrap keeps an already-current running device Connector', async () => {
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
        const url = String(input);
        paths.push(url);
        if (url.endsWith('/cats/device-connector/provision')) return jsonResponse({ ok: true, reused: true, refreshed: false });
        return jsonResponse({ connected: true, deviceConnectorMode: true, configured: true, service: { status: 'running' } });
      },
    });
    const snapshot = await controller.run('startup');
    assert.equal(snapshot.stage, 'connected');
    assert.equal(paths.filter((url) => url.endsWith('/cats/status')).length, 1);
    assert.equal(paths.filter((url) => url.endsWith('/cats/device-connector/provision')).length, 1);
    assert.equal(paths.filter((url) => url.endsWith('/cats/connector/start')).length, 0);
    assert.equal(paths.some((url) => url.endsWith('/cats/setup')), false);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('background bootstrap restarts an active Connector after a device credential migration', async () => {
  const runtimeRoot = createRuntimeConfig('catsco-connector-credential-migration-', {
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
        const url = String(input);
        paths.push(url);
        if (url.endsWith('/cats/device-connector/provision')) return jsonResponse({ ok: true, reused: true, refreshed: true });
        return jsonResponse({ connected: true, deviceConnectorMode: true, configured: true, service: { status: 'running' } });
      },
    });

    const snapshot = await controller.run('startup');
    assert.equal(snapshot.stage, 'connected');
    assert.equal(paths.filter((url) => url.endsWith('/cats/device-connector/provision')).length, 1);
    assert.equal(paths.filter((url) => url.endsWith('/cats/connector/start')).length, 1);
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
  const provisioning = deferred<Response>();
  let statusCalls = 0;
  let provisionCalls = 0;
  try {
    const controller = new CatsConnectorAutoStart({
      port: 3800,
      runtimeRoot,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('/cats/status')) {
          statusCalls += 1;
          return jsonResponse({ connected: true, deviceConnectorMode: statusCalls > 1, configured: statusCalls > 1, service: { status: 'stopped' } });
        }
        if (url.endsWith('/cats/device-connector/provision')) {
          provisionCalls += 1;
          return provisioning.promise;
        }
        if (url.endsWith('/cats/connector/start')) return jsonResponse({ ok: true });
        return jsonResponse({ error: 'unexpected request' }, 500);
      },
    });
    const runs = Array.from({ length: 10 }, () => controller.run('startup'));
    await waitFor(() => provisionCalls === 1);
    provisioning.resolve(jsonResponse({ ok: true }));
    const snapshots = await Promise.all(runs);
    assert.equal(snapshots.every((snapshot) => snapshot.stage === 'connected'), true);
    assert.equal(statusCalls, 2);
    assert.equal(provisionCalls, 1);
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
  const provisioning = deferred<Response>();
  let provisionCalls = 0;
  let stopCalls = 0;
  try {
    const controller = new CatsConnectorAutoStart({
      port: 3800,
      runtimeRoot,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('/cats/status')) {
          return jsonResponse({ connected: true, deviceConnectorMode: false, configured: false, service: { status: 'stopped' } });
        }
        if (url.endsWith('/cats/device-connector/provision')) {
          provisionCalls += 1;
          return provisioning.promise;
        }
        if (url.endsWith('/cats/connector/stop')) {
          stopCalls += 1;
          return jsonResponse({ ok: true });
        }
        return jsonResponse({ error: 'unexpected request' }, 500);
      },
    });

    const staleRun = controller.run('startup');
    await waitFor(() => provisionCalls === 1);
    createCatsCoLocalConfigService({ runtimeRoot }).clearAccount();
    controller.invalidateAndSchedule('logout');
    provisioning.resolve(jsonResponse({ ok: true }));
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
        return jsonResponse({ connected: true, deviceConnectorMode: true, configured: true, service: { status: 'running' } });
      },
    });
    await controller.run('startup');
    assert.equal(headers.length, 2);
    assert.equal(headers.every((header) => header.get('X-API-Key') === 'dashboard-test-key'), true);
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
