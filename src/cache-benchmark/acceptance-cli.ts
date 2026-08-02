#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  aggregateCacheBenchmarkAcceptance,
  type AcceptanceProviderAlias,
  type CacheBenchmarkAcceptanceCandidate,
  type CacheBenchmarkAcceptanceResult,
  CACHE_BENCHMARK_ACCEPTANCE_SCHEMA,
  REQUIRED_ACCEPTANCE_PROVIDERS,
} from './acceptance';
import { canonicalJson } from './canonical';
import { parseLedgerJson, parseManifestJson, parseRoundJsonl } from './schema';
import { scoreCacheBenchmark } from './scorer';
import type {
  CacheBenchmarkLedger,
  CacheBenchmarkManifest,
  CacheBenchmarkRoundEvidence,
} from './types';

type ReportFormat = 'json' | 'text';

export function runCacheBenchmarkAcceptanceCli(argv: string[]): 0 | 1 | 2 {
  let format: ReportFormat = 'text';
  try {
    const options = parseArguments(argv);
    format = options.format;
    const candidates = REQUIRED_ACCEPTANCE_PROVIDERS.map(provider => (
      loadCandidate(provider, options.directories[provider])
    ));
    const result = aggregateCacheBenchmarkAcceptance(candidates);
    process.stdout.write(renderAcceptanceResult(result, format));
    return result.exit_code;
  } catch {
    process.stdout.write(format === 'json'
      ? `${canonicalJson({
        schema: CACHE_BENCHMARK_ACCEPTANCE_SCHEMA,
        status: 'invalid',
        exit_code: 2,
        reasons: ['input_invalid'],
      })}\n`
      : 'status=invalid\nexit_code=2\nreasons=input_invalid\n');
    return 2;
  }
}

function parseArguments(argv: string[]): {
  directories: Record<AcceptanceProviderAlias, string>;
  format: ReportFormat;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--newcli-dir', '--deepseek-dir', '--format'].includes(key) || values.has(key) || !value) {
      throw new Error('arguments_invalid');
    }
    values.set(key, value);
  }
  const format = values.get('--format');
  if (values.size !== 3 || (format !== 'json' && format !== 'text')) {
    throw new Error('arguments_invalid');
  }
  return {
    directories: {
      newcli: path.resolve(values.get('--newcli-dir')!),
      deepseek: path.resolve(values.get('--deepseek-dir')!),
    },
    format,
  };
}

function loadCandidate(provider: AcceptanceProviderAlias, directory: string): CacheBenchmarkAcceptanceCandidate {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('directory_invalid');
  assertOwnedPrivate(stat, 0o700);
  return withEvidenceSnapshot(directory, () => {
    const directoryBefore = fs.lstatSync(directory);
    const manifest = parseManifestJson(readPrivateEvidenceFile(directory, 'manifest.json'));
    const ledger = parseLedgerJson(readPrivateEvidenceFile(directory, 'ledger.json'));
    const rounds = ledger.rounds.map(entry => parseRoundJsonl(
      readPrivateEvidenceFile(directory, `round-${entry.round}.jsonl`),
    ));
    validateCompletedOnlineRuns(directory, manifest, ledger, rounds);
    const directoryAfter = fs.lstatSync(directory);
    if (!sameStablePath(directoryBefore, directoryAfter)) throw new Error('directory_changed');
    return { provider, manifest, result: scoreCacheBenchmark(manifest, ledger, rounds) };
  });
}

function withEvidenceSnapshot<T>(directory: string, operation: () => T): T {
  const lockPath = path.join(directory, '.online-run.lock');
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      lockPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow,
      0o600,
    );
    fs.writeFileSync(descriptor, '{"schema":"xiaoba.cache_benchmark_acceptance_read.v1"}\n');
    fs.fsyncSync(descriptor);
    assertOwnedPrivate(fs.fstatSync(descriptor), 0o600);
    return operation();
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } finally { fs.unlinkSync(lockPath); }
    }
  }
}

