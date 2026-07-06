function registerPetIpcHandlers({
  ipcMain,
  openDashboardFromPet,
  openCatsCoWebFromPet,
  showPetContextMenu,
  getDashboardUrl,
  resolveCatsCoWebUrl,
  getDesktopCompanionManager,
}) {
  ipcMain.handle('catsco:pet:open-dashboard', (_event, targetPath) => {
    openDashboardFromPet(String(targetPath || ''));
    return { ok: true };
  });

  ipcMain.handle('catsco:pet:open-catsco-web', () => {
    openCatsCoWebFromPet();
    return { ok: true, url: resolveCatsCoWebUrl() };
  });

  ipcMain.handle('catsco:pet:show-menu', () => {
    showPetContextMenu();
    return { ok: true };
  });

  ipcMain.handle('catsco:pet:get-state', () => ({
    ok: true,
    dashboardUrl: getDashboardUrl(),
    catsCoWebUrl: resolveCatsCoWebUrl(),
    ...getDesktopCompanionManager().getState(),
  }));

  ipcMain.handle('catsco:pet:set-start-at-login', (_event, value) => {
    return { ok: true, ...getDesktopCompanionManager().setStartAtLogin(Boolean(value)) };
  });

  ipcMain.handle('catsco:pet:set-lock-position', (_event, value) => {
    return { ok: true, ...getDesktopCompanionManager().setLockPetPosition(Boolean(value)) };
  });

  ipcMain.handle('catsco:pet:set-always-on-top', (_event, value) => {
    return { ok: true, ...getDesktopCompanionManager().setAlwaysOnTop(Boolean(value)) };
  });
}

module.exports = {
  registerPetIpcHandlers,
};
