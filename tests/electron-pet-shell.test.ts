import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const electronMain = readFileSync(join(root, 'electron/main.js'), 'utf-8');
const applicationMenu = readFileSync(join(root, 'electron/application-menu.js'), 'utf-8');
const petIpc = readFileSync(join(root, 'electron/pet-ipc.js'), 'utf-8');
const petMenu = readFileSync(join(root, 'electron/pet-menu.js'), 'utf-8');
const petWindowModule = readFileSync(join(root, 'electron/pet-window.js'), 'utf-8');
const runtimeData = readFileSync(join(root, 'electron/runtime-data.js'), 'utf-8');
const trayModule = readFileSync(join(root, 'electron/tray.js'), 'utf-8');
const preload = readFileSync(join(root, 'electron/preload.js'), 'utf-8');
const dashboardHtml = readFileSync(join(root, 'dashboard/index.html'), 'utf-8');
const petWindowPath = join(root, 'dashboard/pet-window.html');
const desktopCompanionManagerPath = join(root, 'electron/desktop-companion-manager.js');
const desktopCompanionManager = existsSync(desktopCompanionManagerPath)
  ? readFileSync(desktopCompanionManagerPath, 'utf-8')
  : '';

test('electron launches the pet shell first while keeping dashboard hidden until requested', () => {
  const startupBlock = electronMain.slice(
    electronMain.indexOf('dashboardServerReady = true;'),
    electronMain.indexOf('enqueueDeepLinkFromArgv(process.argv);'),
  );

  assert.match(electronMain, /createPetWindowController/);
  assert.match(electronMain, /function createPetWindow\(\)/);
  assert.match(startupBlock, /ensureDesktopCompanionShell\(\);/);
  assert.match(startupBlock, /createPetWindow\(\);/);
  assert.doesNotMatch(startupBlock, /createWindow\(\);/);
});

