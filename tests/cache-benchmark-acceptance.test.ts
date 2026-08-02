import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import {
  aggregateCacheBenchmarkAcceptance,
  CACHE_BENCHMARK_LEDGER_SCHEMA,
  CACHE_BENCHMARK_ROUND_SCHEMA,
  CACHE_BENCHMARK_RESULT_SCHEMA,
  fingerprintBenchmarkWorkloadContract,
  fingerprintConfig,
  fingerprintManifest,
  parseManifestJson,
  validateCompletedOnlineRuns,
  type AcceptanceProviderAlias,
  type CacheBenchmarkAcceptanceCandidate,
  type CacheBenchmarkManifest,
  type CacheBenchmarkResult,
} from '../src/cache-benchmark';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'cache-benchmark', 'manifest.json');
const ARTIFACT_A = `sha256:${'a'.repeat(64)}`;
const ARTIFACT_B = `sha256:${'b'.repeat(64)}`;

describe('multi-provider cache acceptance', () => {
  test('passes only when both providers bind three qualifying rounds to one artifact', () => {
    const newcli = candidate('newcli', ARTIFACT_A);
    const result = aggregateCacheBenchmarkAcceptance([
      newcli,
      candidate('deepseek', ARTIFACT_A),
    ]);

    assert.equal(result.status, 'passed');
    assert.equal(result.exit_code, 0);
    assert.equal(result.artifact_fingerprint, ARTIFACT_A);
    assert.equal(
      result.workload_contract_fingerprint,
      fingerprintBenchmarkWorkloadContract(newcli.manifest.cases),
    );
    assert.deepEqual(result.reasons, []);
  });

  test('rejects calibration, insufficient samples, and mismatched artifacts', () => {
    const calibration = candidate('newcli', ARTIFACT_A);
    calibration.manifest.benchmark_profile = 'calibration';
    calibration.result = passingResult(calibration.manifest, ARTIFACT_A);
    const tooSmall = candidate('deepseek', ARTIFACT_A);
    tooSmall.manifest.cases[0].runs[0].required_warm_calls = 23;
    tooSmall.result = passingResult(tooSmall.manifest, ARTIFACT_A);
    const invalid = aggregateCacheBenchmarkAcceptance([calibration, tooSmall]);

    assert.equal(invalid.status, 'invalid');
    assert.ok(invalid.reasons.includes('profile_not_acceptance'));
    assert.ok(invalid.reasons.includes('insufficient_warm_calls'));

    const artifactMismatch = aggregateCacheBenchmarkAcceptance([
      candidate('newcli', ARTIFACT_A),
      candidate('deepseek', ARTIFACT_B),
    ]);
    assert.equal(artifactMismatch.status, 'invalid');
    assert.ok(artifactMismatch.reasons.includes('artifact_fingerprint_mismatch'));

    const disguised = candidate('newcli', ARTIFACT_A);
    for (const entry of disguised.manifest.cases) {
      entry.provider_instance_id = `newcli:openai-chat-completions:endpoint-${'3'.repeat(32)}`;
      entry.api_type = 'openai-chat-completions';
      entry.cache_read_source = 'openai.prompt_tokens_details.cached_tokens';
    }
    disguised.result = passingResult(disguised.manifest, ARTIFACT_A);
    const identityMismatch = aggregateCacheBenchmarkAcceptance([
      disguised,
      candidate('deepseek', ARTIFACT_A),
    ]);
    assert.equal(identityMismatch.status, 'invalid');
    assert.ok(identityMismatch.reasons.includes('provider_identity_mismatch'));
  });

  test('rejects missing, duplicate, failed, and workload-mismatched providers', () => {
    const onlyNewcli = candidate('newcli', ARTIFACT_A);
    const missing = aggregateCacheBenchmarkAcceptance([onlyNewcli]);
    assert.equal(missing.status, 'invalid');
    assert.ok(missing.reasons.includes('missing_provider'));

    const duplicate = aggregateCacheBenchmarkAcceptance([
      onlyNewcli,
      candidate('newcli', ARTIFACT_A),
      candidate('deepseek', ARTIFACT_A),
    ]);
    assert.equal(duplicate.status, 'invalid');
    assert.ok(duplicate.reasons.includes('duplicate_provider'));

    const failed = candidate('deepseek', ARTIFACT_A);
    failed.result.status = 'failed';
    failed.result.exit_code = 1;
    failed.result.qualifying_rounds = [];
    failed.result.rounds[2].status = 'failed';
    const providerFailure = aggregateCacheBenchmarkAcceptance([onlyNewcli, failed]);
    assert.equal(providerFailure.status, 'failed');
    assert.deepEqual(providerFailure.reasons, ['provider_not_passed']);

    const mismatch = candidate('deepseek', ARTIFACT_A);
    mismatch.manifest.cases[0].task_fixture_fingerprint = `sha256:${'d'.repeat(64)}`;
    mismatch.result = passingResult(mismatch.manifest, ARTIFACT_A);
    const workloadMismatch = aggregateCacheBenchmarkAcceptance([onlyNewcli, mismatch]);
    assert.equal(workloadMismatch.status, 'invalid');
    assert.ok(workloadMismatch.reasons.includes('workload_contract_invalid'));
    assert.ok(workloadMismatch.reasons.includes('workload_contract_mismatch'));
  });

  test('validates every online started-to-sealed reservation and rejects orphan rounds', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-acceptance-runs-'));
    fs.chmodSync(directory, 0o700);
    try {
      const manifest = acceptanceManifest('newcli');
      const round = {
        header: {
          schema: CACHE_BENCHMARK_ROUND_SCHEMA,
          suite_id: manifest.suite_id,
          round: 1,
          cache_partition_nonce: 'a'.repeat(32),
          artifact_fingerprint: ARTIFACT_A,
          manifest_fingerprint: fingerprintManifest(manifest),
          config_fingerprint: fingerprintConfig(manifest),
        },
        attempts: [],
      };
      const evidenceFingerprint = `sha256:${'f'.repeat(64)}`;
      const ledger = {
        schema: CACHE_BENCHMARK_LEDGER_SCHEMA,
        suite_id: manifest.suite_id,
        latest_round: 1,
        rounds: [{ round: 1, evidence_fingerprint: evidenceFingerprint }],
      };
      writePrivate(path.join(directory, 'round-1.jsonl'), '{}\n');
      const started = JSON.stringify({
        schema: 'xiaoba.cache_benchmark_online_run.v1',
        state: 'started',
        suite_id: manifest.suite_id,
        round: 1,
        cache_partition_nonce: round.header.cache_partition_nonce,
        artifact_fingerprint: ARTIFACT_A,
        manifest_fingerprint: round.header.manifest_fingerprint,
        config_fingerprint: round.header.config_fingerprint,
      });
      const sealed = JSON.stringify({
        schema: 'xiaoba.cache_benchmark_online_run.v1',
        state: 'sealed',
        evidence_fingerprint: evidenceFingerprint,
      });
      const runPath = path.join(directory, 'round-1.run.jsonl');
      writePrivate(runPath, `${started}\n${sealed}\n`);
      assert.doesNotThrow(() => validateCompletedOnlineRuns(directory, manifest, ledger, [round]));

      writePrivate(runPath, `${started}\n`);
      assert.throws(() => validateCompletedOnlineRuns(directory, manifest, ledger, [round]));
      writePrivate(runPath, `${started}\n${sealed}\n`);
      writePrivate(path.join(directory, 'round-2.jsonl'), '{}\n');
      assert.throws(() => validateCompletedOnlineRuns(directory, manifest, ledger, [round]));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('acceptance CLI projects invalid input without disclosing paths', () => {
    const executable = path.join(process.cwd(), 'dist', 'cache-benchmark', 'acceptance-cli.js');
    const secretPath = '/private/SECRET_ACCEPTANCE_PATH';
    const run = spawnSync(process.execPath, [
      executable,
      '--newcli-dir', secretPath,
      '--deepseek-dir', secretPath,
      '--format', 'json',
    ], { encoding: 'utf8' });

    assert.equal(run.status, 2);
    assert.equal(run.stderr, '');
    assert.match(run.stdout, /"reasons":\["input_invalid"\]/u);
    assert.equal(run.stdout.includes(secretPath), false);
  });

  test('acceptance CLI refuses an active online writer lock without removing it', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-acceptance-lock-'));
    fs.chmodSync(directory, 0o700);
    const lockPath = path.join(directory, '.online-run.lock');
    writePrivate(lockPath, '{"state":"active-writer"}\n');
    try {
      const executable = path.join(process.cwd(), 'dist', 'cache-benchmark', 'acceptance-cli.js');
      const run = spawnSync(process.execPath, [
        executable,
        '--newcli-dir', directory,
        '--deepseek-dir', directory,
        '--format', 'text',
      ], { encoding: 'utf8' });

      assert.equal(run.status, 2);
      assert.equal(run.stdout, 'status=invalid\nexit_code=2\nreasons=input_invalid\n');
      assert.equal(fs.readFileSync(lockPath, 'utf8'), '{"state":"active-writer"}\n');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

function candidate(
  provider: AcceptanceProviderAlias,
  artifactFingerprint: string,
): CacheBenchmarkAcceptanceCandidate {
  const manifest = acceptanceManifest(provider);
  return { provider, manifest, result: passingResult(manifest, artifactFingerprint) };
}

function acceptanceManifest(provider: AcceptanceProviderAlias): CacheBenchmarkManifest {
  const manifest = parseManifestJson(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  manifest.suite_id = `xiaoba-online-${provider}-acceptance-v1`;
  manifest.benchmark_profile = 'acceptance';
  for (const entry of manifest.cases) {
    entry.provider_instance_id = provider === 'newcli'
      ? `newcli:openai-responses:endpoint-${'1'.repeat(32)}`
      : `deepseek:openai-chat-completions:endpoint-${'2'.repeat(32)}`;
    if (provider === 'deepseek') {
      entry.api_type = 'openai-chat-completions';
      entry.cache_read_source = 'openai.prompt_tokens_details.cached_tokens';
    }
    for (const run of entry.runs) run.required_warm_calls = 24;
  }
  manifest.workload_contract_fingerprint = fingerprintBenchmarkWorkloadContract(manifest.cases);
  return manifest;
}

function passingResult(
  manifest: CacheBenchmarkManifest,
  artifactFingerprint: string,
): CacheBenchmarkResult {
  return {
    schema: CACHE_BENCHMARK_RESULT_SCHEMA,
    status: 'passed',
    exit_code: 0,
    manifest_fingerprint: fingerprintManifest(manifest),
    config_fingerprint: fingerprintConfig(manifest),
    ledger_fingerprint: `sha256:${'e'.repeat(64)}`,
    latest_round: 3,
    qualifying_rounds: [1, 2, 3],
    rounds: [1, 2, 3].map(round => ({
      round,
      artifact_fingerprint: artifactFingerprint,
      status: 'passed',
      cells: [],
      reasons: [],
    })),
    reasons: [],
    ledger_reasons: [],
    capability_coverage: [],
  };
}

function writePrivate(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}
