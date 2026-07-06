const path = require('path');

function createPetWindowController({
  app,
  BrowserWindow,
  shell,
  dashboardPort,
  getDesktopCompanionManager,
  showMainWindow,
  isTrustedDashboardUrl,
  resolveCatsCoWebUrl,
  showPetContextMenu,
  preloadPath = path.join(__dirname, 'preload.js'),
}) {
  let petWindow = null;

  function getPetWindow() {
    return petWindow;
  }

  function createPetWindow() {
    if (petWindow) return petWindow;

    const width = 284;
    const height = 536;
    const manager = getDesktopCompanionManager();
    const initialBounds = manager.getInitialBounds({ width, height });
    const desktopCompanionWindowOptions = manager.getWindowBehaviorOptions();
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
      movable: desktopCompanionWindowOptions.movable,
      alwaysOnTop: desktopCompanionWindowOptions.alwaysOnTop,
      skipTaskbar: true,
      show: false,
      hasShadow: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: preloadPath,
      },
    });

    manager.attachPetWindow(petWindow);
    petWindow.loadURL(`http://127.0.0.1:${dashboardPort}/pet-window.html`);

    petWindow.once('ready-to-show', () => {
      petWindow?.show();
    });

    petWindow.webContents.once('did-finish-load', () => {
      if (petWindow && !petWindow.isVisible()) petWindow.show();
    });

    petWindow.on('close', (event) => {
      if (app.isQuitting) return;
      event.preventDefault();
      manager.settlePetWindowBounds(petWindow);
      petWindow.hide();
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

  function showPetWindow() {
    if (petWindow) {
      petWindow.show();
      petWindow.focus();
    } else {
      createPetWindow();
    }
  }

  function openDashboardFromPet(targetPath) {
    showMainWindow(targetPath);
  }

  function openCatsCoWebFromPet() {
    shell.openExternal(resolveCatsCoWebUrl()).catch((error) => {
      console.warn('Failed to open CatsCo Web:', error?.message || error);
    });
  }

  return {
    createPetWindow,
    getPetWindow,
    openCatsCoWebFromPet,
    openDashboardFromPet,
    showPetWindow,
  };
}

module.exports = {
  createPetWindowController,
};
