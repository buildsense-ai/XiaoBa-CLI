import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

  test('preserves the last child error line when a service exits non-zero', async () => {
    const manager = new ServiceManager(process.cwd());
    const serviceRecord = (manager as any).services.get('weixin');
    serviceRecord.info.command = process.execPath;
    serviceRecord.info.args = [
      '-e',
      "console.error('[ERROR] [微信] 会话已过期，请重新登录 Authorization: Bearer wx-secret-token WEIXIN_TOKEN=wx-secret-token sk-live-secret1234567890'); process.exit(78);",
    ];

    const stopped = new Promise<void>(resolve => {
      manager.once('service-stopped', () => resolve());
    });

    manager.start('weixin');
    await stopped;

    const service = manager.getService('weixin');
    assert.equal(service?.status, 'error');
    assert.match(service?.lastError || '', /会话已过期/);
    assert.match(service?.lastError || '', /code 78/);
    assert.match(service?.lastError || '', /Authorization: \[redacted-token\]/);
    assert.match(service?.lastError || '', /WEIXIN_TOKEN=\[redacted-token\]/);
    assert.match(service?.lastError || '', /\[redacted-key\]/);
    assert.equal((service?.lastError || '').includes('wx-secret-token'), false);
    assert.equal((service?.lastError || '').includes('sk-live-secret1234567890'), false);
  });

  test('treats dashboard-requested service stop as stopped even when the child exits non-zero', async () => {
    const manager = new ServiceManager(process.cwd());
    const serviceRecord = (manager as any).services.get('weixin');
    serviceRecord.info.command = process.execPath;
    serviceRecord.info.args = [
      '-e',
      "console.error('[ERROR] transient startup line'); setInterval(() => {}, 1000);",
    ];

    const stopped = new Promise<void>(resolve => {
      manager.once('service-stopped', () => resolve());
    });

    manager.start('weixin');
    manager.stop('weixin');
    await stopped;

    const service = manager.getService('weixin');
    assert.equal(service?.status, 'stopped');
    assert.equal(service?.lastError, undefined);
  });
});

function normalize(value: string): string {
  return value.split(path.sep).join('/');
}