export function validateCompletedOnlineRuns(
  directory: string,
  manifest: CacheBenchmarkManifest,
  ledger: CacheBenchmarkLedger,
  rounds: readonly CacheBenchmarkRoundEvidence[],
): void {
  const entries = fs.readdirSync(directory);
  const evidencePattern = /^round-([1-9][0-9]*)\.jsonl$/u;
  const reservationPattern = /^round-([1-9][0-9]*)\.run\.jsonl$/u;
  if (entries.some(entry => entry.startsWith('round-')
    && !evidencePattern.test(entry)
    && !reservationPattern.test(entry))) {
    throw new Error('online_round_entry_invalid');
  }
  const evidenceRounds = collectRoundNumbers(entries, evidencePattern);
  const reservationRounds = collectRoundNumbers(entries, reservationPattern);
  const expectedRounds = ledger.rounds.map(entry => entry.round);
  if (!sameNumberSet(evidenceRounds, expectedRounds)
    || !sameNumberSet(reservationRounds, expectedRounds)) {
    throw new Error('online_round_set_mismatch');
  }
  const evidenceByRound = new Map(rounds.map(round => [round.header.round, round]));
  for (const ledgerRound of ledger.rounds) {
    const evidence = evidenceByRound.get(ledgerRound.round);
    if (!evidence) throw new Error('online_round_missing');
    const source = readPrivateEvidenceFile(directory, `round-${ledgerRound.round}.run.jsonl`);
    const lines = source.split(/\r?\n/u).filter(Boolean);
    if (lines.length !== 2) throw new Error('online_round_reservation_invalid');
    const started = parseExactJsonRecord(lines[0], [
      'schema',
      'state',
      'suite_id',
      'round',
      'cache_partition_nonce',
      'artifact_fingerprint',
      'manifest_fingerprint',
      'config_fingerprint',
    ]);
    const sealed = parseExactJsonRecord(lines[1], [
      'schema',
      'state',
      'evidence_fingerprint',
    ]);
    if (
      started.schema !== 'xiaoba.cache_benchmark_online_run.v1'
      || started.state !== 'started'
      || started.suite_id !== manifest.suite_id
      || started.round !== ledgerRound.round
      || started.cache_partition_nonce !== evidence.header.cache_partition_nonce
      || started.artifact_fingerprint !== evidence.header.artifact_fingerprint
      || started.manifest_fingerprint !== evidence.header.manifest_fingerprint
      || started.config_fingerprint !== evidence.header.config_fingerprint
      || sealed.schema !== 'xiaoba.cache_benchmark_online_run.v1'
      || sealed.state !== 'sealed'
      || sealed.evidence_fingerprint !== ledgerRound.evidence_fingerprint
    ) throw new Error('online_round_reservation_mismatch');
  }
}

function collectRoundNumbers(entries: readonly string[], pattern: RegExp): number[] {
  return entries.flatMap(entry => {
    const match = entry.match(pattern);
    return match ? [Number(match[1])] : [];
  });
}

function sameNumberSet(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length
    && [...left].sort((a, b) => a - b).every((value, index) => (
      value === [...right].sort((a, b) => a - b)[index]
    ));
}

function parseExactJsonRecord(source: string, keys: readonly string[]): Record<string, unknown> {
  const value = JSON.parse(source) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('online_round_reservation_invalid');
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('online_round_reservation_invalid');
  }
  return record;
}

function readPrivateEvidenceFile(directory: string, filename: string): string {
  const filePath = path.join(directory, filename);
  const directoryBefore = fs.lstatSync(directory);
  const pathBefore = fs.lstatSync(filePath);
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) throw new Error('evidence_invalid');
  assertOwnedPrivate(pathBefore, 0o600);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) throw new Error('evidence_invalid');
    assertOwnedPrivate(before, 0o600);
    if (before.dev !== pathBefore.dev || before.ino !== pathBefore.ino) {
      throw new Error('evidence_replaced');
    }
    const content = fs.readFileSync(descriptor, 'utf8');
    const after = fs.fstatSync(descriptor);
    const directoryAfter = fs.lstatSync(directory);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || directoryBefore.dev !== directoryAfter.dev
      || directoryBefore.ino !== directoryAfter.ino
      || directoryAfter.isSymbolicLink()
      || !directoryAfter.isDirectory()
    ) throw new Error('evidence_replaced');
    const pathAfter = fs.lstatSync(filePath);
    if (!sameStablePath(pathBefore, pathAfter) || pathAfter.isSymbolicLink() || !pathAfter.isFile()) {
      throw new Error('evidence_replaced');
    }
    assertOwnedPrivate(directoryAfter, 0o700);
    return content;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sameStablePath(before: fs.Stats, after: fs.Stats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs
    && (before.mode & 0o777) === (after.mode & 0o777);
}

function assertOwnedPrivate(stat: fs.Stats, expectedMode: number): void {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('evidence_owner_mismatch');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== expectedMode) {
    throw new Error('evidence_not_private');
  }
}

export function renderAcceptanceResult(result: CacheBenchmarkAcceptanceResult, format: ReportFormat): string {
  if (format === 'json') return `${canonicalJson(result)}\n`;
  const lines = [
    `status=${result.status}`,
    `exit_code=${result.exit_code}`,
    `artifact_fingerprint=${result.artifact_fingerprint ?? 'none'}`,
    `workload_contract_fingerprint=${result.workload_contract_fingerprint ?? 'none'}`,
    `reasons=${result.reasons.join(',') || 'none'}`,
  ];
  for (const provider of result.providers) {
    lines.push([
      `provider=${provider.provider}`,
      `status=${provider.status}`,
      `manifest_fingerprint=${provider.manifest_fingerprint}`,
      `config_fingerprint=${provider.config_fingerprint}`,
      `ledger_fingerprint=${provider.ledger_fingerprint}`,
      `qualifying_rounds=${provider.qualifying_rounds.join(',') || 'none'}`,
      `artifact_fingerprint=${provider.artifact_fingerprint ?? 'none'}`,
    ].join(' '));
  }
  return `${lines.join('\n')}\n`;
}

if (require.main === module) {
  process.exitCode = runCacheBenchmarkAcceptanceCli(process.argv.slice(2));
}
