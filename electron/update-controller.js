'use strict';

const { normalizeUpdateError } = require('./update-errors');

const DEFAULT_PREPARATION_TIMEOUT_MS = 120_000;
const DEFAULT_INSTALL_DELAY_MS = 250;
const DEFAULT_INSTALL_TIMEOUT_MS = 30_000;
const DOWNLOAD_COMPLETE_STAGES = new Set(['preparing_install', 'downloaded', 'installing']);

function createUpdateController(options) {
  const {
    updater,
    nativeUpdater,
    app,
    platform = process.platform,
    currentVersion = () => app?.getVersion?.() || null,
    releasePageUrl = null,
    updateBaseUrl = null,
    logger = console,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    preparationTimeoutMs = DEFAULT_PREPARATION_TIMEOUT_MS,
    installDelayMs = DEFAULT_INSTALL_DELAY_MS,
    installTimeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
  } = options || {};

  const state = {
    enabled: Boolean(updater),
    stage: updater ? 'idle' : 'disabled',
    message: updater ? 'Updater is ready' : 'Updater is unavailable',
    currentVersion: currentVersion(),
    availableVersion: null,
    releaseNotes: null,
    releasePageUrl,
    updateBaseUrl,
    percent: 0,
    bytesPerSecond: 0,
    transferred: 0,
    total: 0,
    checkedAt: null,
    updatedAt: Date.now(),
    isManualCheck: false,
    lastError: null,
  };

  let checkInFlight = null;
  let downloadInFlight = null;
  let preparationTimer = null;
  let installDelayTimer = null;
  let installWatchdogTimer = null;
  let nativeInstallReady = platform !== 'darwin';
  let appQuitObserved = false;
  let lastLoggedProgressBucket = -1;
  const updaterListeners = [];
  const nativeListeners = [];

  function snapshot() {
    return { ...state, lastError: state.lastError ? { ...state.lastError } : null };
  }

  function setState(patch) {
    const previousStage = state.stage;
    Object.assign(state, patch, {
      currentVersion: currentVersion(),
      updatedAt: Date.now(),
    });
    if (state.stage !== previousStage) {
      logger.info?.(`state ${previousStage} -> ${state.stage}: ${state.message || ''}`);
    }
  }

  function clearTimer(timer) {
    if (timer) clearTimeoutImpl(timer);
  }

  function clearPreparationTimer() {
    clearTimer(preparationTimer);
    preparationTimer = null;
  }

  function clearInstallTimers() {
    clearTimer(installDelayTimer);
    clearTimer(installWatchdogTimer);
    installDelayTimer = null;
    installWatchdogTimer = null;
  }

  function markError(error, fallbackReason = 'UPDATE_ERROR') {
    clearPreparationTimer();
    clearInstallTimers();
    const normalized = normalizeUpdateError(error, fallbackReason);
    if (state.stage === 'error' && state.lastError?.message === normalized.message) {
      const existing = new Error(state.lastError.message);
      existing.reason = state.lastError.reason;
      return existing;
    }
    logger.error?.(`${normalized.reason}: ${normalized.message}`);
    setState({
      stage: 'error',
      message: `Update failed: ${normalized.reason}`,
      lastError: normalized,
    });

    const wrapped = new Error(normalized.message);
    wrapped.reason = normalized.reason;
    return wrapped;
  }

  function startPreparationTimeout() {
    clearPreparationTimer();
    preparationTimer = setTimeoutImpl(() => {
      preparationTimer = null;
      if (state.stage !== 'preparing_install') return;
      markError(
        new Error('macOS timed out while preparing the downloaded update for installation'),
        'UPDATE_INSTALL_PREPARATION_TIMEOUT',
      );
    }, preparationTimeoutMs);
  }

  function markDownloaded(info = {}) {
    clearPreparationTimer();
    setState({
      stage: 'downloaded',
      message: `Update ${info.version || state.availableVersion || ''} downloaded`.trim(),
      availableVersion: info.version || state.availableVersion,
      percent: 100,
      bytesPerSecond: 0,
      transferred: state.total || state.transferred,
      total: state.total || state.transferred,
      lastError: null,
    });
  }

  function on(emitter, eventName, listener, collection) {
    if (!emitter?.on) return;
    emitter.on(eventName, listener);
    collection.push([emitter, eventName, listener]);
  }

  function removeListeners(collection) {
    for (const [emitter, eventName, listener] of collection) {
      emitter.removeListener?.(eventName, listener);
    }
    collection.length = 0;
  }

  if (updater) {
    on(updater, 'checking-for-update', () => {
      if (DOWNLOAD_COMPLETE_STAGES.has(state.stage)) {
        logger.info?.(`ignored checking-for-update event while state is ${state.stage}`);
        return;
      }
      setState({
        stage: 'checking',
        message: 'Checking for updates...',
        checkedAt: Date.now(),
        lastError: null,
      });
    }, updaterListeners);

    on(updater, 'update-available', (info = {}) => {
      if (DOWNLOAD_COMPLETE_STAGES.has(state.stage)) {
        logger.info?.(`ignored update-available event while state is ${state.stage}`);
        return;
      }
      nativeInstallReady = platform !== 'darwin';
      setState({
        stage: 'available',
        message: `Update ${info.version || ''} is available`,
        availableVersion: info.version || null,
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
        percent: 0,
        bytesPerSecond: 0,
        transferred: 0,
        total: 0,
        lastError: null,
      });
    }, updaterListeners);

    on(updater, 'update-not-available', () => {
      if (DOWNLOAD_COMPLETE_STAGES.has(state.stage)) return;
      setState({
        stage: 'idle',
        message: 'Already on the latest version',
        availableVersion: null,
        releaseNotes: null,
        percent: 0,
        bytesPerSecond: 0,
        transferred: 0,
        total: 0,
        lastError: null,
      });
    }, updaterListeners);

    on(updater, 'download-progress', (progress = {}) => {
      const percent = Number(progress.percent || 0);
      setState({
        stage: 'downloading',
        message: 'Downloading update...',
        percent,
        bytesPerSecond: Number(progress.bytesPerSecond || 0),
        transferred: Number(progress.transferred || 0),
        total: Number(progress.total || 0),
      });
      const bucket = Math.floor(percent / 10);
      if (bucket !== lastLoggedProgressBucket) {
        lastLoggedProgressBucket = bucket;
        logger.info?.(`download progress ${Math.round(percent)}% (${state.transferred}/${state.total})`);
      }
    }, updaterListeners);

    on(updater, 'update-downloaded', (info = {}) => {
      if (platform === 'darwin' && !nativeInstallReady) {
        setState({
          stage: 'preparing_install',
          message: 'Download complete; macOS is preparing the update for installation...',
          availableVersion: info.version || state.availableVersion,
          percent: 100,
          bytesPerSecond: 0,
          transferred: state.total || state.transferred,
          total: state.total || state.transferred,
          lastError: null,
        });
        startPreparationTimeout();
        return;
      }
      markDownloaded(info);
    }, updaterListeners);

    on(updater, 'error', (error) => {
      markError(error, 'UPDATE_RUNTIME_ERROR');
    }, updaterListeners);
  }

  if (platform === 'darwin' && nativeUpdater && nativeUpdater !== updater) {
    on(nativeUpdater, 'update-downloaded', () => {
      nativeInstallReady = true;
      logger.info?.('macOS native updater reports the update is ready to install');
      if (state.stage === 'preparing_install') markDownloaded();
    }, nativeListeners);
    on(nativeUpdater, 'error', (error) => {
      if (state.stage === 'preparing_install' || state.stage === 'installing') {
        markError(error, 'UPDATE_INSTALL_PREPARATION_FAILED');
      }
    }, nativeListeners);
  }

  const onBeforeQuit = () => {
    appQuitObserved = true;
    clearInstallTimers();
    logger.info?.('application quit observed; installer handoff started');
  };
  on(app, 'before-quit', onBeforeQuit, nativeListeners);

  return {
    getStatus: snapshot,

    async checkForUpdates(manual = false) {
      if (!updater) return snapshot();
      if (DOWNLOAD_COMPLETE_STAGES.has(state.stage)) {
        logger.info?.(`ignored update check while state is ${state.stage}`);
        return snapshot();
      }
      if (checkInFlight) return checkInFlight;

      setState({
        stage: 'checking',
        message: manual ? 'Checking for updates...' : 'Checking for updates in background...',
        isManualCheck: Boolean(manual),
        checkedAt: Date.now(),
        lastError: null,
      });

      checkInFlight = updater.checkForUpdates()
        .then(snapshot)
        .catch((error) => { throw markError(error, 'UPDATE_CHECK_FAILED'); })
        .finally(() => { checkInFlight = null; });
      return checkInFlight;
    },

    async downloadUpdate() {
      if (!updater) {
        throw markError(new Error('Updater is unavailable'), 'UPDATER_UNAVAILABLE');
      }
      if (downloadInFlight) return downloadInFlight;
      if (DOWNLOAD_COMPLETE_STAGES.has(state.stage)) {
        logger.info?.(`ignored duplicate download request while state is ${state.stage}`);
        return snapshot();
      }
      if (state.stage !== 'available' && state.stage !== 'downloading') {
        throw markError(new Error('No available update to download'), 'UPDATE_NOT_AVAILABLE');
      }

      nativeInstallReady = platform !== 'darwin';
      lastLoggedProgressBucket = -1;
      setState({
        stage: 'downloading',
        message: 'Starting update download...',
        percent: 0,
        bytesPerSecond: 0,
        transferred: 0,
        total: 0,
        lastError: null,
      });

      downloadInFlight = updater.downloadUpdate()
        .then(snapshot)
        .catch((error) => { throw markError(error, 'UPDATE_DOWNLOAD_FAILED'); })
        .finally(() => { downloadInFlight = null; });
      return downloadInFlight;
    },

    installUpdate() {
      if (!updater) {
        throw markError(new Error('Updater is unavailable'), 'UPDATER_UNAVAILABLE');
      }
      if (state.stage === 'installing') return snapshot();
      if (state.stage !== 'downloaded') {
        throw markError(new Error('Update package is not ready to install yet'), 'UPDATE_NOT_READY');
      }

      appQuitObserved = false;
      setState({
        stage: 'installing',
        message: 'Quitting and installing update...',
        lastError: null,
      });

      installDelayTimer = setTimeoutImpl(() => {
        installDelayTimer = null;
        try {
          logger.info?.('requesting updater quit-and-install handoff');
          updater.quitAndInstall();
        } catch (error) {
          markError(error, 'UPDATE_INSTALL_FAILED');
          return;
        }

        installWatchdogTimer = setTimeoutImpl(() => {
          installWatchdogTimer = null;
          if (appQuitObserved || state.stage !== 'installing') return;
          markError(
            new Error('The installer did not start after CatsCo requested the update handoff'),
            'UPDATE_INSTALL_DID_NOT_START',
          );
        }, installTimeoutMs);
      }, installDelayMs);

      return snapshot();
    },

    dispose() {
      clearPreparationTimer();
      clearInstallTimers();
      removeListeners(updaterListeners);
      removeListeners(nativeListeners);
    },
  };
}

module.exports = {
  DEFAULT_INSTALL_DELAY_MS,
  DEFAULT_INSTALL_TIMEOUT_MS,
  DEFAULT_PREPARATION_TIMEOUT_MS,
  createUpdateController,
};
