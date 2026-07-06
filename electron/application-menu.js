function createApplicationMenu({
  Menu,
  app,
  shell,
  autoUpdater,
  updateController,
  updateState,
  showMainWindow,
  readCloseToTrayPreference,
  writeCloseToTrayPreference,
  openAttachmentCacheDirectory,
}) {
  const closeToTray = readCloseToTrayPreference();
  const quit = () => {
    app.isQuitting = true;
    app.quit();
  };

  const editMenu = [
    { label: '撤销', role: 'undo' },
    { label: '重做', role: 'redo' },
    { type: 'separator' },
    { label: '剪切', role: 'cut' },
    { label: '复制', role: 'copy' },
    { label: '粘贴', role: 'paste' },
    { label: '全选', role: 'selectAll' },
  ];

  const template = [
    ...(process.platform === 'darwin' ? [{
      label: 'CatsCo',
      submenu: [
        { label: '关于 CatsCo', role: 'about' },
        { type: 'separator' },
        { label: '隐藏 CatsCo', role: 'hide' },
        { label: '隐藏其他应用', role: 'hideOthers' },
        { label: '显示全部', role: 'unhide' },
        { type: 'separator' },
        { label: '退出 CatsCo', accelerator: 'Command+Q', click: quit },
      ],
    }] : []),
    {
      label: '文件',
      submenu: [
        { label: '打开 Dashboard', click: showMainWindow },
        { type: 'separator' },
        { label: '退出 CatsCo', accelerator: process.platform === 'darwin' ? 'Command+Q' : 'Ctrl+Q', click: quit },
      ],
    },
    {
      label: '编辑',
      submenu: editMenu,
    },
    {
      label: '设置',
      submenu: [
        { label: '打开本地缓存文件位置', click: openAttachmentCacheDirectory },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { label: '显示主窗口', click: showMainWindow },
        {
          label: '点 × 后隐藏到后台',
          type: 'checkbox',
          checked: closeToTray,
          click: (menuItem) => {
            writeCloseToTrayPreference(menuItem.checked);
          },
        },
        { type: 'separator' },
        { label: '最小化', role: 'minimize' },
        { label: '关闭窗口', role: 'close' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '检查更新',
          enabled: Boolean(autoUpdater),
          click: () => {
            updateController.checkForUpdates(true).catch((error) => {
              console.error('Manual update check failed:', error);
            });
          },
        },
        {
          label: '打开发布页',
          click: () => {
            const url = updateState.releasePageUrl;
            if (url) shell.openExternal(url);
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = {
  createApplicationMenu,
};