test('pet shell is a transparent always-on-top desktop companion window', () => {
  assert.match(petWindowModule, /petWindow = new BrowserWindow\(\{[\s\S]*transparent: true/);
  assert.match(petWindowModule, /petWindow = new BrowserWindow\(\{[\s\S]*frame: false/);
  assert.match(petWindowModule, /getWindowBehaviorOptions\(\)/);
  assert.match(petWindowModule, /petWindow = new BrowserWindow\(\{[\s\S]*skipTaskbar: true/);
  assert.match(petWindowModule, /petWindow\.loadURL\(`http:\/\/127\.0\.0\.1:\$\{dashboardPort\}\/pet-window\.html`\)/);
});

test('pet shell can be dragged and remembers its last desktop position', () => {
  const petWindow = readFileSync(petWindowPath, 'utf-8');

  assert.equal(existsSync(desktopCompanionManagerPath), true);
  assert.match(desktopCompanionManager, /function createDesktopCompanionManager/);
  assert.match(desktopCompanionManager, /DEFAULT_SNAP_DISTANCE = 28/);
  assert.match(desktopCompanionManager, /setLockPetPosition/);
  assert.match(desktopCompanionManager, /setAlwaysOnTop/);
  assert.match(petWindowModule, /manager\.getInitialBounds/);
  assert.match(petWindowModule, /manager\.attachPetWindow\(petWindow\)/);
  assert.match(petWindow, /pet-drag-region/);
  assert.match(petWindow, /-webkit-app-region: drag/);
  assert.match(petWindow, /-webkit-app-region: no-drag/);
  assert.match(petWindow, /position-locked/);
  assert.match(petWindow, /#pet-shell\.position-locked\.pet-drag-region/);
});

test('dashboard minimize hides the dashboard and keeps the pet as the desktop entry', () => {
  const dashboardWindowBlock = electronMain.slice(
    electronMain.indexOf('function createWindow(targetPath)'),
    electronMain.indexOf('function isTrustedDashboardUrl(value)'),
  );

  assert.match(dashboardWindowBlock, /mainWindow\.on\('minimize'/);
  assert.match(dashboardWindowBlock, /event\.preventDefault\(\)/);
  assert.match(dashboardWindowBlock, /mainWindow\.hide\(\)/);
  assert.match(dashboardWindowBlock, /showPetWindow\(\)/);
});

test('pet shell exposes safe actions for dashboard, CatsCo web, menu, and startup preference', () => {
  assert.match(electronMain, /function openDashboardFromPet\(targetPath\)/);
  assert.match(electronMain, /function openCatsCoWebFromPet\(\)/);
  assert.match(electronMain, /function showPetContextMenu\(\)/);
  assert.match(electronMain, /function getDesktopCompanionManager\(\)/);
  assert.match(petIpc, /catsco:pet:open-dashboard/);
  assert.match(petIpc, /catsco:pet:open-catsco-web/);
  assert.match(petIpc, /catsco:pet:show-menu/);
  assert.match(petIpc, /catsco:pet:get-state/);
  assert.match(petMenu, /label: 'Open Dashboard'/);
  assert.match(petMenu, /label: 'Open CatsCo Web'/);
  assert.match(desktopCompanionManager, /app\.setLoginItemSettings\(\{/);
  assert.match(desktopCompanionManager, /function syncWindowsRunAtLoginFallback\(\)/);
  assert.match(electronMain, /function ensureStartAtLoginRegistration\(\)/);
  assert.match(desktopCompanionManager, /HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run/);
  assert.match(desktopCompanionManager, /spawnSync\('reg'/);
  assert.match(electronMain, /ensureStartAtLoginRegistration\(\);/);
  assert.match(electronMain, /CATSCO_WEB_URL/);
  assert.match(electronMain, /CATSCO_HTTP_BASE_URL/);

  assert.match(preload, /catscoPet/);
  assert.match(preload, /openDashboard/);
  assert.match(preload, /openCatsCoWeb/);
  assert.match(preload, /showMenu/);
  assert.match(preload, /setStartAtLogin/);
  assert.match(preload, /setLockPetPosition/);
  assert.match(preload, /setAlwaysOnTop/);
  assert.match(preload, /onDesktopStateChanged/);
});

test('changing start at login syncs the OS registration immediately', () => {
  const ipcBlock = petIpc.slice(
    petIpc.indexOf("ipcMain.handle('catsco:pet:set-start-at-login'"),
    petIpc.indexOf("ipcMain.handle('catsco:pet:set-lock-position'"),
  );
  const menuBlock = petMenu.slice(
    petMenu.indexOf("label: 'Start With System'"),
    petMenu.indexOf("{ label: 'Quit CatsCo'"),
  );

  assert.match(ipcBlock, /getDesktopCompanionManager\(\)\.setStartAtLogin\(Boolean\(value\)\)/);
  assert.match(menuBlock, /manager\.setStartAtLogin\(menuItem\.checked\)/);
});

test('electron desktop shell responsibilities are split into focused modules', () => {
  assert.match(electronMain, /require\('\.\/application-menu'\)/);
  assert.match(electronMain, /require\('\.\/runtime-data'\)/);
  assert.match(electronMain, /require\('\.\/pet-ipc'\)/);
  assert.match(electronMain, /require\('\.\/pet-menu'\)/);
  assert.match(electronMain, /require\('\.\/pet-window'\)/);
  assert.match(electronMain, /require\('\.\/tray'\)/);
  assert.match(applicationMenu, /function createApplicationMenu/);
  assert.match(runtimeData, /function openAttachmentCacheDirectory/);
  assert.match(petWindowModule, /function createPetWindowController/);
  assert.match(petIpc, /function registerPetIpcHandlers/);
  assert.match(petMenu, /function createPetMenu/);
  assert.match(trayModule, /function createCompanionTray/);
});

test('pet shell page exists and talks to the existing pet APIs', () => {
  assert.equal(existsSync(petWindowPath), true);
  const petWindow = readFileSync(petWindowPath, 'utf-8');

  assert.match(petWindow, /id="pet-shell"/);
  assert.match(petWindow, /pet\/manifest\.json/);
  assert.match(petWindow, /\/api\/pet\/status/);
  assert.match(petWindow, /\/api\/pet\/timeline/);
  assert.match(petWindow, /\/api\/pet\/prompt-proposal/);
  assert.match(petWindow, /\/api\/pet\/skill-recommendations/);
  assert.match(petWindow, /\/api\/pet\/skill-drafts/);
  assert.match(petWindow, /\/api\/pet\/skill-drafts\/apply/);
  assert.match(petWindow, /\/api\/pet\/daily-report/);
  assert.match(petWindow, /\/api\/pet\/daily-report\/save/);
  assert.match(petWindow, /id="daily-report-card"/);
  assert.match(petWindow, /previewDailyReport/);
  assert.match(petWindow, /saveDailyReport/);
  assert.match(petWindow, /id="dismiss-daily-report"/);
  assert.match(petWindow, /dismissDailyReport/);
  assert.match(petWindow, /dailyReportDecisionKey/);
  assert.match(petWindow, /showDailyReportAlert/);
  assert.match(petWindow, /resolveLevelFrames/);
  assert.match(petWindow, /idle_active/);
  assert.match(petWindow, /notify/);
  assert.match(petWindow, /sleepy/);
  assert.match(petWindow, /skill/);
  assert.match(petWindow, /catsco:daily-report-alert/);
  assert.match(petWindow, /昨天的日报我整理好啦/);
  assert.match(petWindow, /id="skill-draft-card"/);
  assert.match(petWindow, /applySkillDraft/);
  assert.match(petWindow, /id="dismiss-skill-draft"/);
  assert.match(petWindow, /dismissSkillDraft/);
  assert.match(petWindow, /skillDraftDecisionKey/);
  assert.match(petWindow, /id="work-feed"/);
  assert.match(petWindow, /id="work-alert"/);
  assert.match(petWindow, /work-title/);
  assert.match(petWindow, /renderWorkFeed/);
  assert.match(petWindow, /showWorkAlert/);
  assert.match(petWindow, /seenTimelineEventIds/);
  assert.match(petWindow, /\/#logs/);
  assert.match(petWindow, /catscoPet\.openDashboard/);
  assert.match(petWindow, /catscoPet\.openCatsCoWeb/);
  assert.match(petWindow, /id="lock-position"/);
  assert.match(petWindow, /id="always-on-top"/);
  assert.match(petWindow, /setLockPetPosition/);
  assert.match(petWindow, /setAlwaysOnTop/);
});

test('pet shell keeps primary entry actions visible when report and skill cards are pending', () => {
  const petWindow = readFileSync(petWindowPath, 'utf-8');

  assert.match(petWindow, /class="panel-scroll"/);
  assert.ok(petWindow.indexOf('class="actions"') < petWindow.indexOf('class="panel-scroll"'));
  assert.ok(petWindow.indexOf('id="daily-report-card"') > petWindow.indexOf('class="panel-scroll"'));
  assert.ok(petWindow.indexOf('id="skill-draft-card"') > petWindow.indexOf('class="panel-scroll"'));
  assert.match(petWindow, /\.panel[\s\S]*max-height:/);
  assert.match(petWindow, /\.panel-scroll[\s\S]*overflow-y: auto/);
});

test('message completion still drives companion emotion and alert bubbles', () => {
  const petWindow = readFileSync(petWindowPath, 'utf-8');
  const alertBlock = petWindow.slice(
    petWindow.indexOf('function shouldAlertEvent(event)'),
    petWindow.indexOf('function showWorkAlert(event)'),
  );
  const dashboardEventStateBlock = dashboardHtml.slice(
    dashboardHtml.indexOf('function petEventState(event)'),
    dashboardHtml.indexOf('function renderPetUnlocks()'),
  );

  assert.doesNotMatch(alertBlock, /event\.event_type === 'message_completed'\)\s*return false/);
  assert.match(dashboardEventStateBlock, /event\.event_type === 'message_completed'[\s\S]*return 'success'/);
});

test('dashboard keeps session logs available without exposing them as a primary nav item', () => {
  assert.doesNotMatch(dashboardHtml, /<a class="nav-item" onclick="switchPage\('logs'\)" data-page="logs">/);
  assert.match(dashboardHtml, /id="page-logs"/);
  assert.match(dashboardHtml, /\/api\/sessions\/recent/);
  assert.match(dashboardHtml, /\/api\/sessions\//);
  assert.match(dashboardHtml, /location\.hash/);
});

test('dashboard companion preview loads the shared pet manifest instead of maintaining a second frame list', () => {
  assert.doesNotMatch(dashboardHtml, /const petFrames = \{/);
  assert.match(dashboardHtml, /async function loadPetManifest/);
  assert.match(dashboardHtml, /pet\/manifest\.json/);
  assert.match(dashboardHtml, /petFrameFallbacks/);
});
