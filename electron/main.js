const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const DASHBOARD_PORT = resolveDashboardPort(process.env.XIAOBA_DASHBOARD_PORT);
const DEEP_LINK_PROTOCOL = 'catsco';
const TRUSTED_DEEP_LINK_BASE_ORIGINS = new Set(['https://app.catsco.cc']);
const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const START_AT_LOGIN_RUN_VALUE = 'CatsCo Companion';
let mainWindow = null;
let petWindow = null;
let tray = null;
let autoUpdater = null;
let dashboardServerHandle = null;
let hideNoticeShown = false;
let dashboardServerReady = false;
const pendingDeepLinks = [];
let deepLinkDrainPromise = null;

applyConfiguredUserDataPath();

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    enqueueDeepLinkFromArgv(argv);
    showMainWindow();
  });
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  enqueueDeepLink(url);
  showMainWindow();
});

function resolveDashboardPort(value) {
  const text = String(value || '').trim();
  if (!/^\d+$/.test(text)) return 3800;
  const port = Number.parseInt(text, 10);
  if (port < 1 || port > 65535) return 3800;
  return port;
}

function applyConfiguredUserDataPath() {
  const configuredUserDataDir = String(process.env.XIAOBA_ELECTRON_USER_DATA_DIR || '').trim();
  if (!configuredUserDataDir) return;

  const resolvedUserDataDir = path.resolve(configuredUserDataDir);
  fs.mkdirSync(resolvedUserDataDir, { recursive: true });
  app.setPath('userData', resolvedUserDataDir);
}

function readDesktopConfig() {
  try {
    const configPath = path.join(process.cwd(), '.xiaoba', 'catsco.json');
    if (!fs.existsSync(configPath)) return {};
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_error) {
    return {};
  }
}

