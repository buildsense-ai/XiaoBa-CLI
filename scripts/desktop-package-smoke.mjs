// CI-only: real packages, native addons in both hosts, and Windows NSIS update.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This installs an isolated smoke app only on disposable GitHub runners');
const scratch = path.join(process.env.RUNNER_TEMP, 'catsco-desktop-smoke');
const reports = path.join(scratch, 'reports');
fs.mkdirSync(reports, { recursive: true });
const win = process.platform === 'win32';
const mac = process.platform === 'darwin';
const oldVersion = '0.0.1';
const newVersion = '0.0.2';
const served = new Map();
const requests = [];
let fullBytes = 0;
let rangeBytes = 0;
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(1));
  const file = served.get(name);
  if (!file) { res.writeHead(404).end(); return; }
  const size = fs.statSync(file).size;
  const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
  const start = match ? Number(match[1]) : 0;
  const end = match ? Number(match[2]) : size - 1;
  if (end >= size || start > end) { res.writeHead(416).end(); return; }
  const bytes = end - start + 1;
  requests.push({ name, range: req.headers.range || null, bytes });
  if (name.endsWith('.exe')) { if (match) rangeBytes += bytes; else fullBytes += bytes; }
  // TOS behaviour: single ranges work, multi-ranges receive the full object.
  res.writeHead(match ? 206 : 200, {
    'Content-Length': bytes, 'Accept-Ranges': 'bytes',
    ...(match ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  fs.createReadStream(file, { start, end }).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
process.env.XIAOBA_UPDATE_BASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
const configFile = path.join(scratch, 'desktop-smoke.json');
const smokeConfig = { reportDir: reports, dashboardPort: 18389, update: win, oldVersion };
const { build, Platform, Arch } = require('electron-builder');
const base = require('../electron-builder.config.cjs');
const platform = win ? Platform.WINDOWS : mac ? Platform.MAC : Platform.LINUX;
const arch = process.arch === 'arm64' ? Arch.arm64 : Arch.x64;
let child;
async function run(exe, args, options = {}) {
  const proc = spawn(exe, args, { cwd: root, stdio: 'inherit', ...options });
  await new Promise((resolve, reject) => {
    proc.once('error', reject);
    proc.once('exit', code => code === 0 ? resolve() : reject(new Error(`${exe} exited ${code}`)));
  });
}
async function packageVersion(version) {
  fs.writeFileSync(configFile, JSON.stringify(smokeConfig));
  const overrides = {
      appId: 'com.catcompany.desktop-smoke', productName: 'CatsCoSmoke',
      directories: { output: path.join(scratch, version) },
      extraMetadata: { name: 'catsco-desktop-smoke', version, main: 'electron/desktop-smoke-bootstrap.cjs' },
      files: [...base.files, { from: 'scripts/desktop-smoke-bootstrap.cjs', to: 'electron/desktop-smoke-bootstrap.cjs' }],
      extraResources: [{ from: configFile, to: 'desktop-smoke.json' }],
      nsis: { ...base.nsis, createDesktopShortcut: false, createStartMenuShortcut: false, runAfterFinish: false },
      mac: { ...base.mac, identity: null },
      afterSign: undefined,
  };
  // Pass one config file: programmatic overrides concatenate extraFiles with
  // the auto-discovered config and attempt to copy runtime symlinks twice.
  const builderConfig = path.join(scratch, 'electron-builder-smoke.cjs');
  fs.writeFileSync(builderConfig, `module.exports = { ...require(${JSON.stringify(path.join(root, 'electron-builder.config.cjs'))}), ...${JSON.stringify(overrides)} };`);
  return build({
    targets: platform.createTarget(win ? ['nsis'] : mac ? ['dmg', 'zip'] : ['AppImage', 'deb'], arch),
    publish: 'never', config: builderConfig,
  });
}
async function waitForReport(version) {
  const filename = path.join(reports, `${version}.json`);
  for (let i = 0; i < 2400; i++) {
    if (fs.existsSync(filename)) {
      const report = JSON.parse(fs.readFileSync(filename));
      assert.equal(report.ok, true, JSON.stringify(report));
      return report;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`No successful startup report for ${version}`);
}
try {
  if (win) {
    // Both installers are independent builds of the PR, not a blockmap planner.
    const oldInstaller = path.join(scratch, oldVersion, `CatsCoSmoke-${oldVersion}-win.exe`);
    smokeConfig.oldInstaller = oldInstaller;
    const oldFiles = await packageVersion(oldVersion);
    const nextFiles = await packageVersion(newVersion);
    for (const file of [...oldFiles, ...nextFiles]) if (fs.existsSync(file)) served.set(path.basename(file), file);
    for (const version of [oldVersion, newVersion]) {
      const dir = path.join(scratch, version);
      for (const name of fs.readdirSync(dir)) if (/\.blockmap$|^latest\.yml$/.test(name)) served.set(name, path.join(dir, name));
    }
    assert.ok(served.has('latest.yml'));
    const installer = nextFiles.find(file => file.endsWith('.exe'));
    const installDir = path.join(scratch, 'installed');
    await run(oldInstaller, ['/S', `/D=${installDir}`]);
    const appExe = path.join(installDir, 'CatsCoSmoke.exe');
    assert.ok(fs.existsSync(appExe), 'Old NSIS installation completed');
    const log = fs.openSync(path.join(reports, 'app.log'), 'w');
    child = spawn(appExe, [], { cwd: installDir, stdio: ['ignore', log, log] });
    await waitForReport(oldVersion);
    await waitForReport(newVersion);
    const total = fs.statSync(installer).size;
    assert.equal(fullBytes, 0, 'Must not silently fall back to a full EXE download');
    assert.ok(rangeBytes > 0 && rangeBytes < total * 0.5, `Delta ${rangeBytes}/${total} must be below 50%`);
    const result = { oldVersion, newVersion, fullInstallerBytes: total, downloadedExeBytes: rangeBytes, ratio: rangeBytes / total, fullBytes, requests };
    fs.writeFileSync(path.join(reports, 'update-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } else {
    const files = await packageVersion(newVersion);
    let executable;
    if (mac) {
      const zip = files.find(file => file.endsWith('.zip'));
      const extracted = path.join(scratch, 'extracted');
      await run('ditto', ['-x', '-k', zip, extracted]);
      executable = path.join(extracted, 'CatsCoSmoke.app', 'Contents', 'MacOS', 'CatsCoSmoke');
    } else {
      const appImage = files.find(file => file.endsWith('.AppImage'));
      await run(appImage, ['--appimage-extract'], { cwd: scratch });
      executable = path.join(scratch, 'squashfs-root', 'AppRun');
    }
    const log = fs.openSync(path.join(reports, 'app.log'), 'w');
    child = spawn(executable, ['--no-sandbox'], { cwd: scratch, stdio: ['ignore', log, log] });
    await waitForReport(newVersion);
    console.log(fs.readFileSync(path.join(reports, `${newVersion}.json`), 'utf8'));
  }
} finally {
  server.close();
  if (child && child.exitCode === null) child.kill();
  // Runner disposal removes installation/cache; reports survive via artifact upload.
}
