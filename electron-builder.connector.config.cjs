const fs = require('node:fs');
const path = require('node:path');
const baseConfig = require('./electron-builder.config.cjs');

// The Lite Dashboard bundle only requires these runtime packages. Keep this
// list explicit so a dependency imported only by the full CLI/Dashboard cannot
// silently inflate the Connector package.
const CONNECTOR_LITE_EXCLUDED_PRODUCTION_DEPENDENCIES = [
  'deasync',
  '@anthropic-ai/sdk',
  '@larksuiteoapi/node-sdk',
  '@napi-rs/canvas',
  '@napi-rs/canvas-linux-x64-gnu',
  '@napi-rs/canvas-linux-x64-musl',
  '@img',
  'axios',
  'pdf-parse',
  'pdfjs-dist',
  'sharp',
  'rxjs',
  'protobufjs',
  'node-addon-api',
];

function markConnectorLitePackage(context) {
  const packagePath = path.join(context.appOutDir, 'resources', 'app', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  packageJson.catscoPackage = 'connector-lite';
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
}

function removeExcludedDependencies(context) {
  const appNodeModules = path.join(context.appOutDir, 'resources', 'app', 'node_modules');
  for (const packageName of CONNECTOR_LITE_EXCLUDED_PRODUCTION_DEPENDENCIES) {
    const packagePath = path.resolve(appNodeModules, packageName);
    const root = path.resolve(appNodeModules) + path.sep;
    if (!packagePath.startsWith(root)) {
      throw new Error(`Refusing to remove dependency outside app node_modules: ${packagePath}`);
    }
    if (fs.existsSync(packagePath)) {
      fs.rmSync(packagePath, { recursive: true, force: true });
    }
  }
}

module.exports = {
  ...baseConfig,
  appId: 'com.catcompany.xiaoba.connector',
  productName: 'CatsCo Connector',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  files: [
    'dist/connector/index.js',
    'dist/connector-dashboard/server.js',
    'dist/connector-dashboard/local-file-grants.js',
    'electron/**/*',
    'dashboard/**/*',
    'prompts/**/*',
    '.env.example',
    'package.json',
  ],
  extraFiles: baseConfig.extraFiles,
  extraResources: undefined,
  afterPack: context => {
    removeExcludedDependencies(context);
    markConnectorLitePackage(context);
  },
  publish: baseConfig.publish,
};