function writePreferencePatch(patch) {
  const configPath = path.join(process.cwd(), '.xiaoba', 'catsco.json');
  const configDir = path.dirname(configPath);
  const config = readDesktopConfig();

  const next = {
    ...config,
    version: config.version || 1,
    preferences: {
      ...config.preferences,
      autoConnect: config.preferences?.autoConnect ?? true,
      switchConfirmEnabled: config.preferences?.switchConfirmEnabled ?? true,
      ...patch,
    },
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function readCloseToTrayPreference() {
  const value = readDesktopConfig()?.preferences?.closeToTray;
  return value !== false;
}

function writeCloseToTrayPreference(closeToTray) {
  writePreferencePatch({ closeToTray: Boolean(closeToTray) });
}

function readStartAtLoginPreference() {
  return Boolean(readDesktopConfig()?.preferences?.startAtLogin);
}

function writeStartAtLoginPreference(startAtLogin) {
  writePreferencePatch({ startAtLogin: Boolean(startAtLogin) });
  syncLoginItemSettings();
}

function getStartAtLoginLaunchArgs() {
  if (process.defaultApp && process.argv.length >= 2) {
    return [path.resolve(process.argv[1])];
  }
  return [];
}

function getStartAtLoginCommandLine() {
  const quote = (value) => `"${String(value || '').replace(/"/g, '\\"')}"`;
  return [process.execPath, ...getStartAtLoginLaunchArgs()].map(quote).join(' ');
}

function readPetWindowBounds() {
  return sanitizePetWindowBounds(readDesktopConfig()?.preferences?.petWindowBounds);
}

function savePetWindowBounds(bounds) {
  const next = sanitizePetWindowBounds(bounds);
  if (!next) return;
  writePreferencePatch({ petWindowBounds: next });
}

function sanitizePetWindowBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;

  const width = Number(bounds.width);
  const height = Number(bounds.height);
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  if (![width, height, x, y].every(Number.isFinite)) return null;

  const display = screen.getDisplayMatching({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  }) || screen.getPrimaryDisplay();
  const { workArea } = display;
  const minVisible = 64;
  const safeWidth = Math.max(240, Math.min(Math.round(width), workArea.width));
  const safeHeight = Math.max(440, Math.min(Math.round(height), workArea.height));
  const minX = workArea.x - safeWidth + minVisible;
  const maxX = workArea.x + workArea.width - minVisible;
  const minY = workArea.y;
  const maxY = workArea.y + workArea.height - minVisible;

  return {
    x: Math.round(Math.min(Math.max(x, minX), maxX)),
    y: Math.round(Math.min(Math.max(y, minY), maxY)),
    width: safeWidth,
    height: safeHeight,
  };
}

function syncLoginItemSettings() {
  const openAtLogin = readStartAtLoginPreference();
  try {
    app.setLoginItemSettings({
      openAtLogin,
      openAsHidden: false,
      ...(getStartAtLoginLaunchArgs().length > 0
        ? { path: process.execPath, args: getStartAtLoginLaunchArgs() }
        : {}),
    });
  } catch (error) {
    console.warn('Failed to sync start-at-login preference:', error?.message || error);
  }
  syncWindowsRunAtLoginFallback();
}

function syncWindowsRunAtLoginFallback() {
  if (process.platform !== 'win32') return;
  const openAtLogin = readStartAtLoginPreference();
  const args = openAtLogin
    ? ['add', WINDOWS_RUN_KEY, '/v', START_AT_LOGIN_RUN_VALUE, '/t', 'REG_SZ', '/d', getStartAtLoginCommandLine(), '/f']
    : ['delete', WINDOWS_RUN_KEY, '/v', START_AT_LOGIN_RUN_VALUE, '/f'];
  const result = spawnSync('reg', args, { windowsHide: true, stdio: 'ignore' });
  if (result.error && openAtLogin) {
    console.warn('Failed to sync Windows start-at-login fallback:', result.error.message || result.error);
  }
}

function ensureStartAtLoginRegistration() {
  syncLoginItemSettings();
}

function showMainWindow(targetPath) {
  const targetUrl = buildDashboardUrl(targetPath);
  if (mainWindow) {
    if (targetPath) mainWindow.loadURL(targetUrl);
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow(targetPath);
  }
}

function showPetWindow() {
  if (petWindow) {
    petWindow.show();
    petWindow.focus();
  } else {
    createPetWindow();
  }
}

function getDashboardUrl() {
  return `http://127.0.0.1:${DASHBOARD_PORT}`;
}

function buildDashboardUrl(targetPath) {
  const base = getDashboardUrl();
  const text = String(targetPath || '').trim();
  if (!text) return base;
  if (text.startsWith('#')) return `${base}/${text}`;
  if (text.startsWith('/')) return `${base}${text}`;
  return base;
}

function resolveCatsCoWebUrl() {
  return normalizeHttpUrl(process.env.CATSCO_WEB_URL)
    || normalizeHttpUrl(process.env.CATSCO_HTTP_BASE_URL)
    || 'https://app.catsco.cc';
}

function openDashboardFromPet(targetPath) {
  showMainWindow(targetPath);
}

function openCatsCoWebFromPet() {
  shell.openExternal(resolveCatsCoWebUrl()).catch((error) => {
    console.warn('Failed to open CatsCo Web:', error?.message || error);
  });
}

function isCatsCoDeepLink(value) {
  return typeof value === 'string' && value.toLowerCase().startsWith(`${DEEP_LINK_PROTOCOL}://`);
}

function enqueueDeepLinkFromArgv(argv) {
  const link = (argv || []).find(isCatsCoDeepLink);
  if (link) enqueueDeepLink(link);
}

function enqueueDeepLink(value) {
  if (!isCatsCoDeepLink(value)) return;
  pendingDeepLinks.push(value);
  if (dashboardServerReady) {
    scheduleDeepLinkDrain();
  }
}

function scheduleDeepLinkDrain() {
  if (deepLinkDrainPromise) return deepLinkDrainPromise;
  deepLinkDrainPromise = drainPendingDeepLinks()
    .catch((error) => {
      console.error('[desktop-connect] failed to process pending deep links:', error);
    })
    .finally(() => {
      deepLinkDrainPromise = null;
      if (pendingDeepLinks.length > 0) scheduleDeepLinkDrain();
    });
  return deepLinkDrainPromise;
}

function registerDeepLinkProtocol() {
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL);
    }
  } catch (error) {
    console.warn('[desktop-connect] failed to register catsco:// protocol:', error?.message || error);
  }
}

async function drainPendingDeepLinks() {
  while (pendingDeepLinks.length > 0) {
    const link = pendingDeepLinks.shift();
    await processDeepLink(link);
  }
}

function isLoopbackDeepLinkHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function trustedDeepLinkBase(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch (_error) {
    return '';
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    return '';
  }
  if (TRUSTED_DEEP_LINK_BASE_ORIGINS.has(url.origin)) {
    return url.origin;
  }
  if (!app.isPackaged && url.protocol === 'http:' && isLoopbackDeepLinkHost(url.hostname)) {
    return url.origin;
  }
  return '';
}

