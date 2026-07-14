function createPetMenu({
  Menu,
  app,
  getDesktopCompanionManager,
  showPetWindow,
  openDashboardFromPet,
  openCatsCoWebFromPet,
  getPopupWindow,
}) {
  function quitApp() {
    app.isQuitting = true;
    app.quit();
  }

  function buildPetContextMenuTemplate() {
    const manager = getDesktopCompanionManager();
    return [
      { label: 'Show Companion', click: showPetWindow },
      { label: 'Open Dashboard', click: openDashboardFromPet },
      { label: 'Open CatsCo Web', click: openCatsCoWebFromPet },
      { type: 'separator' },
      {
        label: 'Lock Pet Position',
        type: 'checkbox',
        checked: manager.readLockPetPositionPreference(),
        click: (menuItem) => {
          manager.setLockPetPosition(menuItem.checked);
        },
      },
      {
        label: 'Always On Top',
        type: 'checkbox',
        checked: manager.readAlwaysOnTopPreference(),
        click: (menuItem) => {
          manager.setAlwaysOnTop(menuItem.checked);
        },
      },
      {
        label: 'Start With System',
        type: 'checkbox',
        checked: manager.readStartAtLoginPreference(),
        click: (menuItem) => {
          manager.setStartAtLogin(menuItem.checked);
        },
      },
      { type: 'separator' },
      { label: 'Quit CatsCo', click: quitApp },
    ];
  }

  function showPetContextMenu() {
    const menu = Menu.buildFromTemplate(buildPetContextMenuTemplate());
    menu.popup({ window: getPopupWindow() || undefined });
  }

  return {
    buildPetContextMenuTemplate,
    showPetContextMenu,
  };
}

module.exports = {
  createPetMenu,
};
