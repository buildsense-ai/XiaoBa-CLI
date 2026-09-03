const fs = require('node:fs');
const path = require('node:path');
const baseConfig = require('./electron-builder.config.cjs');

// Electron main.js loads only these runtime packages. Connector and Dashboard
// third-party dependencies are bundled into their isolated artifacts.
const CONNECTOR_LITE_RUNTIME_DEPENDENCIES = ['dotenv', 'electron-updater'];

function markConnectorLitePackage(context) {
  const packagePath = path.join(context.appOutDir, 'resources', 'app', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  packageJson.catscoPackage = 'connector-lite';
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
}

function collectRuntimeDependencies(appNodeModules) {
  const keep = new Set();
  const pending = [...CONNECTOR_LITE_RUNTIME_DEPENDENCIES];
  while (pending.length > 0) {
    const packageName = pending.pop();
    if (!packageName || keep.has(packageName)) continue;
    const packageJsonPath = path.join(appNodeModules, packageName, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      throw new Error(`Connector Lite runtime dependency is missing: ${packageName}`);
    }
    keep.add(packageName);
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    for (const dependency of Object.keys(packageJson.dependencies || {})) {
      // A dependency nested under its parent remains with that parent. Add
      // only flattened top-level packages to the top-level allow-list.
      if (fs.existsSync(path.join(appNodeModules, dependency, 'package.json'))) {
        pending.push(dependency);
      }
    }
  }
  return keep;
}

function pruneConnectorDependencies(context) {
  const appNodeModules = path.join(context.appOutDir, 'resources', 'app', 'node_modules');
  const keep = collectRuntimeDependencies(appNodeModules);
  for (const entry of fs.readdirSync(appNodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      fs.rmSync(path.join(appNodeModules, entry.name), { recursive: true, force: true });
      continue;
    }
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      const scopePath = path.join(appNodeModules, entry.name);
      for (const scopedEntry of fs.readdirSync(scopePath, { withFileTypes: true })) {
        const packageName = `${entry.name}/${scopedEntry.name}`;
        if (!keep.has(packageName)) fs.rmSync(path.join(scopePath, scopedEntry.name), { recursive: true, force: true });
      }
      if (fs.readdirSync(scopePath).length === 0) fs.rmSync(scopePath, { recursive: true, force: true });
      continue;
    }
    if (!keep.has(entry.name)) fs.rmSync(path.join(appNodeModules, entry.name), { recursive: true, force: true });
  }
}

module.exports = {
  ...baseConfig,
  appId: 'com.catcompany.xiaoba.connector',
  productName: 'CatsCo Connector',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  // Keep the installer extraction path fast. Maximum compression saves little
  // for an installer dominated by Electron, but makes NSIS packing/installing
  // noticeably slower.
  compression: 'normal',
  removePackageScripts: true,
  electronLanguages: ['en-US', 'zh-CN'],
  files: [
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
  ],
  // Electron itself can execute the Connector bundle with
  // ELECTRON_RUN_AS_NODE=1, so Connector Lite needs no second Node runtime.
  extraFiles: [],
  extraResources: undefined,
  afterPack: context => {
    pruneConnectorDependencies(context);
    markConnectorLitePackage(context);
  },
  publish: baseConfig.publish,
};
