import path from 'node:path';

export const DEFAULT_ELECTRON_DEV_PORT = '3810';
export const DEFAULT_ELECTRON_DEV_USER_DATA_DIR = '.dev-user-data';

export function resolveElectronDevOptions(options = {}) {
  const cwd = options.cwd || process.cwd();
  const sourceEnv = options.env || process.env;
  const port = normalizePort(sourceEnv.XIAOBA_DASHBOARD_PORT) || DEFAULT_ELECTRON_DEV_PORT;
  const userDataDir = resolveUserDataDir(cwd, sourceEnv.XIAOBA_ELECTRON_USER_DATA_DIR);
  const env = {
    ...sourceEnv,
    XIAOBA_DASHBOARD_PORT: port,
    XIAOBA_ELECTRON_USER_DATA_DIR: userDataDir,
    XIAOBA_ELECTRON_DEV_ISOLATED: '1',
  };

  delete env.ELECTRON_RUN_AS_NODE;

  return {
    port,
    userDataDir,
    env,
  };
}

function normalizePort(value) {
  const text = String(value || '').trim();
  if (!/^\d+$/.test(text)) return null;
  const port = Number.parseInt(text, 10);
  if (port < 1 || port > 65535) return null;
  return String(port);
}

function resolveUserDataDir(cwd, value) {
  const text = String(value || '').trim();
  if (!text) {
    return path.join(cwd, DEFAULT_ELECTRON_DEV_USER_DATA_DIR);
  }
  return path.isAbsolute(text) ? text : path.resolve(cwd, text);
}
