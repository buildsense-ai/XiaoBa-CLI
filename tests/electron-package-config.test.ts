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
const connectorBuilderConfig = require('../electron-builder.connector.config.cjs') as {
  files?: string[];
  afterPack?: unknown;
  appId?: string;
  compression?: string;
  removePackageScripts?: boolean;
  electronLanguages?: string[];
  extraFiles?: unknown[];
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

test('Connector Lite package has an isolated release profile', () => {
  assert.equal(connectorBuilderConfig.appId, 'com.catcompany.xiaoba.connector');
  assert.equal(typeof connectorBuilderConfig.afterPack, 'function');
  assert.equal(connectorBuilderConfig.extraResources, undefined);
  assert.match(electronMain, /const connectorLitePackage = isConnectorLitePackage\(appRoot\)/);
  assert.match(electronMain, /dashboardModule\.startConnectorLiteDashboard/);
  assert.match(electronMain, /if \(!connectorLitePackage\) \{\s+const runtimeEnvironmentModulePath/);
  assert.deepEqual(connectorBuilderConfig.extraFiles, []);
  assert.match(electronMain, /process\.env\.XIAOBA_CONNECTOR_PACKAGE = 'connector-lite'/);
  assert.equal(connectorBuilderConfig.compression, 'normal');
  assert.equal(connectorBuilderConfig.removePackageScripts, true);
  assert.deepEqual(connectorBuilderConfig.electronLanguages, ['en-US', 'zh-CN']);
  assert.deepEqual(connectorBuilderConfig.files, [
    'dist/connector/index.js',
    'dist/connector-dashboard/server.js',
    'electron/main.js',
    'electron/preload.js',
    'electron/gpu-compat.js',
    'electron/renderer-gone.js',
    'electron/update-errors.js',
    'dashboard/connector.html',
    'dashboard/connector.css',
    'dashboard/connector.js',
    'dashboard/cat-icon.png',
    'package.json',
  ]);
  assert.doesNotMatch(electronMain, /if \(!fs\.existsSync\(envPath\)\) \{/);
  assert.match(electronMain, /if \(!connectorLitePackage && !fs\.existsSync\(envPath\)\) \{/);
  assert.match(electronMain, /if \(!connectorLitePackage\) \{\s+const promptsDest/);
  assert.doesNotMatch(JSON.stringify(connectorBuilderConfig.files), /cache-trace|turn-errors|prompts|\.env\.example/);
});

test('desktop package keeps all compiled JavaScript entrypoints for the low-risk phase', () => {
  const files = packageJson.build?.files || [];
  assert.ok(files.includes('dist/**/*'));
  assert.ok(files.includes('!dist/**/*.d.ts'));
  assert.ok(files.includes('!dist/**/*.d.ts.map'));
  assert.ok(files.includes('!dist/**/*.js.map'));
  assert.equal(files.some(pattern => pattern.includes('dist/catscompany') && pattern.startsWith('!')), false);
});
