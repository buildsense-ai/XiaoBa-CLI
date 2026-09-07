import { execFileSync } from 'node:child_process';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

const root = process.cwd();
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
) as {
  dependencies?: Record<string, string>;
  build?: {
    files?: string[];
    extraResources?: Array<{ from?: string }>;
    npmRebuild?: boolean;
    nsis?: { differentialPackage?: boolean };
  };
};

const electronMain = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const builderConfig = require('../electron-builder.config.cjs') as {
  afterPack?: (context: {
    appOutDir: string;
    packager: { getResourcesDir: (appOutDir: string) => string };
  }) => void;
};

test('TOS updater uses single-range requests for differential downloads', () => {
  const configPath = path.join(root, 'electron-builder.config.cjs');
  const script = `process.stdout.write(JSON.stringify(require(${JSON.stringify(configPath)}).publish))`;
  const output = execFileSync(process.execPath, ['-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      XIAOBA_UPDATE_BASE_URL: 'https://github-release.tos-cn-guangzhou.volces.com/update',
    },
  });
  const publish = JSON.parse(output) as Array<Record<string, unknown>>;

  assert.equal(publish[0]?.provider, 'generic');
  assert.equal(publish[0]?.useMultipleRangeRequest, false);
});

test('Windows packages retain differential metadata and one production dependency tree', () => {
  assert.equal(packageJson.build?.nsis?.differentialPackage, true);
  assert.equal(packageJson.build?.npmRebuild, false);
  assert.equal(
    packageJson.build?.extraResources?.some((resource) => resource.from === 'node_modules') || false,
    false,
  );
  assert.match(electronMain, /path\.join\(getAppRoot\(\), 'node_modules'\)/);
  assert.doesNotMatch(electronMain, /path\.join\(process\.resourcesPath, 'node_modules'\)/);
});

test('desktop packaging removes only the worker-only deasync dependency', () => {
  assert.equal(typeof builderConfig.afterPack, 'function');
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-package-config-'));
  const resourcesDir = path.join(appOutDir, 'platform-resources');
  const nodeModules = path.join(resourcesDir, 'app', 'node_modules');
  const deasyncPath = path.join(nodeModules, 'deasync');
  const sharpPath = path.join(nodeModules, 'sharp');

  try {
    fs.mkdirSync(deasyncPath, { recursive: true });
    fs.mkdirSync(sharpPath, { recursive: true });
    fs.writeFileSync(path.join(deasyncPath, 'package.json'), '{}');
    fs.writeFileSync(path.join(sharpPath, 'package.json'), '{}');

    builderConfig.afterPack?.({
      appOutDir,
      packager: { getResourcesDir: () => resourcesDir },
    });

    assert.equal(fs.existsSync(deasyncPath), false);
    assert.equal(fs.existsSync(path.join(sharpPath, 'package.json')), true);
  } finally {
    fs.rmSync(appOutDir, { recursive: true, force: true });
  }
});

test('desktop package omits generated TypeScript metadata', () => {
  for (const pattern of ['!dist/**/*.d.ts', '!dist/**/*.d.ts.map', '!dist/**/*.js.map']) {
    assert.ok(packageJson.build?.files?.includes(pattern), `missing package exclusion: ${pattern}`);
  }
  assert.ok(packageJson.dependencies?.['electron-updater']);
});
