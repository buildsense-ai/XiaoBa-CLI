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
});
