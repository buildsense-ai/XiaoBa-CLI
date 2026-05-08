import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { ServiceManager } from '../src/dashboard/service-manager';

describe('dashboard service manager', () => {
  test('uses node plus the tsx CLI entry in development', () => {
    const envKeys = [
      'XIAOBA_APP_ROOT',
      'XIAOBA_IS_PACKAGED',
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
});

function normalize(value: string): string {
  return value.split(path.sep).join('/');
}
