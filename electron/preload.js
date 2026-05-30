const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('catscoDesktop', {
  selectFiles: () => ipcRenderer.invoke('catsco:select-files'),
  minimizeToTray: () => ipcRenderer.invoke('catsco:minimize-to-tray'),
  enterDesktopMode: () => ipcRenderer.invoke('catsco:enter-desktop-mode'),
  moveDesktopPet: (deltaX, deltaY) => ipcRenderer.invoke('catsco:move-desktop-pet', { deltaX, deltaY }),
  showDashboard: () => ipcRenderer.invoke('catsco:show-dashboard'),
  showDesktop: () => ipcRenderer.invoke('catsco:show-desktop'),
});