async function processDeepLink(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_error) {
    return;
  }
  const action = parsed.hostname || parsed.pathname.replace(/^\/+/, '');
  if (action !== 'connect') return;
  const code = parsed.searchParams.get('code');
  if (!code) return;
  const rawBase = parsed.searchParams.get('base') || '';
  const base = trustedDeepLinkBase(rawBase);
  if (rawBase && !base) {
    console.warn('[desktop-connect] ignored untrusted CatsCo base:', rawBase);
  }
  const desktopConnectBody = {
    code,
    ...(base ? { httpBaseUrl: base } : {}),
  };
  const localApiBase = `http://127.0.0.1:${DASHBOARD_PORT}/api`;
  await postLocalJson(`${localApiBase}/cats/desktop-connect`, desktopConnectBody);
  await postLocalJson(`${localApiBase}/cats/setup`, {});
  showMainWindow();
}

async function postLocalJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`POST ${url} failed: ${response.status} ${text}`);
  }
  return response.json().catch(() => ({}));
}

function createTrayIcon() {
  const appRoot = getAppRoot();
  const candidates = process.platform === 'win32'
    ? ['build-resources/icon.ico', 'build-resources/icons/icon.ico', 'build-resources/icons/32x32.png', 'dashboard/cat-icon.png']
    : ['build-resources/icons/32x32.png', 'build-resources/icon.png', 'dashboard/cat-icon.png'];

  for (const relativePath of candidates) {
    const iconPath = path.join(appRoot, relativePath);
    if (!fs.existsSync(iconPath)) continue;
    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) {
      return image.resize({ width: 16, height: 16 });
    }
  }

  return nativeImage
    .createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAABhSURBVFhH7c6xDQAgDASwkP2XZgEqCgrZwJ+u8Ov1vt+RM0EHHXTQQQcddNBBBx100EEHHXTQQQcddNBBBx100EEHHXTQQQcddNBBBx100EEHHXTQQQcddNBBBx3834kDK+kAIRUXPjcAAAAASUVORK5CYII=')
    .resize({ width: 16, height: 16 });
}

function notifyWindowHidden() {
  if (hideNoticeShown || !tray || process.platform !== 'win32' || typeof tray.displayBalloon !== 'function') return;
  hideNoticeShown = true;
  tray.displayBalloon({
    title: 'CatsCo 已在后台运行',
    content: '点击右下角 CatsCo 图标可恢复窗口。',
    icon: createTrayIcon(),
  });
}

// 闂佽绻愮换鎴犳崲閸℃稒鍎婃い鏍仜缁€澶愭煟濡厧鍔嬬紒?electron-updater闂備焦瀵х粙鎴︽偋閸℃哎浜归柡灞诲劜閻掕顭块懜鐢点€掔紒鈧?
try {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
} catch (err) {
  console.log('electron-updater not available, auto-update disabled');
}


function normalizeUrl(value) {
  if (!value) return null;
  return String(value).trim().replace(/\/+$/, '');
}

function normalizeHttpUrl(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    return (url.protocol === 'http:' || url.protocol === 'https:') ? normalized : null;
  } catch (_error) {
    return null;
  }
}

