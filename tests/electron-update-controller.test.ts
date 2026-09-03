import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

const { createUpdateController } = require('../electron/update-controller');

class FakeUpdater extends EventEmitter {
  downloadCalls = 0;
  installCalls = 0;

  async checkForUpdates() {}

  async downloadUpdate() {
    this.downloadCalls += 1;
  }

  quitAndInstall() {
    this.installCalls += 1;
  }
}

function createScheduler() {
  let nextId = 1;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  return {
    setTimeout(callback: () => void, delay: number) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    run(delay: number) {
      const match = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      assert.ok(match, `Expected a ${delay}ms timer`);
      timers.delete(match[0]);
      match[1].callback();
    },
    has(delay: number) {
      return [...timers.values()].some((timer) => timer.delay === delay);
    },
  };
}

function createController(platform = 'win32') {
  const updater = new FakeUpdater();
  const nativeUpdater = new EventEmitter();
  const app = new EventEmitter() as EventEmitter & { getVersion: () => string };
  app.getVersion = () => '1.5.0';
  const scheduler = createScheduler();
  const controller = createUpdateController({
    updater,
    nativeUpdater,
    app,
    platform,
    currentVersion: app.getVersion,
    releasePageUrl: 'https://example.test/releases/latest',
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    setTimeoutImpl: scheduler.setTimeout,
    clearTimeoutImpl: scheduler.clearTimeout,
  });
  return { updater, nativeUpdater, app, scheduler, controller };
}

test('a repeated download request preserves a completed update', async () => {
  const { updater, controller } = createController();
  try {
    updater.emit('update-downloaded', { version: '1.5.5' });
    const result = await controller.downloadUpdate();
    assert.equal(result.stage, 'downloaded');
    assert.equal(result.availableVersion, '1.5.5');
    assert.equal(result.lastError, null);
    assert.equal(updater.downloadCalls, 0);
  } finally {
    controller.dispose();
  }
});

test('macOS waits for the native updater before enabling installation', () => {
  const { updater, nativeUpdater, scheduler, controller } = createController('darwin');
  try {
    updater.emit('update-downloaded', { version: '1.5.5' });
    assert.equal(controller.getStatus().stage, 'preparing_install');
    assert.equal(scheduler.has(120_000), true);

    nativeUpdater.emit('update-downloaded');
    assert.equal(controller.getStatus().stage, 'downloaded');
    assert.equal(scheduler.has(120_000), false);
  } finally {
    controller.dispose();
  }
});

test('macOS preparation timeout becomes an actionable update error', () => {
  const { updater, scheduler, controller } = createController('darwin');
  try {
    updater.emit('update-downloaded', { version: '1.5.5' });
    scheduler.run(120_000);
    const status = controller.getStatus();
    assert.equal(status.stage, 'error');
    assert.equal(status.lastError.reason, 'UPDATE_INSTALL_PREPARATION_TIMEOUT');
    assert.equal(status.releasePageUrl, 'https://example.test/releases/latest');
  } finally {
    controller.dispose();
  }
});

test('macOS native preparation errors keep their specific reason', () => {
  const { updater, nativeUpdater, controller } = createController('darwin');
  try {
    updater.emit('update-downloaded', { version: '1.5.5' });
    const error = new Error('ShipIt could not prepare the update');
    nativeUpdater.emit('error', error);
    updater.emit('error', error);
    assert.equal(controller.getStatus().lastError.reason, 'UPDATE_INSTALL_PREPARATION_FAILED');
  } finally {
    controller.dispose();
  }
});

test('install status is returned before quit-and-install starts', () => {
  const { updater, app, scheduler, controller } = createController();
  try {
    updater.emit('update-downloaded', { version: '1.5.5' });
    const status = controller.installUpdate();
    assert.equal(status.stage, 'installing');
    assert.equal(updater.installCalls, 0);

    scheduler.run(250);
    assert.equal(updater.installCalls, 1);
    assert.equal(scheduler.has(30_000), true);

    app.emit('before-quit');
    assert.equal(scheduler.has(30_000), false);
  } finally {
    controller.dispose();
  }
});

test('an installer handoff that does not quit reports a visible error', () => {
  const { updater, scheduler, controller } = createController();
  try {
    updater.emit('update-downloaded', { version: '1.5.5' });
    controller.installUpdate();
    scheduler.run(250);
    scheduler.run(30_000);
    const status = controller.getStatus();
    assert.equal(status.stage, 'error');
    assert.equal(status.lastError.reason, 'UPDATE_INSTALL_DID_NOT_START');
  } finally {
    controller.dispose();
  }
});
