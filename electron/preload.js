const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('catscoDesktop', {
  selectFiles: () => ipcRenderer.invoke('catsco:select-files'),
  openWebApp: (url) => ipcRenderer.invoke('catsco:open-webapp', url),
  hideWindow: () => ipcRenderer.invoke('catsco:hide-window'),
});