function resolveReleasePageUrl() {
  try {
    const packageJsonPath = path.join(getAppRoot(), 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const publishConfig = Array.isArray(packageJson.build?.publish)
      ? packageJson.build.publish.find((item) => item?.provider === 'github')
      : packageJson.build?.publish;

    if (publishConfig?.owner && publishConfig?.repo) {
      return `https://github.com/${publishConfig.owner}/${publishConfig.repo}/releases/latest`;
    }
  } catch (_error) {
    return null;
  }

  return null;
}

function readPackagedUpdateBaseUrl() {
  if (!app.isPackaged) return null;

  try {
    const updateConfigPath = path.join(process.resourcesPath, 'app-update.yml');
    if (!fs.existsSync(updateConfigPath)) return null;

    const configContent = fs.readFileSync(updateConfigPath, 'utf8');
    const match = configContent.match(/^\s*url:\s*(.+)\s*$/m);
    if (!match) return null;

    return normalizeUrl(match[1].replace(/^['"]|['"]$/g, ''));
  } catch (_error) {
    return null;
  }
}

function resolveUpdateBaseUrl() {
  return normalizeUrl(process.env.XIAOBA_UPDATE_BASE_URL) || readPackagedUpdateBaseUrl();
}

const updateState = {
  enabled: Boolean(autoUpdater),
  stage: autoUpdater ? 'idle' : 'disabled',
  message: autoUpdater ? 'Updater is ready' : 'Updater is unavailable',
  currentVersion: app.getVersion(),
  availableVersion: null,
  releaseNotes: null,
  releasePageUrl: resolveReleasePageUrl(),
  updateBaseUrl: resolveUpdateBaseUrl(),
  percent: 0,
  bytesPerSecond: 0,
  transferred: 0,
  total: 0,
  checkedAt: null,
  updatedAt: Date.now(),
  isManualCheck: false,
  lastError: null,
};

let checkInFlight = null;
let downloadInFlight = null;

function getUpdateStatusSnapshot() {
  return { ...updateState };
}

function setUpdateState(patch) {
  Object.assign(updateState, patch, {
    currentVersion: app.getVersion(),
    updatedAt: Date.now(),
  });
}

function normalizeUpdateError(error, fallbackReason = 'UPDATE_ERROR') {
  const message = String(error?.message || error || 'Unknown update error').trim();
  let reason = fallbackReason;

  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    reason = 'DNS_LOOKUP_FAILED';
  } else if (/ETIMEDOUT|timeout/i.test(message)) {
    reason = 'NETWORK_TIMEOUT';
  } else if (/ECONNREFUSED|ECONNRESET|socket hang up/i.test(message)) {
    reason = 'NETWORK_CONNECTION_FAILED';
  } else if (/401|403|unauthorized|forbidden/i.test(message)) {
    reason = 'ACCESS_DENIED';
  } else if (/404|not\s*found/i.test(message)) {
    reason = 'RELEASE_NOT_FOUND';
  } else if (/sha|checksum|signature|integrity/i.test(message)) {
    reason = 'PACKAGE_VALIDATION_FAILED';
  }

  return { reason, message };
}

function markUpdateError(error, fallbackReason = 'UPDATE_ERROR') {
  const normalized = normalizeUpdateError(error, fallbackReason);
  setUpdateState({
    stage: 'error',
    message: 'Update failed: ' + normalized.reason,
    lastError: normalized,
  });

  const wrapped = new Error(normalized.message);
  wrapped.reason = normalized.reason;
  return wrapped;
}

const updateController = {
  getStatus() {
    return getUpdateStatusSnapshot();
  },

  async checkForUpdates(manual = false) {
    if (!autoUpdater) {
      return getUpdateStatusSnapshot();
    }

    if (checkInFlight) {
      return checkInFlight;
    }

    setUpdateState({
      stage: 'checking',
      message: manual ? 'Checking for updates...' : 'Checking for updates in background...',
      isManualCheck: Boolean(manual),
      checkedAt: Date.now(),
      lastError: null,
    });

    checkInFlight = autoUpdater
      .checkForUpdates()
      .then(() => getUpdateStatusSnapshot())
      .catch((error) => {
        throw markUpdateError(error, 'UPDATE_CHECK_FAILED');
      })
      .finally(() => {
        checkInFlight = null;
      });

    return checkInFlight;
  },

  async downloadUpdate() {
    if (!autoUpdater) {
      throw markUpdateError(new Error('Updater is unavailable'), 'UPDATER_UNAVAILABLE');
    }

    if (downloadInFlight) {
      return downloadInFlight;
    }

    if (updateState.stage !== 'available' && updateState.stage !== 'downloading') {
      throw markUpdateError(new Error('No available update to download'), 'UPDATE_NOT_AVAILABLE');
    }

    setUpdateState({
      stage: 'downloading',
      message: 'Starting update download...',
      percent: 0,
      bytesPerSecond: 0,
      transferred: 0,
      total: 0,
      lastError: null,
    });

    downloadInFlight = autoUpdater
      .downloadUpdate()
      .then(() => getUpdateStatusSnapshot())
      .catch((error) => {
        throw markUpdateError(error, 'UPDATE_DOWNLOAD_FAILED');
      })
      .finally(() => {
        downloadInFlight = null;
      });

    return downloadInFlight;
  },

  installUpdate() {
    if (!autoUpdater) {
      throw markUpdateError(new Error('Updater is unavailable'), 'UPDATER_UNAVAILABLE');
    }

    if (updateState.stage !== 'downloaded') {
      throw markUpdateError(new Error('Update package is not downloaded yet'), 'UPDATE_NOT_READY');
    }

    setUpdateState({
      stage: 'installing',
      message: 'Quitting and installing update...',
    });

    autoUpdater.quitAndInstall();
  },
};
function getAppRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app');
  }
  return path.join(__dirname, '..');
}

function getRuntimeRoot() {
  if (app.isPackaged) {
    const contentsDir = process.platform === 'darwin'
      ? path.join(path.dirname(process.execPath), '..')
      : path.dirname(process.execPath);
    return path.join(contentsDir, 'runtime');
  }
  return path.join(getAppRoot(), 'build-resources', 'runtime');
}



/**
 * 闂備礁鍚嬮崕鎶藉床閼艰翰浜?node_modules 闂佽崵濮崇拃锕傚垂閹殿喗顐介柣鎰劋閺咁剟鏌涢銈呮瀻闁愁亞鏁婚弻娑㈠冀瑜庨崳钘夘熆瑜庨〃濠傜暦?extraResources 濠电偞鍨堕幖鈺呭矗韫囨洘顫?
 */
function getNodeModulesPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'node_modules');
  }
  return path.join(__dirname, '..', 'node_modules');
}

