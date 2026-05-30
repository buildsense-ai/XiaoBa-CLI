import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDesktopPowerShellArgs,
  resolveDashboardPort,
  resolveDesktopPetBounds,
  resolveDraggedDesktopPetBounds,
  resolveUserDataPath,
} from '../src/electron/desktop-companion';

test('Electron dashboard port can be isolated for the clone on 3801', () => {
  assert.equal(resolveDashboardPort({ DASHBOARD_PORT: '3801' }, 3800), 3801);
  assert.equal(resolveDashboardPort({ DASHBOARD_PORT: 'not-a-port' }, 3800), 3800);
  assert.equal(resolveDashboardPort({ DASHBOARD_PORT: '65536' }, 3800), 3800);
});

test('Electron userData can be pinned away from the installed original profile', () => {
  const cloneUserData = 'C:\\example\\xiaoba-clone\\data\\electron-clone-user-data';
  assert.equal(
    resolveUserDataPath({
      env: { XIAOBA_USER_DATA_DIR: cloneUserData },
      appRoot: 'C:\\example\\xiaoba-clone',
      defaultPath: 'C:\\Users\\teacher\\AppData\\Roaming\\xiaoba-cli',
    }),
    cloneUserData,
  );
});

test('desktop show commands are explicit and reject arbitrary actions', () => {
  const minimize = buildDesktopPowerShellArgs('minimize-all');
  assert.deepEqual(minimize.slice(0, 2), ['-NoProfile', '-Command']);
  assert.match(minimize[2], /MinimizeAll\(\)/);

  const restore = buildDesktopPowerShellArgs('restore-all');
  assert.match(restore[2], /UndoMinimizeAll\(\)/);

  assert.throws(() => buildDesktopPowerShellArgs('Remove-Item C:\\' as never), /Unsupported desktop action/);
});

test('desktop pet bounds keep the companion fully visible on the desktop', () => {
  assert.deepEqual(
    resolveDesktopPetBounds({
      display: { width: 1920, height: 1080 },
      window: { width: 220, height: 240 },
    }),
    { x: 1668, y: 768, width: 220, height: 240 },
  );

  assert.deepEqual(
    resolveDesktopPetBounds({
      display: { width: 320, height: 260 },
      window: { width: 220, height: 240 },
    }),
    { x: 68, y: 8, width: 220, height: 240 },
  );
});

test('dragged desktop pet bounds follow pointer movement and stay on screen', () => {
  assert.deepEqual(
    resolveDraggedDesktopPetBounds({
      current: { x: 1668, y: 768, width: 220, height: 240 },
      display: { width: 1920, height: 1080 },
      delta: { x: -120, y: -80 },
    }),
    { x: 1548, y: 688, width: 220, height: 240 },
  );

  assert.deepEqual(
    resolveDraggedDesktopPetBounds({
      current: { x: 20, y: 20, width: 220, height: 240 },
      display: { width: 320, height: 260 },
      delta: { x: -1000, y: 1000 },
    }),
    { x: 8, y: 12, width: 220, height: 240 },
  );
});
