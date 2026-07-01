const path = require('path');

const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const START_AT_LOGIN_RUN_VALUE = 'CatsCo Companion';
const DESKTOP_STATE_CHANNEL = 'catsco:pet:desktop-state-changed';
const DEFAULT_SNAP_DISTANCE = 28;
const DEFAULT_MIN_VISIBLE = 64;
const DEFAULT_WINDOW_SIZE = { width: 284, height: 536, minWidth: 240, minHeight: 440 };

function createDesktopCompanionManager(options) {
  const app = options.app;
  const screen = options.screen;
  const spawnSync = options.spawnSync;
  const processLike = options.process || process;
  const logger = options.console || console;
  const readDesktopConfig = options.readDesktopConfig;
  const writePreferencePatch = options.writePreferencePatch;
  const snapDistance = Number(options.snapDistance || DEFAULT_SNAP_DISTANCE);
  let petWindow = null;
  let moveSettleTimer = null;
  let isSnapping = false;

  function readPreferences() {
    return readDesktopConfig()?.preferences || {};
  }

  function readStartAtLoginPreference() {
    return Boolean(readPreferences().startAtLogin);
  }

  function readLockPetPositionPreference() {
    return Boolean(readPreferences().lockPetPosition);
  }

  function readAlwaysOnTopPreference() {
    return readPreferences().alwaysOnTop !== false;
  }

  function readPetWindowBounds() {
    return sanitizePetWindowBounds(readPreferences().petWindowBounds);
  }

  function savePetWindowBounds(bounds) {
    const next = sanitizePetWindowBounds(bounds);
    if (!next) return null;
    writePreferencePatch({ petWindowBounds: next });
    return next;
  }

  function getState() {
    return {
      startAtLogin: readStartAtLoginPreference(),
      lockPetPosition: readLockPetPositionPreference(),
      alwaysOnTop: readAlwaysOnTopPreference(),
      snapDistance,
      petWindowBounds: readPetWindowBounds(),
    };
  }

  function getWindowBehaviorOptions() {
    return {
      movable: !readLockPetPositionPreference(),
      alwaysOnTop: readAlwaysOnTopPreference(),
    };
  }

  function getInitialBounds(size = DEFAULT_WINDOW_SIZE) {
    const width = Number(size.width || DEFAULT_WINDOW_SIZE.width);
    const height = Number(size.height || DEFAULT_WINDOW_SIZE.height);
    const savedBounds = readPetWindowBounds();
    if (savedBounds) return savedBounds;

    const { workArea } = screen.getPrimaryDisplay();
    return sanitizePetWindowBounds({
      x: Math.max(workArea.x, workArea.x + workArea.width - width - 28),
      y: Math.max(workArea.y, workArea.y + workArea.height - height - 64),
      width,
      height,
    });
  }

  function sanitizePetWindowBounds(bounds) {
    if (!bounds || typeof bounds !== 'object') return null;

    const width = Number(bounds.width);
    const height = Number(bounds.height);
    const x = Number(bounds.x);
    const y = Number(bounds.y);
    if (![width, height, x, y].every(Number.isFinite)) return null;

    const display = screen.getDisplayMatching({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    }) || screen.getPrimaryDisplay();
    const { workArea } = display;
    const safeWidth = Math.max(DEFAULT_WINDOW_SIZE.minWidth, Math.min(Math.round(width), workArea.width));
    const safeHeight = Math.max(DEFAULT_WINDOW_SIZE.minHeight, Math.min(Math.round(height), workArea.height));
    const minX = workArea.x - safeWidth + DEFAULT_MIN_VISIBLE;
    const maxX = workArea.x + workArea.width - DEFAULT_MIN_VISIBLE;
    const minY = workArea.y;
    const maxY = workArea.y + workArea.height - DEFAULT_MIN_VISIBLE;

    return {
      x: Math.round(Math.min(Math.max(x, minX), maxX)),
      y: Math.round(Math.min(Math.max(y, minY), maxY)),
      width: safeWidth,
      height: safeHeight,
    };
  }

  function snapBoundsToEdge(bounds) {
    const safeBounds = sanitizePetWindowBounds(bounds);
    if (!safeBounds) return null;

    const display = screen.getDisplayMatching(safeBounds) || screen.getPrimaryDisplay();
    const { workArea } = display;
    const right = safeBounds.x + safeBounds.width;
    const bottom = safeBounds.y + safeBounds.height;
    let x = safeBounds.x;
    let y = safeBounds.y;

    if (Math.abs(safeBounds.x - workArea.x) <= snapDistance) {
      x = workArea.x;
    } else if (Math.abs(right - (workArea.x + workArea.width)) <= snapDistance) {
      x = workArea.x + workArea.width - safeBounds.width;
    }

    if (Math.abs(safeBounds.y - workArea.y) <= snapDistance) {
      y = workArea.y;
    } else if (Math.abs(bottom - (workArea.y + workArea.height)) <= snapDistance) {
      y = workArea.y + workArea.height - safeBounds.height;
    }

    return sanitizePetWindowBounds({ ...safeBounds, x, y });
  }

  function applyWindowBehavior(targetWindow = petWindow) {
    if (!targetWindow) return;
    const behavior = getWindowBehaviorOptions();
    if (typeof targetWindow.setMovable === 'function') {
      targetWindow.setMovable(behavior.movable);
    }
    if (typeof targetWindow.setAlwaysOnTop === 'function') {
      targetWindow.setAlwaysOnTop(behavior.alwaysOnTop, behavior.alwaysOnTop ? 'floating' : undefined);
    }
  }

  function publishState() {
    const state = getState();
    if (petWindow?.webContents?.send) {
      petWindow.webContents.send(DESKTOP_STATE_CHANNEL, state);
    }
    return state;
  }

  function settlePetWindowBounds(targetWindow = petWindow) {
    if (!targetWindow || typeof targetWindow.getBounds !== 'function') return null;
    const currentBounds = targetWindow.getBounds();
    const snappedBounds = snapBoundsToEdge(currentBounds) || sanitizePetWindowBounds(currentBounds);
    if (!snappedBounds) return null;

    const changed = currentBounds.x !== snappedBounds.x
      || currentBounds.y !== snappedBounds.y
      || currentBounds.width !== snappedBounds.width
      || currentBounds.height !== snappedBounds.height;

    if (changed && typeof targetWindow.setBounds === 'function' && !isSnapping) {
      isSnapping = true;
      try {
        targetWindow.setBounds(snappedBounds, true);
      } finally {
        isSnapping = false;
      }
    }

    return savePetWindowBounds(snappedBounds);
  }

  function schedulePetWindowSettle() {
    if (moveSettleTimer) clearTimeout(moveSettleTimer);
    moveSettleTimer = setTimeout(() => {
      moveSettleTimer = null;
      settlePetWindowBounds();
    }, 160);
  }

  function attachPetWindow(targetWindow) {
    petWindow = targetWindow;
    applyWindowBehavior(targetWindow);

    targetWindow.on('move', schedulePetWindowSettle);
    targetWindow.on('moved', () => settlePetWindowBounds(targetWindow));
    targetWindow.on('resized', () => settlePetWindowBounds(targetWindow));
    targetWindow.on('closed', () => {
      if (moveSettleTimer) clearTimeout(moveSettleTimer);
      moveSettleTimer = null;
      if (petWindow === targetWindow) petWindow = null;
    });

    publishState();
    return targetWindow;
  }

  function setLockPetPosition(value) {
    writePreferencePatch({ lockPetPosition: Boolean(value) });
    applyWindowBehavior();
    return publishState();
  }

  function setAlwaysOnTop(value) {
    writePreferencePatch({ alwaysOnTop: Boolean(value) });
    applyWindowBehavior();
    return publishState();
  }

  function setStartAtLogin(value) {
    writePreferencePatch({ startAtLogin: Boolean(value) });
    syncLoginItemSettings();
    return publishState();
  }

  function getStartAtLoginLaunchArgs() {
    if (processLike.defaultApp && processLike.argv && processLike.argv.length >= 2) {
      return [path.resolve(processLike.argv[1])];
    }
    return [];
  }

  function getStartAtLoginCommandLine() {
    const quote = (value) => `"${String(value || '').replace(/"/g, '\\"')}"`;
    return [processLike.execPath, ...getStartAtLoginLaunchArgs()].map(quote).join(' ');
  }

  function syncLoginItemSettings() {
    const openAtLogin = readStartAtLoginPreference();
    try {
      app.setLoginItemSettings({
        openAtLogin,
        openAsHidden: false,
        ...(getStartAtLoginLaunchArgs().length > 0
          ? { path: processLike.execPath, args: getStartAtLoginLaunchArgs() }
          : {}),
      });
    } catch (error) {
      logger.warn('Failed to sync start-at-login preference:', error?.message || error);
    }
    syncWindowsRunAtLoginFallback();
    return getState();
  }

  function syncWindowsRunAtLoginFallback() {
    if (processLike.platform !== 'win32') return;
    const openAtLogin = readStartAtLoginPreference();
    const args = openAtLogin
      ? ['add', WINDOWS_RUN_KEY, '/v', START_AT_LOGIN_RUN_VALUE, '/t', 'REG_SZ', '/d', getStartAtLoginCommandLine(), '/f']
      : ['delete', WINDOWS_RUN_KEY, '/v', START_AT_LOGIN_RUN_VALUE, '/f'];
    const result = spawnSync('reg', args, { windowsHide: true, stdio: 'ignore' });
    if (result.error && openAtLogin) {
      logger.warn('Failed to sync Windows start-at-login fallback:', result.error.message || result.error);
    }
  }

  return {
    attachPetWindow,
    getInitialBounds,
    getState,
    getWindowBehaviorOptions,
    readAlwaysOnTopPreference,
    readLockPetPositionPreference,
    readPetWindowBounds,
    readStartAtLoginPreference,
    savePetWindowBounds,
    sanitizePetWindowBounds,
    setAlwaysOnTop,
    setLockPetPosition,
    setStartAtLogin,
    settlePetWindowBounds,
    snapBoundsToEdge,
    syncLoginItemSettings,
  };
}

module.exports = {
  createDesktopCompanionManager,
  DESKTOP_STATE_CHANNEL,
};
