#!/usr/bin/env node
// Plain-node entrypoint used by the parent Go PG fixture. No native TS
// stripping assumptions and no pnpm auto-install; use existing local tsx.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const index = process.argv.indexOf('--manifest');
if (index < 0 || !process.argv[index + 1]) {
  process.stdout.write(JSON.stringify({ event: 'projection_e2e_fail', error: 'manifest_required' }) + '\n');
  process.exit(2);
}
const child = spawn(process.execPath, ['--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'),
  path.join(root, 'scripts/catslog-projection-e2e-worker.ts'), process.argv[index + 1]], {
  cwd: root, env: process.env, stdio: ['ignore', 'inherit', 'inherit'], shell: false,
});
child.on('error', () => { process.stdout.write(JSON.stringify({ event: 'projection_e2e_fail', error: 'worker_start_failed' }) + '\n'); process.exitCode = 2; });
child.on('exit', (code, signal) => { process.exitCode = signal ? 2 : code ?? 2; });
