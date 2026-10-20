#!/usr/bin/env node
/**
 * Scoped tsx runner for the projection-reference E2E lane (Lane F).
 *
 * Runs ONLY the lane's test file(s) through node_modules/tsx --test with an
 * isolated environment (buildIsolatedTestEnvironment): temp HOME/TMP and an
 * empty .env so no real user token/state/profile is ever touched.
 *
 *   node scripts/run-projection-e2e-tests.mjs
 *
 * Does NOT use `pnpm exec` (auto-install breaks against the symlinked
 * node_modules). Direct `node node_modules/tsx/dist/cli.mjs --test`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildIsolatedTestEnvironment } from './test-environment.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const TEST_FILES = [
  'tests/catslog-projection-reference-e2e.test.ts',
];

const tsxCli = path.join(rootDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-projection-e2e-'));
const env = buildIsolatedTestEnvironment(process.env, {
  homeDir: path.join(sandbox, 'home'),
  tempDir: path.join(sandbox, 'tmp'),
  appRoot: rootDir,
  dotenvPath: path.join(sandbox, '.env'),
});
fs.mkdirSync(env.HOME, { recursive: true });
fs.mkdirSync(env.TMPDIR, { recursive: true });
fs.writeFileSync(env.DOTENV_CONFIG_PATH, '', 'utf8');

const child = spawn(process.execPath, [tsxCli, '--test', ...TEST_FILES], {
  cwd: rootDir,
  env,
  stdio: 'inherit',
  shell: false,
});

child.on('exit', (code, signal) => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  if (signal) {
    console.error(`[projection-e2e] terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
child.on('error', error => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  console.error(`[projection-e2e] failed to start: ${error.message}`);
  process.exit(1);
});
