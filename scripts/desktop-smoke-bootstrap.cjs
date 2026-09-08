// Included only by desktop-package-smoke.mjs, never by the release config.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow } = require('electron');
const config = JSON.parse(fs.readFileSync(path.join(process.resourcesPath, 'desktop-smoke.json'), 'utf8'));
const report = value => fs.writeFileSync(path.join(config.reportDir, `${app.getVersion()}.json`), JSON.stringify(value, null, 2));
const nativeLoads = [];
const dlopen = process.dlopen;
process.dlopen = function (module, filename, ...args) {
  nativeLoads.push(filename);
  assert.doesNotMatch(filename, /[\\/]deasync[\\/]/);
  return dlopen.call(this, module, filename, ...args);
};
process.env.XIAOBA_ELECTRON_USER_DATA_DIR = path.join(config.reportDir, 'user-data');
process.env.XIAOBA_DASHBOARD_PORT = String(config.dashboardPort);
process.env.XIAOBA_DISABLE_GPU = '1';
process.env.DASHBOARD_API_KEY = '';
process.env.XIAOBA_APP_ROOT = path.dirname(__dirname);
for (const key of ['XIAOBA_RUNTIME_ROOT', 'CATSCO_LOCAL_CONFIG_PATH', 'XIAOBA_SKILLS_DIR', 'XIAOBA_NODE_MODULES', 'NODE_PATH']) delete process.env[key];
const deadline = setTimeout(() => fail(new Error('Packaged startup/update timed out')), 180_000);
function fail(error) {
  report({ ok: false, version: app.getVersion(), error: error.stack || String(error), nativeLoads });
  app.exit(1);
}
async function probe(appRoot) {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const req = require('node:module').createRequire(path.join(appRoot, 'package.json'));
  const sharp = req('sharp');
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ffffff' } }).resize(8, 8).png().toBuffer();
  assert.equal((await sharp(png).metadata()).width, 8);
  const canvas = req('@napi-rs/canvas').createCanvas(16, 16);
  canvas.getContext('2d').fillRect(0, 0, 8, 8);
  assert.ok(canvas.toBuffer('image/png').length > 0);
  for (const name of ['deasync', 'canvas', 'path2d']) {
    assert.equal(fs.existsSync(path.join(appRoot, 'node_modules', name)), false, name);
    assert.throws(() => req(name), { code: 'MODULE_NOT_FOUND' });
  }
  return { node: process.versions.node, electron: process.versions.electron || null, sharp: true, canvas: true, excluded: true };
}
require('./main.js');
app.whenReady().then(async () => {
  let window;
  for (let i = 0; i < 600; i++) {
    window = BrowserWindow.getAllWindows()[0];
    if (window && !window.webContents.isLoading() && window.webContents.getURL().startsWith('http://127.0.0.1:')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(window, 'Dashboard window created');
  const renderer = await window.webContents.executeJavaScript('({ text: document.body.innerText.length, bridge: typeof window.catscoDesktop, require: typeof require })');
  assert.ok(renderer.text > 20, 'Dashboard rendered');
  assert.equal(renderer.bridge, 'object');
  assert.equal(renderer.require, 'undefined', 'Renderer remains isolated');
  const appRoot = path.dirname(__dirname);
  const electronNative = await probe(appRoot);
  const runtime = path.resolve(process.resourcesPath, '..', 'runtime');
  const bundledNode = path.join(runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  const child = spawnSync(bundledNode, ['-e', `(${probe.toString()})(${JSON.stringify(appRoot)}).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e);process.exit(1)})`], {
    cwd: appRoot, encoding: 'utf8', env: { ...process.env, NODE_PATH: path.join(appRoot, 'node_modules') }, timeout: 30_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const nodeNative = JSON.parse(child.stdout.trim());
  assert.equal(fs.existsSync(path.join(process.resourcesPath, 'node_modules')), false, 'No duplicate dependencies');
  const result = { ok: true, version: app.getVersion(), renderer, electronNative, nodeNative, nativeLoads };
  if (config.update && app.getVersion() === config.oldVersion) {
    const { autoUpdater } = require('electron-updater');
    const log = path.join(config.reportDir, 'differential.log');
    autoUpdater.logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, (...args) => fs.appendFileSync(log, `${level}: ${args.join(' ')}\n`)]));
    // Emulate the old installer cached by the preceding install/download.
    // Do not seed its blockmap: the real updater must fetch both blockmaps.
    const helper = await autoUpdater.getOrCreateDownloadHelper();
    fs.mkdirSync(helper.cacheDir, { recursive: true });
    fs.copyFileSync(config.oldInstaller, path.join(helper.cacheDir, 'installer.exe'));
    await autoUpdater.checkForUpdates();
    const files = await autoUpdater.downloadUpdate();
    const text = fs.readFileSync(log, 'utf8');
    assert.match(text, /Differential download/i);
    assert.doesNotMatch(text, /fallback to full download/i);
    assert.ok(files.length > 0);
    report({ ...result, downloaded: true });
    clearTimeout(deadline);
    autoUpdater.quitAndInstall(true, true);
  } else {
    report(result);
    clearTimeout(deadline);
    app.quit();
  }
}).catch(fail);
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
