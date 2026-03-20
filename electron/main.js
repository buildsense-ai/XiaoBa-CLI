const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

const DASHBOARD_PORT = 3800;
let mainWindow = null;
let tray = null;

function getAppRoot() {
  // asar 已关闭
  // 打包后: Resources/app/electron/main.js -> Resources/app/
  // 开发时: electron/main.js -> ./
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app');
  }
  return path.join(__dirname, '..');
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

  // 如果userData里没有skills目录，创建symlink或复制
  const skillsPath = path.join(userDataPath, 'skills');
  if (!fs.existsSync(skillsPath)) {
    const bundledSkills = path.join(appRoot, 'skills');
    if (fs.existsSync(bundledSkills)) {
      // 复制skills目录
      fs.cpSync(bundledSkills, skillsPath, { recursive: true });
    } else {
      fs.mkdirSync(skillsPath, { recursive: true });
    }
  }

  // 复制skill-registry.json
  const registryDest = path.join(userDataPath, 'skill-registry.json');
  const registrySrc = path.join(appRoot, 'skill-registry.json');
  if (!fs.existsSync(registryDest) && fs.existsSync(registrySrc)) {
    fs.copyFileSync(registrySrc, registryDest);
  }

  // 加载dotenv
  require('dotenv').config({ path: envPath, quiet: true });

  // 告诉 dashboard server app 的实际位置（asar 内）
  process.env.XIAOBA_APP_ROOT = appRoot;

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

app.whenReady().then(async () => {
  try {
    await startServer();
    createWindow();
    createTray();
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
