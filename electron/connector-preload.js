const { contextBridge, ipcRenderer } = require('electron');

// Connector Lite exposes only window lifecycle operations. Local file access
// happens through authenticated Connector RPC and never through renderer IPC.
contextBridge.exposeInMainWorld('catscoDesktop', {
  openWebApp: () => ipcRenderer.invoke('catsco:open-webapp'),
  hideWindow: () => ipcRenderer.invoke('catsco:hide-window'),
});
