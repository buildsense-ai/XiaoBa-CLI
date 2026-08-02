import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');
const integrityModuleUrl = pathToFileURL(path.join(
  process.cwd(),
  'src/core/checkpoint-witness-integrity.ts',
)).href;
const entries = [{
  toolName: 'inspect',
  toolCallId: 'call-1',
  argumentsSha256: 'a'.repeat(64),
  resultStatus: 'success' as const,
  retryable: false,
}];

function runIsolated(script: string, runtimeRoot: string) {
  return spawnSync(process.execPath, [tsxCli, '--eval', script], {
    cwd: process.cwd(),
    env: { ...process.env, XIAOBA_USER_DATA_DIR: runtimeRoot },
    encoding: 'utf8',
  });
}

test('completed-tool witness provenance survives JSON and a fresh process', t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-checkpoint-witness-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const stateDirectory = path.join(runtimeRoot, 'state');
  const keyPath = path.join(stateDirectory, 'checkpoint-completed-tool-witness.key');
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  // Existing invalid key paths fail closed and are never auto-deleted; this
  // prevents a check-then-unlink race from invalidating concurrent witnesses.
  fs.writeFileSync(keyPath, '', { mode: 0o600 });
  const invalidSign = runIsolated([
    `import { signCheckpointCompletedToolWitness } from ${JSON.stringify(integrityModuleUrl)};`,
    `process.stdout.write(JSON.stringify(signCheckpointCompletedToolWitness('episode-1', ${JSON.stringify(entries)})));`,
  ].join('\n'), runtimeRoot);
  assert.notEqual(invalidSign.status, 0);
  assert.match(invalidSign.stderr, /invalid length/);
  assert.equal(fs.statSync(keyPath).size, 0);
  fs.unlinkSync(keyPath);

  const sign = runIsolated([
    `import { signCheckpointCompletedToolWitness } from ${JSON.stringify(integrityModuleUrl)};`,
    `process.stdout.write(JSON.stringify(signCheckpointCompletedToolWitness('episode-1', ${JSON.stringify(entries)})));`,
  ].join('\n'), runtimeRoot);
  assert.equal(sign.status, 0, sign.stderr);
  const provenance = JSON.parse(sign.stdout);

  const verifyScript = [
    `import { verifyCheckpointCompletedToolWitness } from ${JSON.stringify(integrityModuleUrl)};`,
    `const provenance = ${JSON.stringify(provenance)};`,
    `const entries = ${JSON.stringify(entries)};`,
    'process.stdout.write(JSON.stringify({',
    "  valid: verifyCheckpointCompletedToolWitness(provenance, 'episode-1', entries),",
    "  tampered: verifyCheckpointCompletedToolWitness({ ...provenance, macSha256: '0'.repeat(64) }, 'episode-1', entries),",
    '}));',
  ].join('\n');
  const verify = runIsolated(verifyScript, runtimeRoot);
  assert.equal(verify.status, 0, verify.stderr);
  assert.deepEqual(JSON.parse(verify.stdout), { valid: true, tampered: false });

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
  }
  assert.equal(fs.statSync(keyPath).size, 32);

  fs.writeFileSync(keyPath, Buffer.alloc(32, 7), { mode: 0o600 });
  const replacedKeyVerify = runIsolated(verifyScript, runtimeRoot);
  assert.notEqual(replacedKeyVerify.status, 0);
  assert.match(replacedKeyVerify.stderr, /key identity mismatch/i);

  fs.unlinkSync(keyPath);
  const lostKeyVerify = runIsolated(verifyScript, runtimeRoot);
  assert.notEqual(lostKeyVerify.status, 0);
  assert.match(lostKeyVerify.stderr, /ENOENT|no such file/i);
  assert.equal(fs.existsSync(keyPath), false, 'verification must not silently rotate a lost key');
});
