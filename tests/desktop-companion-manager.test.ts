import assert from 'node:assert/strict';
import test from 'node:test';

const { createDesktopCompanionManager } = require('../electron/desktop-companion-manager');

function createHarness(initialPreferences: Record<string, any> = {}) {
  const patches: Record<string, any>[] = [];
  const preferences = { ...initialPreferences };
  const display = {
    workArea: { x: 0, y: 0, width: 1440, height: 900 },
  };
  const screen = {
    getPrimaryDisplay: () => display,
    getDisplayMatching: () => display,
  };
  const app = {
    isPackaged: false,
    setLoginItemSettingsCalls: [] as any[],
    setLoginItemSettings(value: any) {
      this.setLoginItemSettingsCalls.push(value);
    },
  };
  const processLike = {
    platform: 'win32',
    defaultApp: false,
    argv: ['electron'],
    execPath: 'C:\\CatsCo\\CatsCo.exe',
  };
  const regCalls: any[] = [];
  const manager = createDesktopCompanionManager({
    app,
    screen,
    spawnSync: (command: string, args: string[], options: any) => {
      regCalls.push({ command, args, options });
      return {};
    },
    process: processLike,
    readDesktopConfig: () => ({ preferences }),
    writePreferencePatch: (patch: Record<string, any>) => {
      Object.assign(preferences, patch);
      patches.push(patch);
    },
  });

  return { app, manager, patches, preferences, regCalls };
}

function createWindow(bounds = { x: 1418, y: 120, width: 284, height: 536 }) {
  const listeners = new Map<string, Function[]>();
  const sentStates: any[] = [];
  const window: any = {
    bounds: { ...bounds },
    alwaysOnTopCalls: [] as any[],
    setMovableCalls: [] as boolean[],
    setBoundsCalls: [] as any[],
    webContents: {
      send(_channel: string, state: any) {
        sentStates.push(state);
      },
    },
    on(event: string, handler: Function) {
      listeners.set(event, [...(listeners.get(event) || []), handler]);
    },
    getBounds() {
      return { ...this.bounds };
    },
    setBounds(nextBounds: any, animate?: boolean) {
      this.bounds = { ...nextBounds };
      this.setBoundsCalls.push({ bounds: nextBounds, animate });
    },
    setAlwaysOnTop(value: boolean, level?: string) {
      this.alwaysOnTopCalls.push({ value, level });
    },
    setMovable(value: boolean) {
      this.setMovableCalls.push(value);
    },
    emit(event: string) {
      for (const handler of listeners.get(event) || []) handler();
    },
  };
  return { window, sentStates };
}

test('desktop companion manager defaults to free drag and persistent always-on-top startup state', () => {
  const { manager } = createHarness();

  assert.deepEqual(manager.getState(), {
    startAtLogin: false,
    lockPetPosition: false,
    alwaysOnTop: true,
    snapDistance: 28,
    petWindowBounds: null,
  });
});

test('desktop companion manager locks movement only after the user opts in', () => {
  const { manager, preferences, patches } = createHarness();
  const { window, sentStates } = createWindow();

  manager.attachPetWindow(window);
  assert.equal(window.setMovableCalls.at(-1), true);

  const state = manager.setLockPetPosition(true);

  assert.equal(preferences.lockPetPosition, true);
  assert.deepEqual(patches.at(-1), { lockPetPosition: true });
  assert.equal(window.setMovableCalls.at(-1), false);
  assert.equal(state.lockPetPosition, true);
  assert.equal(sentStates.at(-1).lockPetPosition, true);
});

test('desktop companion manager applies always-on-top changes immediately', () => {
  const { manager, preferences } = createHarness();
  const { window, sentStates } = createWindow();

  manager.attachPetWindow(window);
  const state = manager.setAlwaysOnTop(false);

  assert.equal(preferences.alwaysOnTop, false);
  assert.equal(window.alwaysOnTopCalls.at(-1).value, false);
  assert.equal(state.alwaysOnTop, false);
  assert.equal(sentStates.at(-1).alwaysOnTop, false);
});

test('desktop companion manager snaps near screen edges and remembers the snapped position', () => {
  const { manager, preferences } = createHarness();
  const { window } = createWindow({ x: 1440 - 284 + 20, y: 120, width: 284, height: 536 });

  manager.attachPetWindow(window);
  window.emit('moved');

  assert.equal(window.setBoundsCalls.at(-1).bounds.x, 1440 - 284);
  assert.equal(window.setBoundsCalls.at(-1).animate, true);
  assert.equal(preferences.petWindowBounds.x, 1440 - 284);
});

test('desktop companion manager restores saved bounds and state for startup', () => {
  const { manager } = createHarness({
    petWindowBounds: { x: 88, y: 77, width: 284, height: 536 },
    startAtLogin: true,
    lockPetPosition: true,
    alwaysOnTop: false,
  });

  const bounds = manager.getInitialBounds({ width: 284, height: 536 });
  const options = manager.getWindowBehaviorOptions();

  assert.deepEqual(bounds, { x: 88, y: 77, width: 284, height: 536 });
  assert.deepEqual(options, { movable: false, alwaysOnTop: false });
  assert.equal(manager.getState().startAtLogin, true);
});
