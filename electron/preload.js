const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('catscoDesktop', {
  selectFiles: () => ipcRenderer.invoke('catsco:select-files'),
});
