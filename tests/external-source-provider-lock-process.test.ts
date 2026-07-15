import { ChildProcess, spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TSX_LOADER = pathToFileURL(require.resolve('tsx')).href;
const lockModuleUrl = pathToFileURL(
  path.join(PROJECT_ROOT, 'src/utils/external-source-provider-lock.ts'),
).href;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface LockProbeResult {
  acquired: boolean;
  pid: number;
}

function spawnLockProbe(root: string, hold: boolean): ChildProcess {
  return spawn(process.execPath, [
    '--import',
    TSX_LOADER,
    '--input-type=module',
    '-e',
    `
      const imported = await import(${JSON.stringify(lockModuleUrl)});
      const api = imported.default ?? imported;
      const lock = api.acquireExternalSourceProviderLock({
        runtimeRoot: process.env.LOCK_ROOT,
        provider: 'codex',
        sourceId: 'external-codex',
        operation: process.env.LOCK_HOLD === '1' ? 'holder' : 'probe',
      });
      process.stdout.write('LOCK_PROBE ' + JSON.stringify({ acquired: lock.acquired, pid: process.pid }) + '\\n');
      if (!lock.acquired) process.exit(0);
      if (process.env.LOCK_HOLD !== '1') {
        lock.release();
        process.exit(0);
      }
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', () => {
        lock.release();
        process.exit(0);
      });
      process.stdin.resume();
    `,
  ], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      LOCK_ROOT: root,
      LOCK_HOLD: hold ? '1' : '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function waitForProbe(child: ChildProcess, timeoutMs = 10_000): Promise<LockProbeResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`provider lock probe timed out; stdout=${stdout}; stderr=${stderr}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
    };
    const onStdout = (chunk: Buffer | string) => {
      stdout += chunk.toString();
      const line = stdout.split('\n').find(value => value.startsWith('LOCK_PROBE '));
      if (!line) return;
      cleanup();
      resolve(JSON.parse(line.slice('LOCK_PROBE '.length)) as LockProbeResult);
    };
    const onStderr = (chunk: Buffer | string) => { stderr += chunk.toString(); };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`provider lock probe exited before reporting: code=${code} signal=${signal}; stderr=${stderr}`));
    };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('exit', onExit);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('exit', () => resolve()));
}

test('provider lock serializes real processes and releases on normal exit', { timeout: 20_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-provider-process-lock-'));
  roots.push(root);
  const holder = spawnLockProbe(root, true);
  let contender: ChildProcess | null = null;
  let successor: ChildProcess | null = null;
  try {
    const owner = await waitForProbe(holder);
    assert.equal(owner.acquired, true);

    contender = spawnLockProbe(root, false);
    assert.equal((await waitForProbe(contender)).acquired, false);
    await waitForExit(contender);
    contender = null;

    holder.stdin?.write('release\n');
    await waitForExit(holder);

    successor = spawnLockProbe(root, false);
    assert.equal((await waitForProbe(successor)).acquired, true);
    await waitForExit(successor);
    successor = null;
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
    if (contender && contender.exitCode === null && contender.signalCode === null) contender.kill('SIGKILL');
    if (successor && successor.exitCode === null && successor.signalCode === null) successor.kill('SIGKILL');
    await Promise.all([
      waitForExit(holder),
      ...(contender ? [waitForExit(contender)] : []),
      ...(successor ? [waitForExit(successor)] : []),
    ]);
  }
});

test('only one real process reclaims a dead owner with a crashed claimer', { timeout: 20_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-provider-stale-contention-'));
  roots.push(root);
  const provider = 'codex';
  const providerToken = `${provider}-${crypto.createHash('sha256').update(provider).digest('hex').slice(0, 12)}`;
  const lockDir = path.join(root, '.xiaoba', 'external-source-provider-locks', providerToken);
  const claimDir = path.join(lockDir, '.claim');
  fs.mkdirSync(claimDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
    provider,
    pid: -1,
    startedAt: new Date().toISOString(),
    operation: 'crashed-owner',
    token: 'dead-owner',
  }) + '\n', 'utf8');
  fs.writeFileSync(path.join(claimDir, 'claimer.json'), JSON.stringify({
    pid: -2,
    startedAt: new Date().toISOString(),
    token: 'dead-claimer',
  }) + '\n', 'utf8');

  const contenders = Array.from({ length: 6 }, () => spawnLockProbe(root, true));
  try {
    const results = await Promise.all(contenders.map(child => waitForProbe(child)));
    const ownerIndexes = results
      .map((result, index) => result.acquired ? index : -1)
      .filter(index => index >= 0);
    assert.equal(ownerIndexes.length, 1, `expected one owner, got ${JSON.stringify(results)}`);

    contenders[ownerIndexes[0]!]!.stdin?.write('release\n');
    await Promise.all(contenders.map(child => waitForExit(child)));
  } finally {
    for (const child of contenders) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await Promise.all(contenders.map(child => waitForExit(child)));
  }
});
