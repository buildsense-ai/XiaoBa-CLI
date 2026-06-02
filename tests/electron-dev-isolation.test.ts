import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(path.join(process.cwd(), 'scripts/electron-dev-options.mjs')).href;

test('electron dev defaults to an isolated port and user data directory', async () => {
  const { resolveElectronDevOptions } = await import(moduleUrl) as any;
  const cwd = path.resolve('D:/XiaoBa-CLI-public');
  const result = resolveElectronDevOptions({
    cwd,
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      PATH: 'base-path',
    },
  });

  const expectedUserDataDir = path.join(cwd, '.dev-user-data');
  assert.equal(result.port, '3810');
  assert.equal(result.userDataDir, expectedUserDataDir);
  assert.equal(result.env.XIAOBA_DASHBOARD_PORT, '3810');
  assert.equal(result.env.XIAOBA_ELECTRON_USER_DATA_DIR, expectedUserDataDir);
  assert.equal(result.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(result.env.PATH, 'base-path');
});

test('electron dev isolation can be overridden from the environment', async () => {
  const { resolveElectronDevOptions } = await import(moduleUrl) as any;
  const cwd = path.resolve('D:/XiaoBa-CLI-public');
  const customUserDataDir = path.join(cwd, '.custom-user-data');
  const result = resolveElectronDevOptions({
    cwd,
    env: {
      XIAOBA_DASHBOARD_PORT: '3820',
      XIAOBA_ELECTRON_USER_DATA_DIR: customUserDataDir,
    },
  });

  assert.equal(result.port, '3820');
  assert.equal(result.userDataDir, customUserDataDir);
  assert.equal(result.env.XIAOBA_DASHBOARD_PORT, '3820');
  assert.equal(result.env.XIAOBA_ELECTRON_USER_DATA_DIR, customUserDataDir);
});
