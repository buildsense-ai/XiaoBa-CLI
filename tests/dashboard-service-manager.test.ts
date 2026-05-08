import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { ServiceManager } from '../src/dashboard/service-manager';

describe('dashboard service manager', () => {
  test('uses node plus the tsx CLI entry in development', () => {
    const previousAppRoot = process.env.XIAOBA_APP_ROOT;
    const previousRuntimeRoot = process.env.XIAOBA_RUNTIME_ROOT;

    delete process.env.XIAOBA_APP_ROOT;
    delete process.env.XIAOBA_RUNTIME_ROOT;

    try {
      const manager = new ServiceManager(process.cwd());
      const service = manager.getService('catscompany');

      assert.ok(service);
      assert.equal(service.command, process.execPath);
      assert.match(normalize(service.args[0]), /node_modules\/tsx\/dist\/cli\.mjs$/);
      assert.match(normalize(service.args[1]), /src\/index\.ts$/);
      assert.equal(service.args[2], 'catscompany');
    } finally {
      if (previousAppRoot === undefined) delete process.env.XIAOBA_APP_ROOT;
      else process.env.XIAOBA_APP_ROOT = previousAppRoot;

      if (previousRuntimeRoot === undefined) delete process.env.XIAOBA_RUNTIME_ROOT;
      else process.env.XIAOBA_RUNTIME_ROOT = previousRuntimeRoot;
    }
  });
});

function normalize(value: string): string {
  return value.split(path.sep).join('/');
}
