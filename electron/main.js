const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const DASHBOARD_PORT = 3800;
let mainWindow = null;
let tray = null;
let autoUpdater = null;

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
  process.chdir(userDataPath);

  // 濠电姷顣介埀顒€鍟块埀顒€缍婇幃妯荤箙缁茬尃rData闂傚倷鐒﹁ぐ鍐嫉椤掑嫭鍎夐柛娑欐綑鐎?env闂備焦瀵х粙鎴炵附閺冨倸鍨濋柣鏇犵％p闂傚倷鐒﹁ぐ鍐嚐椤栫倛鍥蓟閵夈儳顦?env.example
  const fs = require('fs');
  const envPath = path.join(userDataPath, '.env');
  if (!fs.existsSync(envPath)) {
    const examplePath = path.join(appRoot, '.env.example');
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, envPath);
    }
  }

  // 闂備礁鎲￠懝楣冨嫉椤掑嫷鏁嗛柣鎰惈缁€鍐煕濞戝崬鐏ｉ柡?skills 闂?userData闂備焦瀵х粙鎴︽偋閸涱垱宕叉慨妯垮煐閸嬧晜绻涢崱妯虹仸闁哄棗绻橀弻鐔煎级閹存繃些闂佷紮绲婚崝搴ㄥ箟濡ゅ懎宸濇い鏍ㄧ〒閺?skills闂?
  const skillsPath = path.join(userDataPath, 'skills');
  const bundledSkills = path.join(appRoot, 'skills');

  if (fs.existsSync(bundledSkills)) {
    fs.mkdirSync(skillsPath, { recursive: true });

    // 濠电姰鍨煎▔娑氱矓閹绢喖鏄ユ俊銈傚亾鐞氭瑩鐓崶褔鍙勯柛銈咁儔閺屾盯骞囬浣告闂?skill闂備焦瀵х粙鎴︽偋閸涱垳绠斿璺烘湰閸熸椽鏌涢埄鍐噭缁剧偓澹嗛埀顒傛嚀閹猜ゃ亹閸愵喗鍋ら柕濞炬櫅閹瑰爼鏌曟繛褍瀚弳鐘绘⒑?
    const bundledSkillDirs = fs.readdirSync(bundledSkills, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of bundledSkillDirs) {
      const src = path.join(bundledSkills, dir.name);
      const dest = path.join(skillsPath, dir.name);

      // 闂備礁鎲￠悷顖涚濠婂煻鍥蓟閵夈儳顦梺鍝勭墢閺佹悂鎮峰┑瀣€垫繛鎴烆仾椤忓嫸鑰挎い蹇撶墛閸?skill
      if (!fs.existsSync(dest)) {
        fs.cpSync(src, dest, { recursive: true });
      }
    }

    // 濠电姰鍨煎▔娑氱矓閹绢喖鏄?README
    const readmeSrc = path.join(bundledSkills, 'README.md');
    const readmeDest = path.join(skillsPath, 'README.md');
    if (fs.existsSync(readmeSrc)) {
      fs.copyFileSync(readmeSrc, readmeDest);
    }
  }

  // 婵犳鍣徊鐣屾崲閹达富鏁冨┑鍌滎焾鐟欙附銇勯弽銊ㄥ鐞氱喖姊绘笟鍥ф灕濠殿喓鍊曠叅闁秆勵殔濡?skill-registry.json闂備焦瀵х粙鎴︽偋韫囨稑鐏虫俊顖濆吹閳瑰秵绻濋棃娑氬闁哄棗绻橀弻鐔衡偓闈涙啞閻掓寧顨ラ悙鑼妞ゆ洏鍎辫灃濞达綁鈧稓甯涢梻浣告惈閸婅绔熼崱妞绘灁闁硅揪绠戠€氬銇勯幒鍡椾壕濠电姭鍋撻悗闈涙啞椤洟鏌曡箛鏇炐ョ紒灞芥健閺?
  const registryDest = path.join(userDataPath, 'skill-registry.json');
  const registrySrc = path.join(appRoot, 'skill-registry.json');
  if (fs.existsSync(registrySrc)) {
    fs.copyFileSync(registrySrc, registryDest);
  }

  // 濠电姰鍨煎▔娑氱矓閹绢喖鏄?prompts 闂備胶鍎甸弲鈺呭窗閺嶎偆绀?
  const promptsDest = path.join(userDataPath, 'prompts');
  const promptsSrc = path.join(appRoot, 'prompts');
  if (!fs.existsSync(promptsDest) && fs.existsSync(promptsSrc)) {
    fs.cpSync(promptsSrc, promptsDest, { recursive: true });
  }

  // 闂備礁鎲″缁樻叏閹灐褰掑床缁跺env
  require('dotenv').config({ path: envPath, quiet: true });

  // 闂備礁鎲＄粙鎴︽晝閵娾晜鍎?dashboard server app 闂備焦鐪归崝宀€鈧凹鍓熼幃鍧楀礋椤栨稈鎸冮梺鍛婁緱閸撴稓绮旂€靛摜纾介柛鎰劤濞呮瑧绱掓潏銊у磼sar 闂備礁鎲￠崝鏇㈠箯閹寸姵顫?
  process.env.XIAOBA_APP_ROOT = appRoot;
  process.env.XIAOBA_RUNTIME_ROOT = getRuntimeRoot();

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
  Object.assign(process.env, runtimeEnvironment.env);
  console.log('[runtime]', formatRuntimeSummary(runtimeEnvironment.binaries.node));
  console.log('[runtime]', formatRuntimeSummary(runtimeEnvironment.binaries.python));
  console.log('[runtime]', formatRuntimeSummary(runtimeEnvironment.binaries.git));

  // 闂備胶鍎甸弲娑㈡偤閵娧勬殰闁圭虎鍠栭幑鍫曟煏婵炲灝鈧洟鎯佸鍫濈骇闁冲搫鍊婚妴鎺楁煃鐠囧眰鍋㈢€规洏鍎甸、娑橆潩椤戭偅顣筧shboard server
  const { startDashboard } = require(path.join(appRoot, 'dist', 'dashboard', 'server'));
  await startDashboard(DASHBOARD_PORT, { updateController });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'XiaoBa Dashboard',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1117',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://localhost:${DASHBOARD_PORT}`);

  mainWindow.on('close', (e) => {
    if (process.platform === 'darwin' && !app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAABhSURBVFhH7c6xDQAgDASwkP2XZgEqCgrZwJ+u8Ov1vt+RM0EHHXTQQQcddNBBBx100EEHHXTQQQcddNBBBx100EEHHXTQQQcddNBBBx100EEHHXTQQQcddNBBBx3834kDK+kAIRUXPjcAAAAASUVORK5CYII='
  );
  tray = new Tray(icon.resize({ width: 16, height: 16 }));

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: () => {
      if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
      else createWindow();
    }},
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); }} ,
  ]);

  tray.setToolTip('XiaoBa Dashboard');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    else createWindow();
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
    await startServer();
    createWindow();
    createTray();
    
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
    if (mainWindow) mainWindow.show();
    else createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