async function startServer() {
  const appRoot = getAppRoot();

  // 闂佽崵濮崇粈浣规櫠娴犲鍋柛鈩冾殢閸熷懘鏌曟径鍫濃偓妤冪矙婵犲洦鐓熼柍鍝勶工閺嬫稓绱撳鍛ч柡浣哥Ч瀹曞ジ鎮㈢亸浣稿緧闂備礁鎲￠悧鏇㈠箠鎼淬劌绠栨俊銈呮噺閸嬨劑鏌嶉搹瑙勭erData闂佽瀛╃粙鎺曟懌闂佸搫鍊风欢姘跺箖娴犲惟闁挎洍鍋撻柣鎾存礋閺屸剝鎷呴崫鍕垫毉閻庤鎸风欢姘跺极?
  const userDataPath = app.getPath('userData');
  process.env.XIAOBA_USER_DATA_DIR = userDataPath;
  const skillsPath = path.join(userDataPath, 'skills');
  if (!String(process.env.XIAOBA_SKILLS_DIR || '').trim()) {
    process.env.XIAOBA_SKILLS_DIR = skillsPath;
  }
  fs.mkdirSync(process.env.XIAOBA_SKILLS_DIR, { recursive: true });
  // Keep this before createApplicationMenu(): close-to-tray preferences are read from process.cwd()/.xiaoba/catsco.json.
  process.chdir(userDataPath);

  // 濠电姷顣介埀顒€鍟块埀顒€缍婇幃妯荤箙缁茬尃rData闂傚倷鐒﹁ぐ鍐嫉椤掑嫭鍎夐柛娑欐綑鐎?env闂備焦瀵х粙鎴炵附閺冨倸鍨濋柣鏇犵％p闂傚倷鐒﹁ぐ鍐嚐椤栫倛鍥蓟閵夈儳顦?env.example
  const envPath = path.join(userDataPath, '.env');
  if (!fs.existsSync(envPath)) {
    const examplePath = path.join(appRoot, '.env.example');
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, envPath);
    }
  }

  // 闂備礁鎲￠懝楣冨嫉椤掑嫷鏁嗛柣鎰惈缁€鍐煕濞戝崬鐏ｉ柡?skills 闂?userData闂備焦瀵х粙鎴︽偋閸涱垱宕叉慨妯垮煐閸嬧晜绻涢崱妯虹仸闁哄棗绻橀弻鐔煎级閹存繃些闂佷紮绲婚崝搴ㄥ箟濡ゅ懎宸濇い鏍ㄧ〒閺?skills闂?
  // Skills are user-managed. New installs start empty; SkillHub installs populate this directory.
  const promptsDest = path.join(userDataPath, 'prompts');
  const promptsSrc = path.join(appRoot, 'prompts');
  if (!fs.existsSync(promptsDest) && fs.existsSync(promptsSrc)) {
    fs.cpSync(promptsSrc, promptsDest, { recursive: true });
  }

  // 闂備礁鎲″缁樻叏閹灐褰掑床缁跺env
  require('dotenv').config({ path: envPath, quiet: true });

  // 闂備礁鎲＄粙鎴︽晝閵娾晜鍎?dashboard server app 闂備焦鐪归崝宀€鈧凹鍓熼幃鍧楀礋椤栨稈鎸冮梺鍛婁緱閸撴稓绮旂€靛摜纾介柛鎰劤濞呮瑧绱掓潏銊у磼sar 闂備礁鎲￠崝鏇㈠箯閹寸姵顫?
  process.env.XIAOBA_APP_ROOT = appRoot;
  process.env.XIAOBA_IS_PACKAGED = app.isPackaged ? '1' : '0';
  process.env.XIAOBA_RUNTIME_ROOT = getRuntimeRoot();
  if (!String(process.env.XIAOBA_PROMPT_OVERRIDES_DIR || '').trim()) {
    process.env.XIAOBA_PROMPT_OVERRIDES_DIR = path.join(userDataPath, 'prompt-overrides');
  }

  // 闂備胶鎳撻悘姘跺箰閸濄儮鍋撻崹顐€块柟顔ㄥ洤閱囨い鎺戝€婚悰銉╂煟閻樿京顦﹀褌绮欓幃?NODE_PATH 闂佽崵濮崇拋鏌ュ疾濞戙垺鍋ゆ繛鍡樺姈娴溿倖绻涢幋鐐茬劰闁哄被鍊濋弻銈団偓鍦Т琚氭繝銏ｎ潐閿曘垹鐣?node_modules
  const nodeModulesPath = getNodeModulesPath();
  process.env.XIAOBA_NODE_MODULES = nodeModulesPath;
  if (app.isPackaged) {
    process.env.NODE_PATH = nodeModulesPath;
    require('module').Module._initPaths();
  }

  const runtimeEnvironmentModulePath = path.join(appRoot, 'dist', 'utils', 'runtime-environment');
  const { resolveRuntimeEnvironment, formatRuntimeSummary } = require(runtimeEnvironmentModulePath);
  const runtimeEnvironment = resolveRuntimeEnvironment({
    env: process.env,
    appRoot,
    runtimeRoot: process.env.XIAOBA_RUNTIME_ROOT,
    isPackaged: app.isPackaged,
  });
  if (runtimeEnvironment.binaries.node.executable) {
    runtimeEnvironment.env.XIAOBA_NODE_EXECUTABLE = runtimeEnvironment.binaries.node.executable;
  }
  Object.assign(process.env, runtimeEnvironment.env);
  console.log('[runtime]', formatRuntimeSummary(runtimeEnvironment.binaries.node));
  console.log('[runtime]', formatRuntimeSummary(runtimeEnvironment.binaries.python));
  console.log('[runtime]', formatRuntimeSummary(runtimeEnvironment.binaries.git));

  // 闂備胶鍎甸弲娑㈡偤閵娧勬殰闁圭虎鍠栭幑鍫曟煏婵炲灝鈧洟鎯佸鍫濈骇闁冲搫鍊婚妴鎺楁煃鐠囧眰鍋㈢€规洏鍎甸、娑橆潩椤戭偅顣筧shboard server
  const { startDashboard } = require(path.join(appRoot, 'dist', 'dashboard', 'server'));
  dashboardServerHandle = await startDashboard(DASHBOARD_PORT, { updateController, projectRoot: appRoot });
}

