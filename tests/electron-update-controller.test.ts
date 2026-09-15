import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const { createUpdateController } = require('../electron/update-controller');

class FakeUpdater extends EventEmitter {
  checkCalls = 0;
  downloadCalls = 0;
  installCalls = 0;

  async checkForUpdates() {
    this.checkCalls += 1;
  }

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

function createController(platform = 'win32', overrides: Record<string, unknown> = {}) {
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
    ...overrides,
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

test('a repeated update check cannot discard a downloaded update', async () => {
  const { updater, controller } = createController();
  try {
    updater.emit('update-downloaded', { version: '1.5.5' });

    const result = await controller.checkForUpdates(true);
    updater.emit('checking-for-update');
    updater.emit('update-available', { version: '1.5.5' });
    updater.emit('update-not-available');

    assert.equal(result.stage, 'downloaded');
    assert.equal(updater.checkCalls, 0);
    assert.equal(controller.getStatus().stage, 'downloaded');
    assert.equal(controller.getStatus().availableVersion, '1.5.5');
  } finally {
    controller.dispose();
  }
});

test('update checks preserve macOS preparation and installer handoff states', async () => {
  const mac = createController('darwin');
  const win = createController();
  try {
    mac.updater.emit('update-downloaded', { version: '1.5.5' });
    assert.equal((await mac.controller.checkForUpdates(true)).stage, 'preparing_install');
    assert.equal(mac.updater.checkCalls, 0);

    win.updater.emit('update-downloaded', { version: '1.5.5' });
    win.controller.installUpdate();
    assert.equal((await win.controller.checkForUpdates(true)).stage, 'installing');
    assert.equal(win.updater.checkCalls, 0);
  } finally {
    mac.controller.dispose();
    win.controller.dispose();
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

test('the install handoff drops the close guard before quit-and-install runs', () => {
  const order: string[] = [];
  const { updater, scheduler, controller } = createController('win32', {
    beforeInstallHandoff: () => {
      order.push('beforeInstallHandoff');
    },
  });
  updater.quitAndInstall = () => {
    order.push('quitAndInstall');
  };
  try {
    updater.emit('update-downloaded', { version: '1.5.5' });
    controller.installUpdate();
    scheduler.run(250);
    assert.deepEqual(order, ['beforeInstallHandoff', 'quitAndInstall']);
  } finally {
    controller.dispose();
  }
});

test('a rejected install request never touches the close guard', () => {
  let handoffs = 0;
  const { controller } = createController('win32', {
    beforeInstallHandoff: () => {
      handoffs += 1;
    },
  });
  try {
    assert.throws(() => controller.installUpdate(), /not ready to install yet/i);
    assert.equal(handoffs, 0);
  } finally {
    controller.dispose();
  }
});

test('a failing handoff hook surfaces as a visible install error', () => {
  const { updater, scheduler, controller } = createController('win32', {
    beforeInstallHandoff: () => {
      throw new Error('close guard could not be released');
    },
  });
  try {
    updater.emit('update-downloaded', { version: '1.5.5' });
    controller.installUpdate();
    scheduler.run(250);
    const status = controller.getStatus();
    assert.equal(status.stage, 'error');
    assert.equal(status.lastError.reason, 'UPDATE_INSTALL_FAILED');
    assert.equal(updater.installCalls, 0);
  } finally {
    controller.dispose();
  }
});

test('a handoff that never quits releases the quit guard again', () => {
  let quitting = false;
  const aborts: string[] = [];
  const { updater, scheduler, controller } = createController('win32', {
    beforeInstallHandoff: () => {
      quitting = true;
    },
    installHandoffAborted: (reason: string) => {
      aborts.push(reason);
      quitting = false;
    },
  });
  try {
    updater.emit('update-downloaded', { version: '1.5.5' });
    controller.installUpdate();
    scheduler.run(250);
    assert.equal(quitting, true);

    scheduler.run(30_000);
    assert.equal(quitting, false);
    assert.deepEqual(aborts, ['install_did_not_start']);
  } finally {
    controller.dispose();
  }
});

test('a handoff that throws releases the quit guard again', () => {
  let quitting = false;
  const aborts: string[] = [];
  const { updater, scheduler, controller } = createController('win32', {
    beforeInstallHandoff: () => {
      quitting = true;
      throw new Error('close guard could not be released');
    },
    installHandoffAborted: (reason: string) => {
      aborts.push(reason);
      quitting = false;
    },
  });
  try {
    updater.emit('update-downloaded', { version: '1.5.5' });
    controller.installUpdate();
    scheduler.run(250);
    assert.equal(quitting, false);
    assert.deepEqual(aborts, ['install_handoff_failed']);
  } finally {
    controller.dispose();
  }
});

test('an observed application quit keeps the guard armed for the installer', () => {
  let quitting = false;
  const aborts: string[] = [];
  const { updater, app, scheduler, controller } = createController('win32', {
    beforeInstallHandoff: () => {
      quitting = true;
    },
    installHandoffAborted: (reason: string) => {
      aborts.push(reason);
      quitting = false;
    },
  });
  try {
    updater.emit('update-downloaded', { version: '1.5.5' });
    controller.installUpdate();
    scheduler.run(250);
    app.emit('before-quit');

    assert.equal(scheduler.has(30_000), false);
    assert.equal(quitting, true);
    assert.deepEqual(aborts, []);
  } finally {
    controller.dispose();
  }
});

test('desktop main releases and restores the quit guard around the handoff', () => {
  const source = readFileSync(join(process.cwd(), 'electron', 'main.js'), 'utf-8');
  const start = source.indexOf('createUpdateController({');
  assert.ok(start > -1, 'electron/main.js should create the update controller');

  const end = source.indexOf('logger: updateLogger', start);
  assert.ok(end > start, 'the update controller options block should end with the logger');
  const stripped = source.slice(start, end).replace(/\/\/[^\n]*\n/g, ' ');

  assert.match(stripped, /beforeInstallHandoff:\s*\(\)\s*=>\s*\{\s*app\.isQuitting = true;/);
  assert.match(stripped, /installHandoffAborted:\s*\(\)\s*=>\s*\{\s*app\.isQuitting = false;/);
});
