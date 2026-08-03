#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const catsRepo = path.resolve(
  process.env.CATSCOMPANY_REPO || path.join(rootDir, '..', 'cats-company'),
);

requireFile(path.join(catsRepo, 'go.mod'), 'cats-company checkout');
requireFile(
  path.join(catsRepo, 'server', 'bot_skill_config_test.go'),
  'CatsCo BotDefinition Skills contract tests',
);

const catsExpectedTests = [
  'TestBotDefinitionSkillsUseUnifiedRevisionAndCanonicalOrder',
  'TestBotDefinitionSkillsRejectStaleRevisionAndInvalidRefs',
  'TestBotDefinitionSkillsOwnerAndRuntimeScope',
  'TestFullBotDefinitionResponseIncludesSkills',
  'TestBotDefinitionSkillsNoopKeepsUnifiedRevision',
];
const catsTestPattern =
  '^(TestBotDefinitionSkills.*|TestFullBotDefinitionResponseIncludesSkills)$';
const catsTestList = runStepCapture(
  'list CatsCo BotDefinition Skills API contract tests',
  'go',
  ['test', './server', '-list', catsTestPattern],
  { cwd: catsRepo },
);
const listedCatsTests = new Set(
  catsTestList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('Test')),
);
for (const testName of catsExpectedTests) {
  if (!listedCatsTests.has(testName)) {
    console.error(`[cross-repo] Missing expected CatsCo contract test: ${testName}`);
    process.exit(1);
  }
}

runStep(
  'CatsCo BotDefinition Skills API contract',
  'go',
  [
    'test',
    './server',
    '-run',
    catsTestPattern,
    '-count=1',
  ],
  {
    cwd: catsRepo,
  },
);

const tsxCli = require.resolve('tsx/cli');
runStep(
  'XiaoBa BotDefinition Skills client and sync contract',
  process.execPath,
  [
    tsxCli,
    '--test',
    'tests/bot-definition-skills.test.ts',
    'tests/bot-skills-sync.test.ts',
  ],
  { cwd: rootDir },
);

console.log(
  '[cross-repo] BotDefinition Skills paired contract tests passed. ' +
    'Private SkillHub upload/download remains covered by the explicit real contract test.',
);

function requireFile(filePath, label) {
  if (fs.existsSync(filePath)) {
    return;
  }
  console.error(`[cross-repo] Missing ${label}: ${filePath}`);
  process.exit(1);
}

function runStep(name, command, args, options = {}) {
  console.log(`[cross-repo] ${name}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    env: options.env || process.env,
    stdio: 'inherit',
    shell: false,
    timeout: options.timeoutMs || 120_000,
  });

  assertStepPassed(name, result);
}

function runStepCapture(name, command, args, options = {}) {
  console.log(`[cross-repo] ${name}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    env: options.env || process.env,
    encoding: 'utf8',
    shell: false,
    timeout: options.timeoutMs || 120_000,
  });
  assertStepPassed(name, result);
  return result.stdout || '';
}

function assertStepPassed(name, result) {
  if (result.error) {
    console.error(`[cross-repo] Failed to run ${name}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.signal) {
    console.error(`[cross-repo] ${name} terminated by ${result.signal}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    if (result.stderr) {
      console.error(result.stderr);
    }
    console.error(`[cross-repo] ${name} failed with exit code ${result.status}`);
    process.exit(result.status || 1);
  }
}