function stopDashboardServer() {
  if (!dashboardServerHandle) return;
  const handle = dashboardServerHandle;
  dashboardServerHandle = null;
  handle.stop?.().catch((error) => {
    console.warn('Failed to stop dashboard server:', error);
  });
}

function createWindow(targetPath) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'CatsCo Dashboard',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1117',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (targetPath) mainWindow.loadURL(buildDashboardUrl(targetPath));
  else mainWindow.loadURL(`http://127.0.0.1:${DASHBOARD_PORT}`);

  mainWindow.on('close', (event) => {
    if (app.isQuitting || !readCloseToTrayPreference()) return;
    event.preventDefault();
    mainWindow.hide();
    notifyWindowHidden();
  });

  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    mainWindow.hide();
    showPetWindow();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createPetWindow() {
  if (petWindow) return petWindow;

  const { workArea } = screen.getPrimaryDisplay();
  const width = 284;
  const height = 536;
  const savedBounds = readPetWindowBounds();
  const initialBounds = savedBounds || {
    x: Math.max(workArea.x, workArea.x + workArea.width - width - 28),
    y: Math.max(workArea.y, workArea.y + workArea.height - height - 64),
    width,
    height,
  };
  petWindow = new BrowserWindow({
    ...initialBounds,
    width,
    height,
    minWidth: 240,
    minHeight: 440,
    title: 'CatsCo Companion',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  petWindow.setAlwaysOnTop(true, 'floating');
  petWindow.loadURL(`http://127.0.0.1:${DASHBOARD_PORT}/pet-window.html`);

  petWindow.once('ready-to-show', () => {
    petWindow?.show();
  });

  petWindow.webContents.once('did-finish-load', () => {
    if (petWindow && !petWindow.isVisible()) petWindow.show();
  });

  petWindow.on('close', (event) => {
    if (app.isQuitting) return;
    event.preventDefault();
    savePetWindowBounds(petWindow.getBounds());
    petWindow.hide();
  });

  petWindow.on('moved', () => {
    if (petWindow) savePetWindowBounds(petWindow.getBounds());
  });

  petWindow.on('closed', () => {
    petWindow = null;
  });

  petWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedDashboardUrl(url)) {
      showMainWindow();
    } else {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  petWindow.webContents.on('context-menu', () => {
    showPetContextMenu();
  });

  return petWindow;
}

function isTrustedDashboardUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
      url.port === String(DASHBOARD_PORT);
  } catch (_error) {
    return false;
  }
}

