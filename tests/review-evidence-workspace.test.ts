import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const scriptPath = path.resolve(
  'skills/review-evidence-workspace/scripts/review-evidence-workspace.mjs',
);

describe('review-evidence-workspace', () => {
  let testRoot: string;
  let evidenceRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-review-evidence-test-'));
    evidenceRoot = path.join(testRoot, 'evidence');
  });

  afterEach(() => {
    fs.chmodSync(testRoot, 0o700);
    makeWritable(testRoot);
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('preserves append-only observations, copied artifacts, and an immutable snapshot', () => {
    const sourceArtifact = path.join(testRoot, 'runtime.log');
    fs.writeFileSync(sourceArtifact, 'ERROR repeated failure\n', 'utf8');

    const initialized = run('init',
      '--root', evidenceRoot,
      '--id', 'case-1',
      '--title', 'Sparse report',
      '--source', 'user',
      '--description', 'Something failed');
    assert.equal(initialized.investigationId, 'case-1');

    const recorded = run('record',
      '--root', evidenceRoot,
      '--id', 'case-1',
      '--kind', 'log',
      '--summary', 'Repeated error observed',
      '--hypothesis', 'runtime path is unstable',
      '--source', 'local-log',
      '--artifact', sourceArtifact);
    assert.equal(recorded.event.kind, 'log');
    assert.match(recorded.event.artifact.sha256, /^[a-f0-9]{64}$/);

    const shown = run('show', '--root', evidenceRoot, '--id', 'case-1');
    assert.equal(shown.eventCount, 2);
    assert.equal(shown.evidenceCount, 1);
    assert.equal(shown.artifacts.length, 1);

    const snapshot = run('snapshot',
      '--root', evidenceRoot,
      '--id', 'case-1',
      '--assessment', 'confirmed',
      '--conclusion', 'Failure reproduced');
    const manifest = JSON.parse(fs.readFileSync(snapshot.manifestPath, 'utf8'));
    assert.equal(manifest.investigationId, 'case-1');
    assert.ok(manifest.files.some((entry: any) => entry.path === 'events.ndjson'));
    assert.ok(manifest.files.every((entry: any) => /^[a-f0-9]{64}$/.test(entry.sha256)));

    fs.appendFileSync(sourceArtifact, 'source remains writable\n');
    assert.throws(
      () => fs.appendFileSync(path.join(snapshot.bundleDirectory, 'events.ndjson'), 'mutation\n'),
      /EACCES|EPERM/,
    );
  });

  test('requires an isolated root and rejects traversal-like investigation ids', () => {
    const missingRoot = spawnSync(process.execPath, [scriptPath, 'show', '--id', 'case-1'], {
      encoding: 'utf8',
      env: { ...process.env, XIAOBA_REVIEW_EVIDENCE_ROOT: '' },
    });
    assert.notEqual(missingRoot.status, 0);
    assert.match(missingRoot.stderr, /Evidence root is required/);

    const unsafeId = spawnSync(process.execPath, [
      scriptPath, 'init',
      '--root', evidenceRoot,
      '--id', '../escape',
      '--title', 'Unsafe',
      '--source', 'user',
      '--description', 'Unsafe id',
    ], { encoding: 'utf8' });
    assert.notEqual(unsafeId.status, 0);
    assert.match(unsafeId.stderr, /Investigation id/);
  });

  function run(command: string, ...args: string[]): any {
    const result = spawnSync(process.execPath, [scriptPath, command, ...args], {
      encoding: 'utf8',
      env: { ...process.env, XIAOBA_REVIEW_EVIDENCE_ROOT: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
});

function makeWritable(directory: string): void {
  if (!fs.existsSync(directory)) return;
  fs.chmodSync(directory, 0o700);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) makeWritable(entryPath);
    else fs.chmodSync(entryPath, 0o600);
  }
}
