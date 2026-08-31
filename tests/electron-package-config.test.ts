import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const packageJson = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
) as {
  dependencies?: Record<string, string>;
  build?: {
    npmRebuild?: boolean;
    files?: string[];
    extraResources?: unknown[];
  };
};

const electronMain = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.js'), 'utf8');
const builderConfig = require('../electron-builder.config.cjs') as {
  afterPack?: unknown;
};

test('desktop package keeps production dependencies without a duplicate node_modules resource', () => {
  assert.ok(packageJson.dependencies?.['@larksuiteoapi/node-sdk']);
  assert.ok(packageJson.dependencies?.axios);
  assert.ok(packageJson.dependencies?.dotenv);
  assert.ok(packageJson.dependencies?.deasync);

  assert.equal(packageJson.build?.npmRebuild, false);
  assert.equal(typeof builderConfig.afterPack, 'function');
  assert.equal(packageJson.build?.extraResources, undefined);
  assert.match(electronMain, /path\.join\(getAppRoot\(\), 'node_modules'\)/);
  assert.doesNotMatch(electronMain, /path\.join\(process\.resourcesPath, 'node_modules'\)/);
});

test('desktop package keeps all compiled JavaScript entrypoints for the low-risk phase', () => {
  const files = packageJson.build?.files || [];
  assert.ok(files.includes('dist/**/*'));
  assert.ok(files.includes('!dist/**/*.d.ts'));
  assert.ok(files.includes('!dist/**/*.d.ts.map'));
  assert.ok(files.includes('!dist/**/*.js.map'));
  assert.equal(files.some(pattern => pattern.includes('dist/catscompany') && pattern.startsWith('!')), false);
});
