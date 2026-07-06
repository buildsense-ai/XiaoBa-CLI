const fs = require('fs');
const path = require('path');

function getRuntimeDataRootForMenu({ app, env = process.env }) {
  return env.XIAOBA_USER_DATA_DIR
    || env.CATSCO_USER_DATA_DIR
    || env.XIAOBA_ELECTRON_USER_DATA_DIR
    || app.getPath('userData');
}

function openAttachmentCacheDirectory({ app, shell, env = process.env }) {
  const dir = path.join(getRuntimeDataRootForMenu({ app, env }), 'data', 'attachments');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    console.error('Failed to create attachment cache directory:', error);
  }
  shell.openPath(dir).then((error) => {
    if (error) {
      console.error('Failed to open attachment cache directory:', error);
    }
  });
}

function createRuntimeDataActions({ app, shell, env = process.env }) {
  return {
    getRuntimeDataRootForMenu: () => getRuntimeDataRootForMenu({ app, env }),
    openAttachmentCacheDirectory: () => openAttachmentCacheDirectory({ app, shell, env }),
  };
}

module.exports = {
  createRuntimeDataActions,
  getRuntimeDataRootForMenu,
  openAttachmentCacheDirectory,
};
