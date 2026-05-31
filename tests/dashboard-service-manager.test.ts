import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { ServiceManager } from '../src/dashboard/service-manager';

describe('dashboard service manager', () => {
  test('uses node plus the tsx CLI entry in development', () => {
    const envKeys = [
      'XIAOBA_APP_ROOT',
      'XIAOBA_IS_PACKAGED',
      'XIAOBA_NODE_EXECUTABLE',
      'XIAOBA_RUNTIME_ROOT',
      'npm_node_execpath',
    ];
    const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));

    process.env.XIAOBA_APP_ROOT = process.cwd();
    process.env.XIAOBA_IS_PACKAGED = '0';
    delete process.env.XIAOBA_RUNTIME_ROOT;
    process.env.npm_node_execpath = process.execPath;

    try {
      const manager = new ServiceManager(process.cwd());
      const service = manager.getService('catscompany');

      assert.ok(service);
      assert.equal(service.command, process.execPath);
      assert.match(normalize(service.args[0]), /node_modules\/tsx\/dist\/cli\.mjs$/);
      assert.match(normalize(service.args[1]), /src\/index\.ts$/);
      assert.equal(service.args[2], 'catscompany');
    } finally {
      for (const key of envKeys) {
        const value = previousEnv.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('uses bundled node and dist entry in packaged mode', () => {
    const envKeys = [
      'XIAOBA_APP_ROOT',
      'XIAOBA_IS_PACKAGED',
      'XIAOBA_NODE_EXECUTABLE',
      'XIAOBA_RUNTIME_ROOT',
      'npm_node_execpath',
    ];
    const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-packaged-app-'));
    const bundledNode = process.platform === 'win32'
      ? path.join(appRoot, 'build-resources', 'runtime', 'node', 'node.exe')
      : path.join(appRoot, 'build-resources', 'runtime', 'node', 'bin', 'node');
    fs.mkdirSync(path.dirname(bundledNode), { recursive: true });
    fs.writeFileSync(bundledNode, '');

    process.env.XIAOBA_APP_ROOT = appRoot;
    process.env.XIAOBA_IS_PACKAGED = '1';
    delete process.env.XIAOBA_RUNTIME_ROOT;
    process.env.npm_node_execpath = process.execPath;

    try {
      const manager = new ServiceManager(process.cwd());
      const service = manager.getService('catscompany');

      assert.ok(service);
      assert.equal(service.command, bundledNode);
      assert.match(normalize(service.args[0]), /dist\/index\.js$/);
      assert.equal(service.args[1], 'catscompany');
    } finally {
      for (const key of envKeys) {
        const value = previousEnv.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(appRoot, { recursive: true, force: true });
    }
  });

  test('development prefers the pinned real node executable over polluted PATH shims', () => {
    const envKeys = [
      'XIAOBA_APP_ROOT',
      'XIAOBA_IS_PACKAGED',
      'XIAOBA_NODE_EXECUTABLE',
      'XIAOBA_RUNTIME_ROOT',
      'npm_node_execpath',
    ];
    const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-runtime-node-'));
    const realNode = process.platform === 'win32'
      ? path.join(runtimeRoot, 'node.exe')
      : path.join(runtimeRoot, 'node');
    fs.writeFileSync(realNode, '');

    process.env.XIAOBA_APP_ROOT = process.cwd();
    process.env.XIAOBA_IS_PACKAGED = '0';
    process.env.XIAOBA_NODE_EXECUTABLE = realNode;
    process.env.npm_node_execpath = path.join(runtimeRoot, process.platform === 'win32' ? 'node.cmd' : 'node-shim');
    delete process.env.XIAOBA_RUNTIME_ROOT;

    try {
      const manager = new ServiceManager(process.cwd());
      const service = manager.getService('catscompany');

      assert.ok(service);
      assert.equal(service.command, realNode);
      assert.match(normalize(service.args[0]), /node_modules\/tsx\/dist\/cli\.mjs$/);
    } finally {
      for (const key of envKeys) {
        const value = previousEnv.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  test('catscompany start pins local CatsCo config path to the runtime cwd', async () => {
    const envKeys = [
      'XIAOBA_APP_ROOT',
      'XIAOBA_IS_PACKAGED',
      'XIAOBA_NODE_EXECUTABLE',
      'XIAOBA_RUNTIME_ROOT',
      'npm_node_execpath',
      'CATSCO_LOCAL_CONFIG_PATH',
      'CATSCO_CONFIG_PATH',
    ];
    const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
    const previousCwd = process.cwd();
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-catsco-runtime-'));
    const bogusRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-catsco-bogus-'));
    const capturedEnvPath = path.join(runtimeRoot, 'captured-env.json');

    writeCatsCoConfig(runtimeRoot, 'local');
    writeCatsCoConfig(bogusRoot, 'bogus');
    const expectedConfigPath = fs.realpathSync(path.join(runtimeRoot, '.xiaoba', 'catsco.json'));

    process.env.XIAOBA_APP_ROOT = previousCwd;
    process.env.XIAOBA_IS_PACKAGED = '0';
    delete process.env.XIAOBA_NODE_EXECUTABLE;
    process.env.XIAOBA_RUNTIME_ROOT = bogusRoot;
    process.env.npm_node_execpath = process.execPath;
    process.env.CATSCO_LOCAL_CONFIG_PATH = path.join(bogusRoot, '.xiaoba', 'catsco.json');
    process.env.CATSCO_CONFIG_PATH = path.join(bogusRoot, '.xiaoba', 'catsco.json');
    process.chdir(runtimeRoot);

    try {
      const manager = new ServiceManager(previousCwd) as any;
      const service = manager.services.get('catscompany');
      const keys = [
        'CATSCO_LOCAL_CONFIG_PATH',
        'CATSCO_CONFIG_PATH',
        'CATSCO_API_KEY',
        'CATSCO_BOT_UID',
        'CATSCO_BODY_ID',
      ];
      const captureScript = `
        const fs = require('fs');
        const keys = ${JSON.stringify(keys)};
        const captured = Object.fromEntries(keys.map((key) => [key, process.env[key] || '']));
        fs.writeFileSync(process.argv[1], JSON.stringify(captured, null, 2));
      `;
      service.info.command = process.execPath;
      service.info.args = ['-e', captureScript, capturedEnvPath];

      const stopped = new Promise<void>((resolve, reject) => {
        manager.once('service-stopped', (name: string, code: number) => {
          if (name !== 'catscompany') return;
          if (code === 0) resolve();
          else reject(new Error(`catscompany capture exited with code ${code}`));
        });
        manager.once('service-error', (_name: string, error: Error) => reject(error));
      });

      manager.start('catscompany');
      await stopped;

      const captured = JSON.parse(fs.readFileSync(capturedEnvPath, 'utf-8'));
      assert.equal(fs.realpathSync(captured.CATSCO_LOCAL_CONFIG_PATH), expectedConfigPath);
      assert.equal(fs.realpathSync(captured.CATSCO_CONFIG_PATH), expectedConfigPath);
      assert.equal(captured.CATSCO_API_KEY, 'api-local');
      assert.equal(captured.CATSCO_BOT_UID, 'bot-local');
      assert.equal(captured.CATSCO_BODY_ID, 'body-local');
    } finally {
      process.chdir(previousCwd);
      for (const key of envKeys) {
        const value = previousEnv.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
      fs.rmSync(bogusRoot, { recursive: true, force: true });
    }
  });

  test('weixin start receives current agent and bound channel context', async () => {
    const envKeys = [
      'XIAOBA_APP_ROOT',
      'XIAOBA_IS_PACKAGED',
      'XIAOBA_NODE_EXECUTABLE',
      'XIAOBA_RUNTIME_ROOT',
      'npm_node_execpath',
      'CATSCO_LOCAL_CONFIG_PATH',
      'CATSCO_CONFIG_PATH',
      'WEIXIN_TOKEN',
      'WEIXIN_BOUND_AGENT_UID',
      'WEIXIN_BOUND_AGENT_NAME',
      'WEIXIN_BOUND_BODY_ID',
      'WEIXIN_BOUND_BY_USER_UID',
      'CURRENT_AGENT_DISPLAY_NAME',
    ];
    const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
    const previousCwd = process.cwd();
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-weixin-runtime-'));
    const capturedEnvPath = path.join(runtimeRoot, 'captured-weixin-env.json');

    writeCatsCoConfig(runtimeRoot, 'local');
    writeWeixinBinding(runtimeRoot, 'local');

    process.env.XIAOBA_APP_ROOT = previousCwd;
    process.env.XIAOBA_IS_PACKAGED = '0';
    delete process.env.XIAOBA_NODE_EXECUTABLE;
    process.env.XIAOBA_RUNTIME_ROOT = runtimeRoot;
    process.env.npm_node_execpath = process.execPath;
    process.env.WEIXIN_TOKEN = 'wx-local-token';
    process.chdir(runtimeRoot);

    try {
      const manager = new ServiceManager(previousCwd) as any;
      const service = manager.services.get('weixin');
      const keys = [
        'CATSCO_LOCAL_CONFIG_PATH',
        'CATSCO_CONFIG_PATH',
        'CATSCO_API_KEY',
        'CATSCO_BOT_UID',
        'CATSCO_BODY_ID',
        'WEIXIN_TOKEN',
        'WEIXIN_BOUND_AGENT_UID',
        'WEIXIN_BOUND_AGENT_NAME',
        'WEIXIN_BOUND_BODY_ID',
        'WEIXIN_BOUND_BY_USER_UID',
        'CURRENT_AGENT_DISPLAY_NAME',
      ];
      const captureScript = `
        const fs = require('fs');
        const keys = ${JSON.stringify(keys)};
        const captured = Object.fromEntries(keys.map((key) => [key, process.env[key] || '']));
        fs.writeFileSync(process.argv[1], JSON.stringify(captured, null, 2));
      `;
      service.info.command = process.execPath;
      service.info.args = ['-e', captureScript, capturedEnvPath];

      const stopped = new Promise<void>((resolve, reject) => {
        manager.once('service-stopped', (name: string, code: number) => {
          if (name !== 'weixin') return;
          if (code === 0) resolve();
          else reject(new Error(`weixin capture exited with code ${code}`));
        });
        manager.once('service-error', (_name: string, error: Error) => reject(error));
      });

      manager.start('weixin');
      await stopped;

      const captured = JSON.parse(fs.readFileSync(capturedEnvPath, 'utf-8'));
      assert.equal(captured.CATSCO_BOT_UID, 'bot-local');
      assert.equal(captured.CATSCO_BODY_ID, 'body-local');
      assert.equal(captured.WEIXIN_TOKEN, 'wx-local-token');
      assert.equal(captured.WEIXIN_BOUND_AGENT_UID, 'bot-local');
      assert.equal(captured.WEIXIN_BOUND_AGENT_NAME, 'Bot local');
      assert.equal(captured.WEIXIN_BOUND_BODY_ID, 'body-local');
      assert.equal(captured.WEIXIN_BOUND_BY_USER_UID, 'user-local');
      assert.equal(captured.CURRENT_AGENT_DISPLAY_NAME, 'Bot local');
    } finally {
      process.chdir(previousCwd);
      for (const key of envKeys) {
        const value = previousEnv.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  test('restartAndWait waits for the old process to exit before starting again', async () => {
    const manager = new ServiceManager(process.cwd()) as any;
    const proc = new FakeChildProcess();
    const service = {
      info: {
        name: 'catscompany',
        label: 'CatsCo agent',
        command: process.execPath,
        args: [],
        status: 'running',
        pid: proc.pid,
        startedAt: Date.now(),
      },
      process: proc,
      logs: [],
    };
    manager.services.set('catscompany', service);
    const events: string[] = [];
    manager.start = (name: string) => {
      events.push(`start:${name}:${service.info.status}`);
      service.info.status = 'running';
      service.info.pid = 456;
      return { ...service.info };
    };

    const restartPromise = manager.restartAndWait('catscompany', 2000);
    events.push(`after-call:${service.info.status}`);
    assert.deepStrictEqual(events, ['after-call:running']);
    proc.exit(0);
    const restarted = await restartPromise;

    assert.equal(restarted.status, 'running');
    assert.equal(restarted.pid, 456);
    assert.deepStrictEqual(events, ['after-call:running', 'start:catscompany:running']);
    assert.equal(proc.killSignals.includes('SIGTERM'), true);
  });
});

function normalize(value: string): string {
  return value.split(path.sep).join('/');
}

function writeCatsCoConfig(root: string, suffix: string): void {
  const dir = path.join(root, '.xiaoba');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'catsco.json'), JSON.stringify({
    version: 1,
    endpoints: {
      httpBaseUrl: `https://catsco-${suffix}.test`,
      serverUrl: `wss://catsco-${suffix}.test/v0/channels`,
    },
    account: {
      token: `token-${suffix}`,
      uid: `user-${suffix}`,
      username: `user_${suffix}`,
      displayName: `User ${suffix}`,
    },
    currentBot: {
      uid: `bot-${suffix}`,
      name: `Bot ${suffix}`,
      username: `bot_${suffix}`,
      apiKey: `api-${suffix}`,
      boundByUserUid: `user-${suffix}`,
      bindingSource: 'explicit',
    },
    device: {
      deviceId: `device-${suffix}`,
      bodyId: `body-${suffix}`,
      installationId: `install-${suffix}`,
    },
  }, null, 2));
}

function writeWeixinBinding(root: string, suffix: string): void {
  const dir = path.join(root, '.xiaoba');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'channel-bindings.json'), JSON.stringify({
    version: 1,
    weixin: {
      channel: 'weixin',
      agentUid: `bot-${suffix}`,
      agentName: `Bot ${suffix}`,
      agentUsername: `bot_${suffix}`,
      bodyId: `body-${suffix}`,
      boundByUserUid: `user-${suffix}`,
      boundByUsername: `user_${suffix}`,
      tokenHash: 'hash',
      tokenLast4: 'oken',
      legacyEnvKey: 'WEIXIN_TOKEN',
      createdAt: '2026-05-31T00:00:00.000Z',
      updatedAt: '2026-05-31T00:00:00.000Z',
    },
  }, null, 2));
}

class FakeChildProcess extends EventEmitter {
  pid = 123;
  killed = false;
  killSignals: string[] = [];
  stdout = new EventEmitter();
  stderr = new EventEmitter();

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.killSignals.push(signal || 'SIGTERM');
    return true;
  }

  exit(code: number): void {
    this.emit('exit', code, null);
  }
}
