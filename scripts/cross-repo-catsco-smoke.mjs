#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const catsRepo = path.resolve(process.env.CATSCOMPANY_REPO || path.join(rootDir, '..', 'cats-company'));
const catsGoMod = path.join(catsRepo, 'go.mod');

if (!fs.existsSync(catsGoMod)) {
  console.error(`[cross-repo] cats-company repo not found at ${catsRepo}`);
  console.error('[cross-repo] Set CATSCOMPANY_REPO to the local cats-company checkout.');
  process.exit(1);
}

const catsGoCache = process.env.CATSCOMPANY_GOCACHE || path.join(catsRepo, '.gocache');
fs.mkdirSync(catsGoCache, { recursive: true });

const catsServerSmoke = [
  'TestDeviceConnectorPairingEnrollmentAndScopedRegistration',
  'TestDeviceRPCRoutesRequestToSelectedDeviceAndReturnsResult',
  'TestDeviceRPCDoesNotBroadcastToSiblingConnections',
  'TestDeviceRPCRejectsResultFromWrongDeviceConnection',
  'TestDeviceRPCRejectsOfflineDevice',
  'TestDeviceRPCDoesNotRouteByBareBodyOrInstallationID',
  'TestSharedRuntimeRoutesDeviceRPCAcrossHubs',
  'TestRedisRuntimeRoutesDeviceRPCAcrossStates',
  'TestChannelAgentBindingLinkUser',
  'TestChannelAgentBindingConfirmRequiresTokenInProduction',
  'TestBotRecipientIdentityUsesLinkedChannelDeviceOwner',
  'TestFeishuMessageEventDeliversToBoundAgent',
  'TestWeixinTextMessageDeliversToBoundAgent',
].join('|');

const tsxCli = require.resolve('tsx/cli');
const xiaoBaSmokeTests = [
  'tests/catscompany-client-body-id.test.ts',
  'tests/catscompany-device-rpc-tools.test.ts',
  'tests/catscompany-execution-scope-flow.test.ts',
  'tests/tool-gateway-catsco.test.ts',
];

runStep('cats-company server device connector/RPC smoke', 'go', [
  'test',
  './server',
  '-run',
  catsServerSmoke,
  '-count=1',
], {
  cwd: catsRepo,
  env: {
    ...process.env,
    GOCACHE: catsGoCache,
  },
});

runStep('XiaoBa CatsCo device RPC smoke', process.execPath, [
  tsxCli,
  '--test',
  ...xiaoBaSmokeTests,
], {
  cwd: rootDir,
});

console.log('[cross-repo] CatsCo cross-repo smoke passed');

function runStep(name, command, args, options = {}) {
  console.log(`[cross-repo] ${name}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    env: options.env || process.env,
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    console.error(`[cross-repo] Failed to start ${name}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.signal) {
    console.error(`[cross-repo] ${name} terminated by ${result.signal}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`[cross-repo] ${name} failed with exit code ${result.status}`);
    process.exit(result.status || 1);
  }
}
