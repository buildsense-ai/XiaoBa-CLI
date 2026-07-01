const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('catscoDesktop', {
  selectFiles: () => ipcRenderer.invoke('catsco:select-files'),
});

contextBridge.exposeInMainWorld('catscoPet', {
  openDashboard: (targetPath) => ipcRenderer.invoke('catsco:pet:open-dashboard', targetPath || ''),
  openCatsCoWeb: () => ipcRenderer.invoke('catsco:pet:open-catsco-web'),
  showMenu: () => ipcRenderer.invoke('catsco:pet:show-menu'),
  getState: () => ipcRenderer.invoke('catsco:pet:get-state'),
  setStartAtLogin: (value) => ipcRenderer.invoke('catsco:pet:set-start-at-login', Boolean(value)),
  setLockPetPosition: (value) => ipcRenderer.invoke('catsco:pet:set-lock-position', Boolean(value)),
  setAlwaysOnTop: (value) => ipcRenderer.invoke('catsco:pet:set-always-on-top', Boolean(value)),
  onDesktopStateChanged: (callback) => {
    const handler = (_event, state) => callback?.(state);
    ipcRenderer.on('catsco:pet:desktop-state-changed', handler);
    return () => ipcRenderer.removeListener('catsco:pet:desktop-state-changed', handler);
  },
});
