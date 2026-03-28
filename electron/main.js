const { app, BrowserWindow, Tray, Menu, nativeImage, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

const DASHBOARD_PORT = 3800;
let mainWindow = null;
let tray = null;

// 配置自动更新
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

function getAppRoot() {
  // asar 已关闭
  // 打包后: Resources/app/electron/main.js -> Resources/app/
  // 开发时: electron/main.js -> ./
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app');
  }
  return path.join(__dirname, '..');
}

/**
 * 获取内嵌的 node.exe 路径（打包版）或系统 node（开发版）
 */
function getNodeExePath() {
  if (app.isPackaged) {
    // extraFiles 将 build-resources/node/ 复制到 Contents/node/
    const nodeFileName = process.platform === 'win32' ? 'node.exe' : 'node';
    // macOS: process.execPath = Contents/MacOS/XiaoBa, 需要 ../node/node
    // Windows: process.execPath = XiaoBa.exe, 需要 ./node/node.exe
    const contentsDir = process.platform === 'darwin'
      ? path.join(path.dirname(process.execPath), '..')
      : path.dirname(process.execPath);
    const embeddedNode = path.join(contentsDir, 'node', nodeFileName);
    const fs = require('fs');
    if (fs.existsSync(embeddedNode)) {
      return embeddedNode;
    }
    console.warn('Embedded node not found at', embeddedNode, ', falling back to system node');
  }
  return 'node';
}

/**
 * 获取 node_modules 路径（打包版在 extraResources 中）
 */
function getNodeModulesPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'node_modules');
  }
  return path.join(__dirname, '..', 'node_modules');
}

async function startServer() {
  const appRoot = getAppRoot();

  // 设置工作目录（打包后用userData存放用户数据）
  const userDataPath = app.getPath('userData');
  process.chdir(userDataPath);

  // 如果userData里没有.env，从app里复制.env.example
  const fs = require('fs');
  const envPath = path.join(userDataPath, '.env');
  if (!fs.existsSync(envPath)) {
    const examplePath = path.join(appRoot, '.env.example');
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, envPath);
    }
  }

  // 同步内置 skills 到 userData（保留用户安装的 skills）
  const skillsPath = path.join(userDataPath, 'skills');
  const bundledSkills = path.join(appRoot, 'skills');

  if (fs.existsSync(bundledSkills)) {
    fs.mkdirSync(skillsPath, { recursive: true });

    // 复制每个内置 skill（不覆盖已存在的）
    const bundledSkillDirs = fs.readdirSync(bundledSkills, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of bundledSkillDirs) {
      const src = path.join(bundledSkills, dir.name);
      const dest = path.join(skillsPath, dir.name);

      // 只复制不存在的 skill
      if (!fs.existsSync(dest)) {
        fs.cpSync(src, dest, { recursive: true });
      }
    }

    // 复制 README
    const readmeSrc = path.join(bundledSkills, 'README.md');
    const readmeDest = path.join(skillsPath, 'README.md');
    if (fs.existsSync(readmeSrc)) {
      fs.copyFileSync(readmeSrc, readmeDest);
    }
  }

  // 每次启动都更新 skill-registry.json（确保用户获得最新的本地索引）
  const registryDest = path.join(userDataPath, 'skill-registry.json');
  const registrySrc = path.join(appRoot, 'skill-registry.json');
  if (fs.existsSync(registrySrc)) {
    fs.copyFileSync(registrySrc, registryDest);
  }

  // 复制 prompts 目录
  const promptsDest = path.join(userDataPath, 'prompts');
  const promptsSrc = path.join(appRoot, 'prompts');
  if (!fs.existsSync(promptsDest) && fs.existsSync(promptsSrc)) {
    fs.cpSync(promptsSrc, promptsDest, { recursive: true });
  }

  // 加载dotenv
  require('dotenv').config({ path: envPath, quiet: true });

  // 告诉 dashboard server app 的实际位置（asar 内）
  process.env.XIAOBA_APP_ROOT = appRoot;

  // 打包版：设置 NODE_PATH 让子进程能找到 node_modules
  const nodeModulesPath = getNodeModulesPath();
  process.env.XIAOBA_NODE_MODULES = nodeModulesPath;
  if (app.isPackaged) {
    process.env.NODE_PATH = nodeModulesPath;
    require('module').Module._initPaths();
  }

  // 设置内嵌 node.exe 路径供 service-manager 使用
  process.env.XIAOBA_NODE_EXE = getNodeExePath();

  // 直接在主进程启动dashboard server
  const { startDashboard } = require(path.join(appRoot, 'dist', 'dashboard', 'server'));
  await startDashboard(DASHBOARD_PORT);
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
    { label: '打开 Dashboard', click: () => {
      if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
      else createWindow();
    }},
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); }},
  ]);

  tray.setToolTip('XiaoBa Dashboard');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    else createWindow();
  });
}

// 更新事件监听
autoUpdater.on('update-available', (info) => {
  dialog.showMessageBox({
    type: 'info',
    title: '发现新版本',
    message: `发现新版本 ${info.version}，是否下载？`,
    buttons: ['下载', '稍后'],
  }).then((result) => {
    if (result.response === 0) autoUpdater.downloadUpdate();
  });
});

autoUpdater.on('update-downloaded', () => {
  dialog.showMessageBox({
    type: 'info',
    title: '更新已下载',
    message: '更新已下载完成，重启应用后生效',
    buttons: ['立即重启', '稍后'],
  }).then((result) => {
    if (result.response === 0) autoUpdater.quitAndInstall();
  });
});

app.whenReady().then(async () => {
  try {
    await startServer();
    createWindow();
    createTray();
    
    // 启动后检查更新
    if (app.isPackaged) {
      setTimeout(() => autoUpdater.checkForUpdates(), 3000);
    }
  } catch (err) {
    console.error('启动失败:', err);
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
