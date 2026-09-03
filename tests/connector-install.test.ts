import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const unixInstaller = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
const windowsInstaller = fs.readFileSync(path.join(root, 'install.ps1'), 'utf8');
const connectorPackage = JSON.parse(fs.readFileSync(path.join(root, 'connector-package.json'), 'utf8'));
const connectorDashboard = fs.readFileSync(path.join(root, 'src/dashboard/connector-lite-server.ts'), 'utf8');
const releaseWorkflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); 

test('source installers deploy only Connector Lite runtime artifacts', () => {
  for (const installer of [unixInstaller, windowsInstaller]) {
    assert.match(installer, /npm run build:connector/);
    assert.match(installer, /dist[\\/]connector[\\/]index\.js/);
    assert.match(installer, /dist[\\/]connector-dashboard[\\/]server\.js/);
    assert.match(installer, /connector-package\.json/);
    assert.match(installer, /XIAOBA_CONNECTOR_PACKAGE/);
    assert.doesNotMatch(installer, /npm run build(?:\s|$)/m);
    assert.doesNotMatch(installer, /dist[\\/]index\.js/);
    assert.doesNotMatch(installer, /check_python|Check-Python|\.env\.example/);
  }
});

test('Connector package manifest has no CLI or model runtime surface', () => {
  assert.equal(connectorPackage.name, 'catsco-connector');
  assert.equal(connectorPackage.main, 'electron/connector-main.js');
  assert.equal(connectorPackage.catscoPackage, 'connector-lite');
  assert.equal(connectorPackage.bin, undefined);
  assert.deepEqual(Object.keys(connectorPackage.dependencies).sort(), ['dotenv', 'electron-updater']);
  assert.equal(connectorPackage.dependencies['@anthropic-ai/sdk'], undefined);
});

test('Connector Dashboard bundle is directly executable without full CLI', () => {
  assert.match(connectorDashboard, /require\.main === module/);
  assert.match(connectorDashboard, /XIAOBA_CONNECTOR_PACKAGE = 'connector-lite'/);
  assert.match(connectorDashboard, /startConnectorLiteDashboard/);
});

test('desktop release workflow publishes the Connector-specific package', () => {
  for (const script of [
    'electron:build:connector:mac:x64',
    'electron:build:connector:mac:arm64',
    'electron:build:connector:win',
    'electron:build:connector:linux',
  ]) assert.ok(rootPackage.scripts[script], `missing ${script}`);
  assert.match(releaseWorkflow, /electron:build:connector:mac:\$\{\{ matrix\.arch \}\}/);
  assert.match(releaseWorkflow, /electron:build:connector:win/);
  assert.match(releaseWorkflow, /electron:build:connector:linux/);
  assert.doesNotMatch(releaseWorkflow, /run: npm run electron:build:(?:mac|win|linux)(?:\s|$)/m);
});
