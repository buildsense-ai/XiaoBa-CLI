const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('catscoDesktop', {
  selectFiles: () => ipcRenderer.invoke('catsco:select-files'),
  openWebApp: () => ipcRenderer.invoke('catsco:open-webapp'),
  openReleasePage: () => ipcRenderer.invoke('catsco:open-release-page'),
  hideWindow: () => ipcRenderer.invoke('catsco:hide-window'),
});
