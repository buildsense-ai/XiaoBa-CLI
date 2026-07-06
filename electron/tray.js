function createCompanionTray({
  Tray,
  Menu,
  createTrayIcon,
  buildPetContextMenuTemplate,
  showPetWindow,
}) {
  const tray = new Tray(createTrayIcon());
  const contextMenu = Menu.buildFromTemplate(buildPetContextMenuTemplate());

  tray.setToolTip('CatsCo Companion');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    showPetWindow();
  });

  return tray;
}

function createLegacyTray({
  Tray,
  Menu,
  app,
  createTrayIcon,
  showMainWindow,
}) {
  const tray = new Tray(createTrayIcon());

  const contextMenu = Menu.buildFromTemplate([
    { label: '打开 CatsCo Dashboard', click: showMainWindow },
    { type: 'separator' },
    { label: '退出 CatsCo', click: () => { app.isQuitting = true; app.quit(); }} ,
  ]);

  tray.setToolTip('CatsCo Dashboard');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    showMainWindow();
  });

  return tray;
}

module.exports = {
  createCompanionTray,
  createLegacyTray,
};
