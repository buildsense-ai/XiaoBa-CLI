import assert from 'node:assert/strict';
import { createReadStream, existsSync } from 'node:fs';
import { createServer, type AddressInfo, type ServerResponse } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

const rootDir = process.cwd();
const hasLocalChromium = existsSync(chromium.executablePath());
const skipWithoutBrowser = !hasLocalChromium && process.env.CI !== 'true';

test(
  'dashboard React shell syncs page state in a real browser',
  { skip: skipWithoutBrowser ? 'Playwright Chromium is not installed locally; CI installs and runs this smoke test.' : false },
  async t => {
  const server = await startDashboardServer();
  const browser = await chromium.launch({ timeout: 30_000 });
  t.after(async () => {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  const address = server.address() as AddressInfo;
  await page.goto(`http://127.0.0.1:${address.port}/dashboard/index.html`);
  await page.waitForSelector('#dashboard-app-root[data-react-shell="mounted"]');
  await page.waitForSelector('#floating-pet');

  assert.equal(await page.textContent('.sidebar-brand-ver'), 'v1.2.0');
  assert.equal(await page.evaluate(() => document.body.classList.contains('chat-active')), true);
  assert.equal(await page.evaluate(() => document.body.classList.contains('companion-active')), false);
  const mainRect = await page.locator('.main-wrapper').boundingBox();
  assert.ok(mainRect);
  assert.ok(
    mainRect.x + mainRect.width >= 1260,
    `chat main wrapper should fill the viewport width, got right edge ${mainRect.x + mainRect.width}`,
  );

  await page.click('a[href="#companion"]');
  await page.waitForFunction(() => document.body.classList.contains('companion-active'));
  assert.equal(await page.evaluate(() => document.body.classList.contains('chat-active')), false);
  assert.equal(await page.locator('#floating-pet').evaluate(element => getComputedStyle(element).display), 'none');

  await page.click('a[href="#prompts"]');
  await page.waitForFunction(() => document.querySelector('#page-prompts')?.classList.contains('active'));
  await page.waitForSelector('#prompt-workbench[data-react-prompt-workbench="mounted"]');
  assert.equal(await page.locator('#prompt-editor-textarea').inputValue(), 'You are CatsCo.');

  await page.evaluate(() => window.openCustomModelFromChat?.());
  await page.waitForFunction(() => document.querySelector('#page-services')?.classList.contains('active'));
  await page.waitForFunction(() => document.querySelector<HTMLDetailsElement>('#model-source-panel details')?.open === true);

  assert.deepEqual(pageErrors, []);
});

async function startDashboardServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      sendJson(res, apiResponse(url.pathname));
      return;
    }

    const relativePath = decodeURIComponent(url.pathname === '/' ? '/dashboard/index.html' : url.pathname).replace(/^\/+/, '');
    const filePath = path.resolve(rootDir, relativePath);
    if (!isInsideRoot(filePath) || !existsSync(filePath)) {
      res.writeHead(404).end('not found');
      return;
    }

    res.writeHead(200, { 'Content-Type': contentType(filePath) });
    createReadStream(filePath).pipe(res);
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  return server;
}

function sendJson(res: ServerResponse, body: unknown) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function apiResponse(pathname: string) {
  if (pathname === '/api/status') return { version: '1.2.0', services: [] };
  if (pathname === '/api/readiness') return { status: 'ready', checks: [] };
  if (pathname === '/api/skills-all') return [];
  if (pathname === '/api/config') return {};
  if (pathname === '/api/settings') {
    return {
      fields: [
        { id: 'model.provider', value: 'anthropic' },
        { id: 'model.apiBase', value: '' },
        { id: 'model.model', value: '' },
        { id: 'model.apiKey', present: false },
      ],
      modelStartup: {},
    };
  }
  if (pathname === '/api/cats/relay/model-config') return { configured: false, models: [] };
  if (pathname === '/api/prompts') {
    return {
      base_dir: 'app/prompts',
      branch_agents: { enabled: true, env_key: 'XIAOBA_BRANCH_AGENTS_ENABLED' },
      files: [
        {
          path: 'system-prompt.md',
          overridden: false,
          base: { chars: 15, lines: 1, short_hash: 'base12345678' },
          effective: { chars: 15, lines: 1, short_hash: 'eff123456789' },
        },
      ],
      overrides_dir: 'C:/tmp/prompts',
      trace: {
        bundle: { file_count: 1, short_hash: 'bundle123456' },
        generated_at: '2026-07-01T00:00:00.000Z',
        prompt_version: 'local',
        source: 'prompt-editor',
        system: { chars: 15, lines: 1, short_hash: 'system123456' },
      },
      writable: true,
    };
  }
  if (pathname === '/api/prompts/file') {
    return {
      path: 'system-prompt.md',
      overridden: false,
      base: { chars: 15, lines: 1, short_hash: 'base12345678' },
      effective: { chars: 15, lines: 1, short_hash: 'eff123456789' },
      base_content: 'You are CatsCo.',
      content: 'You are CatsCo.',
    };
  }
  if (pathname === '/api/cats/status') {
    return {
      connected: false,
      configured: false,
      service: { status: 'stopped' },
      bodyStatus: { state: 'stopped' },
    };
  }
  if (pathname === '/api/skillhub/status') return { authenticated: false, roles: [], permissions: [], installed: [], trustReady: true };
  if (pathname === '/api/update/status') return { enabled: false, stage: 'idle', currentVersion: '1.2.0' };
  if (pathname === '/api/pet/status') return { level: 1, title: 'New companion', form: 'Basic cat' };
  if (pathname === '/api/pet/timeline') return { events: [] };
  if (pathname === '/api/pet/progress') return { level: 1, total_xp: 0, skill_stats: [] };
  return {};
}

function isInsideRoot(filePath: string) {
  const root = path.resolve(rootDir);
  return filePath === root || filePath.startsWith(root + path.sep);
}

function contentType(filePath: string) {
  switch (path.extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.png':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
}