const CATSCOMPANY_FILE_SELECTION_LIMIT = 6;

ipcMain.handle('catsco:select-files', async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow || undefined;
  const frameUrl = event.senderFrame?.url || event.sender.getURL();
  if (owner !== mainWindow || !isTrustedDashboardUrl(frameUrl)) return [];

  const options = {
    properties: ['openFile', 'multiSelections'],
  };
  const result = await dialog.showOpenDialog(owner, options);
  if (result.canceled) return [];

  const { createLocalFileGrant } = require(path.join(getAppRoot(), 'dist', 'dashboard', 'local-file-grants'));
  return result.filePaths
    .map((filePath, index) => {
      try {
        if (index >= CATSCOMPANY_FILE_SELECTION_LIMIT) {
          return {
            name: path.basename(filePath),
            size: 0,
            error: `一次最多选择 ${CATSCOMPANY_FILE_SELECTION_LIMIT} 个文件。`,
          };
        }
        return createLocalFileGrant(filePath);
      } catch (error) {
        return {
          name: path.basename(filePath),
          size: 0,
          error: error?.message || '文件无法授权，请重新选择。',
        };
      }
    })
    .filter(Boolean);
});

ipcMain.handle('catsco:pet:open-dashboard', (_event, targetPath) => {
  openDashboardFromPet(String(targetPath || ''));
  return { ok: true };
});

ipcMain.handle('catsco:pet:open-catsco-web', () => {
  openCatsCoWebFromPet();
  return { ok: true, url: resolveCatsCoWebUrl() };
});

ipcMain.handle('catsco:pet:show-menu', () => {
  showPetContextMenu();
  return { ok: true };
});

ipcMain.handle('catsco:pet:get-state', () => ({
  ok: true,
  dashboardUrl: getDashboardUrl(),
  catsCoWebUrl: resolveCatsCoWebUrl(),
  startAtLogin: readStartAtLoginPreference(),
}));

ipcMain.handle('catsco:pet:set-start-at-login', (_event, value) => {
  writeStartAtLoginPreference(Boolean(value));
  syncLoginItemSettings();
  return { ok: true, startAtLogin: readStartAtLoginPreference() };
});

function quitApp() {
  app.isQuitting = true;
  app.quit();
}

function buildPetContextMenuTemplate() {
  return [
    { label: 'Show Companion', click: showPetWindow },
    { label: 'Open Dashboard', click: openDashboardFromPet },
    { label: 'Open CatsCo Web', click: openCatsCoWebFromPet },
    { type: 'separator' },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: readStartAtLoginPreference(),
      click: (menuItem) => {
        writeStartAtLoginPreference(menuItem.checked);
        syncLoginItemSettings();
      },
    },
    { type: 'separator' },
    { label: 'Quit CatsCo', click: quitApp },
  ];
}

function showPetContextMenu() {
  const menu = Menu.buildFromTemplate(buildPetContextMenuTemplate());
  menu.popup({ window: petWindow || mainWindow || undefined });
}

