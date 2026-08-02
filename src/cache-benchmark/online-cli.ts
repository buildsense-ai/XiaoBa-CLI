#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fingerprintOnlineBenchmarkArtifact } from './online-artifact';

interface OnlineCliOptions {
  credentialPath: string;
  outputDirectory: string;
  runtimeDataDirectory: string;
  provider: 'newcli' | 'deepseek';
  round: number;
  warmCalls: number;
}

export async function runOnlineCacheBenchmarkCli(argv: string[]): Promise<0 | 1 | 2> {
  try {
    const options = parseArguments(argv);
    const artifactRootDirectory = path.resolve(__dirname, '../..');
    const expectedArtifactFingerprint = fingerprintOnlineBenchmarkArtifact(artifactRootDirectory);
    prepareFreshRuntimeDataDirectory(options.runtimeDataDirectory);
    process.env.XIAOBA_USER_DATA_DIR = options.runtimeDataDirectory;
    process.env.XIAOBA_SKILLS_DIR = path.join(options.runtimeDataDirectory, 'skills');
    const { runOnlineCacheBenchmark } = await import('./online-runner');
    const result = await runOnlineCacheBenchmark({
      ...options,
      artifactRootDirectory,
      expectedArtifactFingerprint,
      skillsDirectory: process.env.XIAOBA_SKILLS_DIR,
      onProgress: progress => {
        process.stdout.write(`${JSON.stringify({
          provider: progress.provider,
          case_id: progress.caseId,
          cache_class: progress.cacheClass,
          logical_call: progress.logicalCall,
          input_tokens: progress.inputTokens,
          cache_read_tokens: progress.cacheReadTokens,
          cache_read_source: progress.cacheReadSource,
          quality_passed: progress.qualityPassed,
          safety_passed: progress.safetyPassed,
        })}\n`);
      },
    });
    process.stdout.write(`${JSON.stringify({
      status: 'sealed',
      provider: options.provider,
      round: options.round,
      attempt_count: result.evidence.attempts.length,
      artifact_fingerprint: result.evidence.header.artifact_fingerprint,
    })}\n`);
    return 0;
  } catch (error: any) {
    process.stderr.write(`${JSON.stringify({
      status: 'failed',
      code: safeOnlineBenchmarkErrorCode(error),
    })}\n`);
    return 2;
  }
}

function parseArguments(argv: string[]): OnlineCliOptions {
  const values = new Map<string, string>();
  const allowed = new Set([
    '--credentials',
    '--output-dir',
    '--runtime-data-dir',
    '--provider',
    '--round',
    '--warm-calls',
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || values.has(key) || !value || value.startsWith('--')) {
      throw new Error('arguments_invalid');
    }
    values.set(key, value);
  }
  if (values.size !== allowed.size) throw new Error('arguments_invalid');
  const provider = values.get('--provider');
  if (provider !== 'newcli' && provider !== 'deepseek') throw new Error('provider_invalid');
  return {
    credentialPath: path.resolve(values.get('--credentials')!),
    outputDirectory: path.resolve(values.get('--output-dir')!),
    runtimeDataDirectory: path.resolve(values.get('--runtime-data-dir')!),
    provider,
    round: parsePositiveInteger(values.get('--round')),
    warmCalls: parsePositiveInteger(values.get('--warm-calls')),
  };
}

export function prepareFreshRuntimeDataDirectory(value: string): void {
  const directory = path.resolve(value);
  if (fs.existsSync(directory)) throw new Error('runtime_data_not_fresh');
  fs.mkdirSync(path.join(directory, 'skills'), { recursive: true, mode: 0o700 });
  const marker = path.join(directory, '.cache-benchmark-runtime-v1');
  fs.writeFileSync(marker, 'synthetic benchmark runtime\n', { mode: 0o600, flag: 'wx' });
  if (process.platform !== 'win32') {
    fs.chmodSync(directory, 0o700);
    fs.chmodSync(path.join(directory, 'skills'), 0o700);
    fs.chmodSync(marker, 0o600);
  }
}

function parsePositiveInteger(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]*$/.test(value)) throw new Error('arguments_invalid');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('arguments_invalid');
  return parsed;
}

export function safeOnlineBenchmarkErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as any).code || '')
    : error instanceof Error
      ? error.message
      : '';
  return SAFE_ERROR_CODES.has(code) ? code : 'online_benchmark_failed';
}

const SAFE_ERROR_CODES = new Set([
  'arguments_invalid',
  'artifact_directory_invalid',
  'artifact_drift_before_run',
  'artifact_drift_during_round',
  'artifact_empty',
  'artifact_entry_invalid',
  'artifact_file_invalid',
  'artifact_fingerprint_invalid',
  'artifact_symlink_invalid',
  'benchmark_partition_case_invalid',
  'benchmark_partition_nonce_invalid',
  'benchmark_partition_round_invalid',
  'benchmark_memory_fixture_closed',
  'benchmark_memory_fixture_invalid',
  'benchmark_memory_fixture_path_invalid',
  'benchmark_memory_fixture_tampered',
  'benchmark_skill_mismatch',
  'bootstrap_persistence_failed',
  'credential_path_invalid',
  'credential_file_not_private',
  'credential_parent_not_private',
  'credential_owner_mismatch',
  'credential_file_invalid',
  'credential_key_unknown',
  'credential_key_duplicate',
  'credential_value_invalid',
  'credential_provider_incomplete',
  'evidence_directory_invalid',
  'evidence_file_exists',
  'evidence_file_invalid',
  'evidence_file_not_private',
  'evidence_owner_mismatch',
  'goal_persistence_failed',
  'journal_existing_invalid',
  'journal_open_failed',
  'journal_write_failed',
  'ledger_suite_mismatch',
  'manifest_case_missing',
  'manifest_mismatch',
  'online_incomplete_round_exists',
  'online_lock_release_failed',
  'online_output_directory_invalid',
  'online_output_owner_mismatch',
  'online_round_already_reserved',
  'online_round_lease_invalid',
  'online_round_reservation_invalid',
  'online_round_reservation_not_private',
  'orphan_round_mismatch',
  'physical_attempt_metadata_mismatch',
  'provider_contract_missing',
  'provider_invalid',
  'round_invalid',
  'round_manifest_mismatch',
  'round_not_contiguous',
  'runtime_data_not_bootstrapped',
  'runtime_data_not_fresh',
  'runtime_data_not_private',
  'sealed_round_mismatch',
  'sealed_round_missing',
  'skills_path_not_bootstrapped',
  'skills_path_outside_runtime',
  'subagent_fixture_failed',
  'subagent_fixture_stop_timeout',
  'system_prompt_factory_missing',
  'warm_calls_invalid',
]);

if (require.main === module) {
  void runOnlineCacheBenchmarkCli(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
