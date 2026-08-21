#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';
import { buildIsolatedTestEnvironment } from './test-environment.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const legacyTests = [
  // Superseded by tests/execution-router-clean.test.ts. This file asserts the old
  // CatsCo owner/grant permission gateway, which is no longer the runtime path.
  'tests/tool-gateway-catsco.test.ts',
];

const skillHubPhase1Tests = [
  'tests/skillhub-phase1-compatibility.test.ts',
  'tests/dashboard-skillhub-connected-api.test.ts',
  'tests/catscompany-skillhub-rpc.test.ts',
  'tests/bot-definition-skills.test.ts',
  'tests/bot-skill-workspace.test.ts',
  'tests/bot-skills-sync.test.ts',
  'tests/bot-skills-security.test.ts',
  'tests/execution-router-clean.test.ts',
  'tests/trusted-bot-skill-script-execution.test.ts',
  'tests/tool-result-read-file-local-grants.test.ts',
  'tests/tool-result-read-tool.test.ts',
  'tests/tool-result-send-file-tool.test.ts',
  'tests/tool-result-write-tool.test.ts',
  'tests/glob-tool.test.ts',
  'tests/import-file.test.ts',
  'tests/catscompany-device-rpc-tools.test.ts',
  'tests/safety.test.ts',
];

const args = process.argv.slice(2);
const suite = args.find(arg => !arg.startsWith('--')) || 'runtime';
const listOnly = args.includes('--list');
const requestedConcurrency = Number.parseInt(
  String(process.env.XIAOBA_TEST_CONCURRENCY || ''),
  10,
);
const testConcurrency = Number.isInteger(requestedConcurrency) && requestedConcurrency > 0
  ? requestedConcurrency
  : null;

const allTests = (await glob('tests/**/*.test.ts', {
  cwd: rootDir,
  nodir: true,
})).map(normalizeTestPath).sort();

const legacySet = new Set(legacyTests);
const runtimeTests = allTests.filter(file => !legacySet.has(file));

const suites = {
  runtime: runtimeTests,
  'skillhub-phase1': skillHubPhase1Tests,
  legacy: legacyTests,
  all: allTests,
};

if (!Object.hasOwn(suites, suite)) {
  console.error(`Unknown test suite "${suite}". Expected one of: ${Object.keys(suites).join(', ')}`);
  process.exit(1);
}

const selectedTests = suites[suite];
console.log(`[test] suite=${suite} files=${selectedTests.length}`);

if (listOnly) {
  for (const file of selectedTests) console.log(file);
  process.exit(0);
}

if (selectedTests.length === 0) {
  console.log(`[test] suite=${suite} has no files`);
  process.exit(0);
}

const tsxCli = require.resolve('tsx/cli');
const testSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-test-runner-'));
const testHome = path.join(testSandbox, 'home');
const testTemp = path.join(testSandbox, 'tmp');
const testDotenv = path.join(testSandbox, '.env');
fs.mkdirSync(testHome, { recursive: true });
fs.mkdirSync(testTemp, { recursive: true });
fs.writeFileSync(testDotenv, '', 'utf8');

const testArgs = [tsxCli, '--test'];
if (testConcurrency !== null) {
  testArgs.push(`--test-concurrency=${testConcurrency}`);
}
testArgs.push(...selectedTests);

const child = spawn(process.execPath, testArgs, {
  cwd: rootDir,
  env: buildIsolatedTestEnvironment(process.env, {
    homeDir: testHome,
    tempDir: testTemp,
    appRoot: rootDir,
    dotenvPath: testDotenv,
  }),
  stdio: 'inherit',
  shell: false,
});

child.on('exit', (code, signal) => {
  cleanupTestSandbox();
  if (signal) {
    console.error(`[test] terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

child.on('error', error => {
  cleanupTestSandbox();
  console.error(`[test] failed to start: ${error.message}`);
  process.exit(1);
});

function cleanupTestSandbox() {
  fs.rmSync(testSandbox, { recursive: true, force: true });
}

function normalizeTestPath(file) {
  return file.replace(/\\/g, '/');
}