function createApplicationMenu() {
  const closeToTray = readCloseToTrayPreference();
  const quit = () => {
    app.isQuitting = true;
    app.quit();
  };

  const editMenu = [
    { label: '撤销', role: 'undo' },
    { label: '重做', role: 'redo' },
    { type: 'separator' },
    { label: '剪切', role: 'cut' },
    { label: '复制', role: 'copy' },
    { label: '粘贴', role: 'paste' },
    { label: '全选', role: 'selectAll' },
  ];

  const template = [
    ...(process.platform === 'darwin' ? [{
      label: 'CatsCo',
      submenu: [
        { label: '关于 CatsCo', role: 'about' },
        { type: 'separator' },
        { label: '隐藏 CatsCo', role: 'hide' },
        { label: '隐藏其他应用', role: 'hideOthers' },
        { label: '显示全部', role: 'unhide' },
        { type: 'separator' },
        { label: '退出 CatsCo', accelerator: 'Command+Q', click: quit },
      ],
    }] : []),
    {
      label: '文件',
      submenu: [
        { label: '打开 Dashboard', click: showMainWindow },
        { type: 'separator' },
        { label: '退出 CatsCo', accelerator: process.platform === 'darwin' ? 'Command+Q' : 'Ctrl+Q', click: quit },
      ],
    },
    {
      label: '编辑',
      submenu: editMenu,
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { label: '显示主窗口', click: showMainWindow },
        {
          label: '点 × 后隐藏到后台',
          type: 'checkbox',
          checked: closeToTray,
          click: (menuItem) => {
            writeCloseToTrayPreference(menuItem.checked);
          },
        },
        { type: 'separator' },
        { label: '最小化', role: 'minimize' },
        { label: '关闭窗口', role: 'close' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '检查更新',
          enabled: Boolean(autoUpdater),
          click: () => {
            updateController.checkForUpdates(true).catch((error) => {
              console.error('Manual update check failed:', error);
            });
          },
        },
        {
          label: '打开发布页',
          click: () => {
            const url = updateState.releasePageUrl;
            if (url) shell.openExternal(url);
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  tray = new Tray(createTrayIcon());
  const contextMenu = Menu.buildFromTemplate(buildPetContextMenuTemplate());

  tray.setToolTip('CatsCo Companion');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    showPetWindow();
  });
}

function createLegacyTray() {
  tray = new Tray(createTrayIcon());

  const contextMenu = Menu.buildFromTemplate([
    { label: '打开 CatsCo Dashboard', click: showMainWindow },
    { type: 'separator' },
    { label: '退出 CatsCo', click: () => { app.isQuitting = true; app.quit(); }} ,
  ]);

  tray.setToolTip('CatsCo Dashboard');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    showMainWindow();
  });
}

// 闂備礁鎼ú銈夋偤閵娾晛钃熷┑鐘插暟椤╂煡鎮楅敐鍌涙珕妞ゆ劒绮欓弻锝夊煛閸屾氨浠撮梺?
if (autoUpdater) {
  autoUpdater.on('checking-for-update', () => {
    setUpdateState({
      stage: 'checking',
      message: 'Checking for updates...',
      checkedAt: Date.now(),
      lastError: null,
    });
  });

  autoUpdater.on('update-available', (info) => {
    setUpdateState({
      stage: 'available',
      message: 'Update ' + (info.version || '') + ' is available',
      availableVersion: info.version || null,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
      percent: 0,
      bytesPerSecond: 0,
      transferred: 0,
      total: 0,
      lastError: null,
    });
  });

  autoUpdater.on('update-not-available', () => {
    setUpdateState({
      stage: 'idle',
      message: 'Already on the latest version',
      availableVersion: null,
      releaseNotes: null,
      percent: 0,
      bytesPerSecond: 0,
      transferred: 0,
      total: 0,
      lastError: null,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    setUpdateState({
      stage: 'downloading',
      message: 'Downloading update...',
      percent: Number(progress?.percent || 0),
      bytesPerSecond: Number(progress?.bytesPerSecond || 0),
      transferred: Number(progress?.transferred || 0),
      total: Number(progress?.total || 0),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    setUpdateState({
      stage: 'downloaded',
      message: 'Update ' + (info.version || '') + ' downloaded',
      availableVersion: info.version || updateState.availableVersion,
      percent: 100,
      bytesPerSecond: 0,
      transferred: updateState.total || updateState.transferred,
      total: updateState.total || updateState.transferred,
      lastError: null,
    });
  });

  autoUpdater.on('error', (error) => {
    markUpdateError(error, 'UPDATE_RUNTIME_ERROR');
  });
}

app.whenReady().then(async () => {
  try {
    registerDeepLinkProtocol();
    await startServer();
    dashboardServerReady = true;
    ensureStartAtLoginRegistration();
    createApplicationMenu();
    createPetWindow();
    createTray();
    enqueueDeepLinkFromArgv(process.argv);
    scheduleDeepLinkDrain();
    
    // 闂備礁鎲￠崙褰掑垂閻楀牊鍙忛柍鍝勬噹鐟欙箓骞栧ǎ顒€鐒烘慨濠囩畺閺岋紕浠︾拠鎻掑濠电偞褰冨鈥愁嚕?
    if (app.isPackaged && autoUpdater) {
      setTimeout(() => {
        updateController.checkForUpdates(false).catch(() => {});
      }, 3000);
    }
  } catch (err) {
    console.error('闂備礁鎲￠崙褰掑垂閻楀牊鍙忛柍鍝勫€哥欢鐐哄级閸偄浜悮?', err);
    app.quit();
  }

  app.on('activate', () => {
    showPetWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopDashboardServer();
});
