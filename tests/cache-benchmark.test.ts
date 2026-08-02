import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, test } from 'node:test';
import {
  CacheBenchmarkAttempt,
  CacheBenchmarkLedger,
  CacheBenchmarkManifest,
  CacheBenchmarkRoundEvidence,
  REQUIRED_CACHE_BENCHMARK_CAPABILITIES,
  canonicalJson,
  fingerprintConfig,
  fingerprintCanonical,
  fingerprintManifest,
  fingerprintRoundEvidence,
  parseManifestJson,
  parseRoundJsonl,
  renderCacheBenchmarkResult,
  runCacheBenchmarkCli,
  scoreCacheBenchmark,
} from '../src/cache-benchmark';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'cache-benchmark', 'manifest.json');
const ARTIFACT_A = `sha256:${'a'.repeat(64)}`;
const ARTIFACT_B = `sha256:${'b'.repeat(64)}`;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('cache benchmark evidence scorer', () => {
  test('passes at exactly 94% across the latest three rounds', () => {
    const manifest = fixtureManifest();
    const result = scoreRounds(manifest, [1, 2, 3].map(round => buildRound(manifest, round)));

    assert.equal(result.status, 'passed');
    assert.equal(result.exit_code, 0);
    assert.deepEqual(result.qualifying_rounds, [1, 2, 3]);
    assert.equal(result.rounds[0].cells[0].input_tokens, 2000);
    assert.equal(result.rounds[0].cells[0].cache_read_tokens, 1880);
    assert.equal(result.rounds[0].cells[0].raw_read_ratio, 0.94);
    assert.equal(result.rounds[0].cells[0].capped_task_ratio, 0.94);
  });

  test('passes the exact 94% water-filled boundary across many uneven tasks', () => {
    const manifest = fixtureManifest();
    const templates = structuredClone(manifest.cases);
    manifest.cases = Array.from({ length: 50 }, (_, index) => {
      const template = structuredClone(templates[index % templates.length]);
      const ordinal = index + 1;
      return {
        ...template,
        case_id: `uneven-case-${ordinal}`,
        task_id: `uneven-task-${ordinal}`,
        task_fixture_fingerprint: `sha256:${ordinal.toString(16).padStart(64, '0')}`,
        runs: template.runs.map(run => ({
          ...run,
          run_id: `uneven-run-${ordinal}`,
        })),
      };
    });
    const rounds = [1, 2, 3].map(round => buildRound(manifest, round, attempt => {
      const ordinal = Number(attempt.metadata.task_id.slice('uneven-task-'.length));
      attempt.usage.input_tokens = 50 * ordinal;
      attempt.usage.cache_read_tokens = 47 * ordinal;
    }));
    const result = scoreRounds(manifest, rounds);

    assert.equal(result.status, 'passed');
    assert.equal(result.exit_code, 0);
    assert.equal(result.rounds[0].cells[0].raw_read_ratio, 0.94);
    assert.ok(Math.abs((result.rounds[0].cells[0].capped_task_ratio ?? 0) - 0.94) <= 1e-12);
  });

  test('fails when the provider reports one fewer read token', () => {
    const manifest = fixtureManifest();
    const rounds = [1, 2, 3].map(round => buildRound(manifest, round));
    rounds[2].attempts[rounds[2].attempts.length - 1].usage.cache_read_tokens = 234;
    const result = scoreRounds(manifest, rounds);

    assert.equal(result.status, 'failed');
    assert.equal(result.exit_code, 1);
    assert.ok(result.reasons.includes('minimum_read_ratio_not_met'));
  });

  test('does not credit cache writes in the numerator', () => {
    const manifest = fixtureManifest();
    const rounds = [1, 2, 3].map(round => buildRound(manifest, round, attempt => {
      attempt.usage.cache_read_tokens = 0;
      attempt.usage.cache_write_tokens = attempt.usage.input_tokens;
    }));
    const result = scoreRounds(manifest, rounds);

    assert.equal(result.status, 'failed');
    assert.equal(result.rounds[0].cells[0].cache_read_tokens, 0);
  });

  test('treats a missing provider cache-read value as unobservable', () => {
    const manifest = fixtureManifest();
    const rounds = [1, 2, 3].map(round => buildRound(manifest, round));
    delete rounds[2].attempts[0].usage.cache_read_tokens;
    const result = scoreRounds(manifest, rounds);

    assert.equal(result.status, 'unobservable');
    assert.equal(result.exit_code, 2);
    assert.ok(result.reasons.includes('cache_read_not_reported'));
  });

  test('isolates provider instance, model, API type, and surface into separate cells', () => {
    const manifest = twoCellManifest();
    const rounds = [1, 2, 3].map(round => buildRound(manifest, round, attempt => {
      if (attempt.metadata.provider_instance_id === 'provider-local-b') {
        attempt.usage.cache_read_tokens = 0;
      }
    }));
    const result = scoreRounds(manifest, rounds);

    assert.equal(result.status, 'failed');
    assert.equal(result.rounds[0].cells.length, 2);
    assert.deepEqual(result.rounds[0].cells.map(cell => cell.status).sort(), ['failed', 'passed']);
  });

  test('invalidates retries, duplicate attempts, bad usage, and missing coverage', () => {
    const scenarios: Array<[string, (round: CacheBenchmarkRoundEvidence) => void, string]> = [
      ['retry', round => {
        const retry = structuredClone(round.attempts[0]);
        retry.attempt_id = 'retry-attempt';
        round.attempts.push(retry);
      }, 'duplicate_attempt'],
      ['duplicate', round => {
        round.attempts.push(structuredClone(round.attempts[0]));
      }, 'duplicate_attempt'],
      ['read exceeds input', round => {
        round.attempts[0].usage.cache_read_tokens = 251;
      }, 'cache_read_exceeds_input'],
      ['missing input', round => {
        delete round.attempts[0].usage.input_tokens;
      }, 'missing_input_usage'],
      ['zero input', round => {
        round.attempts[0].usage.input_tokens = 0;
      }, 'non_positive_input'],
      ['failed', round => {
        round.attempts[0].outcome = 'failed';
      }, 'non_succeeded_attempt'],
      ['cancelled', round => {
        round.attempts[0].outcome = 'cancelled';
      }, 'non_succeeded_attempt'],
      ['incomplete', round => {
        round.attempts[0].outcome = 'incomplete';
      }, 'non_terminal_attempt'],
      ['retrying', round => {
        round.attempts[0].outcome = 'retrying';
      }, 'non_terminal_attempt'],
      ['coverage', round => {
        round.attempts = round.attempts.filter(attempt => !(attempt.case_id === 'case-1' && attempt.cache_class === 'warm'));
      }, 'missing_warm_attempt'],
      ['extra warm call', round => {
        const extra = structuredClone(round.attempts[1]);
        extra.call_id = 'extra-warm-call';
        extra.attempt_id = 'extra-warm-attempt';
        extra.attempt_number = round.attempts.length + 1;
        round.attempts.push(extra);
      }, 'unexpected_attempt_count'],
      ['metadata', round => {
        round.attempts[0].metadata.model = 'wrong-model';
      }, 'metadata_mismatch'],
      ['unknown run', round => {
        round.attempts[0].run_id = 'unknown-run';
      }, 'unknown_case_or_run'],
    ];

    for (const [label, mutate, reason] of scenarios) {
      const manifest = fixtureManifest();
      const rounds = [1, 2, 3].map(round => buildRound(manifest, round));
      mutate(rounds[2]);
      const result = scoreRounds(manifest, rounds);
      assert.equal(result.status, 'invalid', label);
      assert.equal(result.exit_code, 2, label);
      assert.ok(result.reasons.includes(reason as never), label);
    }
  });

  test('treats required warm calls as an exact contract rather than a minimum', () => {
    const manifest = fixtureManifest();
    manifest.cases[0].runs[0].required_warm_calls = 2;
    const result = scoreRounds(manifest, [1, 2, 3].map(round => buildRound(manifest, round)));

    assert.equal(result.status, 'invalid');
    assert.ok(result.reasons.includes('missing_warm_attempt'));
  });

  test('requires both raw and 25% water-filled task ratios to pass', () => {
    const manifest = fixtureManifest();
    const rounds = [1, 2, 3].map(round => buildRound(manifest, round, attempt => {
      if (attempt.metadata.task_id === 'task-1') {
        attempt.usage.input_tokens = 4850;
        attempt.usage.cache_read_tokens = 4850;
      } else {
        attempt.usage.input_tokens = 50;
        attempt.usage.cache_read_tokens = 0;
      }
    }));
    const result = scoreRounds(manifest, rounds);
    const cell = result.rounds[0].cells[0];

    assert.equal(cell.raw_read_ratio, 0.97);
    assert.ok(cell.capped_task_ratio !== null && Math.abs(cell.capped_task_ratio - 0.25) < 1e-12);
    assert.equal(result.status, 'failed');
    assert.ok(result.reasons.includes('minimum_capped_task_ratio_not_met'));
  });

  test('marks a cell incomplete when fewer than four tasks have positive weight', () => {
    const manifest = fixtureManifest();
    manifest.cases = manifest.cases.slice(0, 3);
    manifest.cases[0].capabilities = [...REQUIRED_CACHE_BENCHMARK_CAPABILITIES];
    const result = scoreRounds(manifest, [1, 2, 3].map(round => buildRound(manifest, round)));

    assert.equal(result.status, 'incomplete');
    assert.equal(result.exit_code, 1);
    assert.ok(result.reasons.includes('insufficient_positive_tasks'));
  });

  test('resets on artifact drift and passes again only after three new consecutive rounds', () => {
    const manifest = fixtureManifest();
    const firstFour = [
      buildRound(manifest, 1, undefined, ARTIFACT_A),
      buildRound(manifest, 2, undefined, ARTIFACT_A),
      buildRound(manifest, 3, undefined, ARTIFACT_A),
      buildRound(manifest, 4, undefined, ARTIFACT_B),
    ];
    const reset = scoreRounds(manifest, firstFour);
    assert.equal(reset.status, 'incomplete');
    assert.deepEqual(reset.qualifying_rounds, [4]);

    const repassed = scoreRounds(manifest, [
      ...firstFour,
      buildRound(manifest, 5, undefined, ARTIFACT_B),
      buildRound(manifest, 6, undefined, ARTIFACT_B),
    ]);
    assert.equal(repassed.status, 'passed');
    assert.deepEqual(repassed.qualifying_rounds, [4, 5, 6]);
  });

  test('ledger prevents omitting the latest failed round', () => {
    const manifest = fixtureManifest();
    const rounds = [1, 2, 3, 4].map(round => buildRound(manifest, round));
    for (const attempt of rounds[3].attempts) attempt.usage.cache_read_tokens = 0;
    const completeLedger = buildLedger(manifest, rounds);
    const result = scoreCacheBenchmark(manifest, completeLedger, rounds.slice(0, 3));

    assert.equal(result.status, 'invalid');
    assert.equal(result.exit_code, 2);
    assert.ok(result.ledger_reasons.includes('missing_ledger_round'));
    assert.match(result.ledger_fingerprint, /^sha256:[a-f0-9]{64}$/);
  });

  test('an old invalid round breaks the streak but does not block rounds 2-4 from passing', () => {
    const manifest = fixtureManifest();
    const rounds = [1, 2, 3, 4].map(round => buildRound(manifest, round));
    rounds[0].attempts[0].outcome = 'failed';
    const result = scoreRounds(manifest, rounds);

    assert.equal(result.rounds[0].status, 'invalid');
    assert.equal(result.status, 'passed');
    assert.deepEqual(result.qualifying_rounds, [2, 3, 4]);
  });

  test('an old unobservable round also permits a clean three-round recovery', () => {
    const manifest = fixtureManifest();
    const rounds = [1, 2, 3, 4].map(round => buildRound(manifest, round));
    delete rounds[0].attempts[0].usage.cache_read_tokens;
    const result = scoreRounds(manifest, rounds);

    assert.equal(result.rounds[0].status, 'unobservable');
    assert.equal(result.status, 'passed');
    assert.deepEqual(result.qualifying_rounds, [2, 3, 4]);
  });

  test('ledger requires the complete contiguous 1..latest evidence set and exact fingerprints', () => {
    const manifest = fixtureManifest();
    const rounds = [1, 2, 3].map(round => buildRound(manifest, round));

    const nonContiguous = buildLedger(manifest, rounds);
    nonContiguous.rounds[1].round = 3;
    let result = scoreCacheBenchmark(manifest, nonContiguous, rounds);
    assert.equal(result.status, 'invalid');
    assert.ok(result.ledger_reasons.includes('ledger_rounds_not_contiguous'));

    const tampered = buildLedger(manifest, rounds);
    tampered.rounds[2].evidence_fingerprint = `sha256:${'f'.repeat(64)}`;
    result = scoreCacheBenchmark(manifest, tampered, rounds);
    assert.equal(result.status, 'invalid');
    assert.ok(result.ledger_reasons.includes('evidence_fingerprint_mismatch'));

    const extra = buildRound(manifest, 4);
    result = scoreCacheBenchmark(manifest, buildLedger(manifest, rounds), [...rounds, extra]);
    assert.equal(result.status, 'invalid');
    assert.ok(result.ledger_reasons.includes('unexpected_evidence_round'));
  });

  test('uses the latest rounds rather than selecting an older passing trio', () => {
    const manifest = fixtureManifest();
    const rounds = [1, 2, 3, 4].map(round => buildRound(manifest, round));
    for (const attempt of rounds[3].attempts) attempt.usage.cache_read_tokens = 0;
    const result = scoreRounds(manifest, rounds);

    assert.equal(result.status, 'failed');
    assert.deepEqual(result.qualifying_rounds, []);
  });

  test('binds cache-read sources to strict adapter and API contracts', () => {
    const manifest = fixtureManifest();
    manifest.cases[0].cache_read_source = 'anthropic.cache_read_input_tokens';
    assert.throws(() => parseManifestJson(JSON.stringify(manifest)));

    const illegalAdapterApi = fixtureManifest();
    illegalAdapterApi.cases[0].provider_adapter = 'anthropic';
    assert.throws(() => parseManifestJson(JSON.stringify(illegalAdapterApi)));

    const heterogeneousSource = fixtureManifest();
    heterogeneousSource.cases[1].cache_read_source = 'provider-compatible-declared';
    assert.throws(() => parseManifestJson(JSON.stringify(heterogeneousSource)));

    const sourceMismatchManifest = fixtureManifest();
    const rounds = [1, 2, 3].map(round => buildRound(sourceMismatchManifest, round));
    rounds[2].attempts[0].usage.cache_read_source = 'provider-compatible-declared';
    const result = scoreRounds(sourceMismatchManifest, rounds);
    assert.equal(result.status, 'invalid');
    assert.ok(result.reasons.includes('metadata_mismatch'));
  });

  test('includes provider adapter in the independent cell fingerprint', () => {
    const manifest = fixtureManifest();
    const result = scoreRounds(manifest, [1, 2, 3].map(round => buildRound(manifest, round)));
    const entry = manifest.cases[0];
    assert.equal(result.rounds[0].cells[0].cell_fingerprint, canonicalCellFingerprint(entry));
  });

  test('reports fixed Goal capabilities missing from each provider-model-API scope', () => {
    const manifest = fixtureManifest();
    manifest.cases[3].capabilities = ['runtime-feedback'];
    const result = scoreRounds(manifest, [1, 2, 3].map(round => buildRound(manifest, round)));

    assert.equal(result.status, 'incomplete');
    assert.ok(result.reasons.includes('capability_coverage_incomplete'));
    assert.deepEqual(result.capability_coverage[0].missing_capabilities, ['session-recovery']);
  });

  test('aggregates capability coverage across surfaces in the same provider-model-API scope', () => {
    const manifest = fixtureManifest();
    manifest.cases[3].surface = 'group-chat';
    const result = scoreRounds(manifest, [1, 2, 3].map(round => buildRound(manifest, round)));

    assert.equal(result.capability_coverage.length, 1);
    assert.equal(result.capability_coverage[0].status, 'passed');
    assert.deepEqual(result.capability_coverage[0].missing_capabilities, []);
  });

  test('canonical manifest fingerprint is stable across case and run ordering', () => {
    const manifest = fixtureManifest();
    const reordered = structuredClone(manifest);
    reordered.cases.reverse();
    for (const entry of reordered.cases) entry.runs.reverse();

    assert.equal(fingerprintManifest(manifest), fingerprintManifest(reordered));
    assert.match(fingerprintManifest(manifest), /^sha256:[a-f0-9]{64}$/);
    assert.equal(canonicalJson({ z: 1, a: 2 }), canonicalJson({ a: 2, z: 1 }));
  });

  test('binds every attempt to its round header and physical JSONL order', () => {
    const manifest = fixtureManifest();
    const rounds = [1, 2, 3].map(round => buildRound(manifest, round));
    rounds[2].attempts[0].round = 2;
    let result = scoreRounds(manifest, rounds);
    assert.equal(result.status, 'invalid');
    assert.ok(result.reasons.includes('metadata_mismatch'));

    const reordered = [1, 2, 3].map(round => buildRound(manifest, round));
    [reordered[2].attempts[0], reordered[2].attempts[1]] = [reordered[2].attempts[1], reordered[2].attempts[0]];
    result = scoreRounds(manifest, reordered);
    assert.equal(result.status, 'invalid');
    assert.ok(result.reasons.includes('metadata_mismatch'));
  });

  test('parses strict JSONL with one header and rejects legacy or extra fields', () => {
    const manifest = fixtureManifest();
    const round = buildRound(manifest, 1);
    const parsed = parseRoundJsonl(roundToJsonl(round));
    assert.equal(parsed.attempts.length, 8);

    const legacy = JSON.stringify({ schema: 'xiaoba.cache_trace.v4' });
    assert.throws(() => parseRoundJsonl(legacy));
    const withPrompt = JSON.parse(JSON.stringify(round.attempts[0]));
    withPrompt.prompt = 'SECRET_SENTINEL';
    assert.throws(() => parseRoundJsonl(`${JSON.stringify(round.header)}\n${JSON.stringify(withPrompt)}\n`));
  });

  test('accepts namespaced model IDs but rejects endpoint-shaped provider identities', () => {
    const manifest = fixtureManifest();
    manifest.cases[0].model = 'vendor/model-a';
    assert.doesNotThrow(() => parseManifestJson(JSON.stringify(manifest)));

    manifest.cases[0].provider_instance_id = 'https://endpoint.invalid';
    assert.throws(() => parseManifestJson(JSON.stringify(manifest)));
  });
});

describe('cache benchmark CLI safety', () => {
  test('is offline, writes deterministic output with 0600 mode, and does not disclose secret fields or paths', () => {
    const manifest = fixtureManifest();
    const directory = makeTemporaryDirectory();
    const manifestPath = path.join(directory, 'manifest.json');
    const ledgerPath = path.join(directory, 'ledger.json');
    const outputPath = path.join(directory, 'result.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const rounds = [1, 2, 3].map(roundNumber => buildRound(manifest, roundNumber));
    fs.writeFileSync(ledgerPath, JSON.stringify(buildLedger(manifest, rounds)));
    const evidencePaths = rounds.map(round => {
      const roundNumber = round.header.round;
      const evidencePath = path.join(directory, `round-${roundNumber}.jsonl`);
      fs.writeFileSync(evidencePath, roundToJsonl(round));
      return evidencePath;
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('network must not be used');
    }) as typeof fetch;
    try {
      const exitCode = runCacheBenchmarkCli([
        '--manifest', manifestPath,
        '--ledger', ledgerPath,
        ...evidencePaths.flatMap(evidencePath => ['--evidence', evidencePath]),
        '--format', 'json',
        '--output', outputPath,
      ]);
      assert.equal(exitCode, 0);
    } finally {
      globalThis.fetch = previousFetch;
    }
    const output = fs.readFileSync(outputPath, 'utf8');
    assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
    assert.equal(output.includes(directory), false);
    assert.equal(output.includes('http'), false);
    assert.equal(output, renderCacheBenchmarkResult(
      scoreRounds(manifest, [1, 2, 3].map(round => buildRound(manifest, round))),
      'json',
    ));

    const invalidPath = path.join(directory, 'SECRET_SENTINEL-input.json');
    fs.writeFileSync(invalidPath, JSON.stringify({ ...manifest, prompt: 'SECRET_SENTINEL' }));
    const invalidOutputPath = path.join(directory, 'invalid.json');
    assert.equal(runCacheBenchmarkCli([
      '--manifest', invalidPath,
      '--ledger', ledgerPath,
      '--format', 'json',
      '--output', invalidOutputPath,
    ]), 2);
    const invalidOutput = fs.readFileSync(invalidOutputPath, 'utf8');
    assert.equal(invalidOutput.includes('SECRET_SENTINEL'), false);
    assert.equal(invalidOutput.includes(directory), false);
  });

  test('returns 0/1/2 from the actual CLI process for pass, fail, and invalid evidence', () => {
    const manifest = fixtureManifest();
    const directory = makeTemporaryDirectory();
    const manifestPath = path.join(directory, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const passingRounds = [1, 2, 3].map(round => buildRound(manifest, round));
    const passingPaths = writeRoundFiles(directory, passingRounds);
    const passingLedgerPath = writeLedger(directory, manifest, passingRounds, 'pass');
    const passing = spawnCli(manifestPath, passingLedgerPath, passingPaths);
    assert.equal(passing.status, 0);
    assert.equal(passing.stdout.includes(directory), false);

    const failingRounds = [1, 2, 3].map(round => buildRound(manifest, round));
    failingRounds[2].attempts[0].usage.cache_read_tokens = 234;
    const failingPaths = writeRoundFiles(directory, failingRounds, 'fail');
    const failingLedgerPath = writeLedger(directory, manifest, failingRounds, 'fail');
    const failing = spawnCli(manifestPath, failingLedgerPath, failingPaths);
    assert.equal(failing.status, 1);
    assert.equal(failing.stdout.includes(directory), false);

    const invalidManifestPath = path.join(directory, 'SECRET_SENTINEL-invalid.json');
    fs.writeFileSync(invalidManifestPath, JSON.stringify({ ...manifest, response: 'SECRET_SENTINEL' }));
    const invalid = spawnCli(invalidManifestPath, passingLedgerPath, passingPaths);
    assert.equal(invalid.status, 2);
    assert.equal(invalid.stdout.includes('SECRET_SENTINEL'), false);
    assert.equal(invalid.stdout.includes(directory), false);
    assert.equal(invalid.stderr, '');
  });
});

function fixtureManifest(): CacheBenchmarkManifest {
  return parseManifestJson(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

function canonicalCellFingerprint(entry: CacheBenchmarkManifest['cases'][number]): string {
  return fingerprintCanonical({
    provider_instance_id: entry.provider_instance_id,
    provider_adapter: entry.provider_adapter,
    model: entry.model,
    api_type: entry.api_type,
    surface: entry.surface,
  });
}

function twoCellManifest(): CacheBenchmarkManifest {
  const manifest = fixtureManifest();
  const secondCell = manifest.cases.map((entry, index) => ({
    ...structuredClone(entry),
    case_id: `case-b-${index + 1}`,
    provider_instance_id: 'provider-local-b',
    model: 'model-b',
    api_type: 'openai-chat-completions',
    surface: 'group-chat',
    cache_read_source: 'deepseek.prompt_cache_hit_tokens',
    task_id: `task-b-${index + 1}`,
    runs: entry.runs.map(run => ({ ...run, run_id: `run-b-${index + 1}` })),
  }));
  manifest.cases.push(...secondCell);
  return manifest;
}

function buildRound(
  manifest: CacheBenchmarkManifest,
  round: number,
  mutateAttempt?: (attempt: CacheBenchmarkAttempt) => void,
  artifactFingerprint = ARTIFACT_A,
): CacheBenchmarkRoundEvidence {
  const attempts: CacheBenchmarkAttempt[] = [];
  for (const entry of manifest.cases) {
    for (const run of entry.runs) {
      for (const cacheClass of ['cold', 'warm'] as const) {
        const attempt: CacheBenchmarkAttempt = {
          schema: 'xiaoba.cache_benchmark_attempt.v1',
          suite_id: manifest.suite_id,
          round,
          attempt_number: attempts.length + 1,
          case_id: entry.case_id,
          run_id: run.run_id,
          call_id: `${entry.case_id}-${run.run_id}-${cacheClass}`,
          attempt_id: `${entry.case_id}-${run.run_id}-${cacheClass}-attempt`,
          metadata: {
            provider_instance_id: entry.provider_instance_id,
            provider_adapter: entry.provider_adapter,
            model: entry.model,
            api_type: entry.api_type,
            surface: entry.surface,
            task_id: entry.task_id,
            task_fixture_fingerprint: entry.task_fixture_fingerprint,
            scenario_family: entry.scenario_family,
            session_type: entry.session_type,
          },
          cache_class: cacheClass,
          outcome: 'succeeded',
          usage: {
            input_tokens: 250,
            cache_read_tokens: 235,
            cache_read_source: entry.cache_read_source,
          },
        };
        mutateAttempt?.(attempt);
        attempts.push(attempt);
      }
    }
  }
  return {
    header: {
      schema: 'xiaoba.cache_benchmark_round.v1',
      suite_id: manifest.suite_id,
      round,
      artifact_fingerprint: artifactFingerprint,
      manifest_fingerprint: fingerprintManifest(manifest),
      config_fingerprint: fingerprintConfig(manifest),
    },
    attempts,
  };
}

function roundToJsonl(round: CacheBenchmarkRoundEvidence): string {
  return `${[round.header, ...round.attempts].map(line => JSON.stringify(line)).join('\n')}\n`;
}

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-benchmark-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function buildLedger(
  manifest: CacheBenchmarkManifest,
  rounds: CacheBenchmarkRoundEvidence[],
): CacheBenchmarkLedger {
  const ordered = [...rounds].sort((left, right) => left.header.round - right.header.round);
  return {
    schema: 'xiaoba.cache_benchmark_ledger.v1',
    suite_id: manifest.suite_id,
    latest_round: ordered[ordered.length - 1]?.header.round ?? 1,
    rounds: ordered.map(round => ({
      round: round.header.round,
      evidence_fingerprint: fingerprintRoundEvidence(round),
    })),
  };
}

function scoreRounds(
  manifest: CacheBenchmarkManifest,
  rounds: CacheBenchmarkRoundEvidence[],
  ledger = buildLedger(manifest, rounds),
) {
  return scoreCacheBenchmark(manifest, ledger, rounds);
}

function writeRoundFiles(
  directory: string,
  rounds: CacheBenchmarkRoundEvidence[],
  prefix = 'pass',
): string[] {
  return rounds.map(round => {
    const evidencePath = path.join(directory, `${prefix}-round-${round.header.round}.jsonl`);
    fs.writeFileSync(evidencePath, roundToJsonl(round));
    return evidencePath;
  });
}

function writeLedger(
  directory: string,
  manifest: CacheBenchmarkManifest,
  rounds: CacheBenchmarkRoundEvidence[],
  prefix: string,
): string {
  const ledgerPath = path.join(directory, `${prefix}-ledger.json`);
  fs.writeFileSync(ledgerPath, JSON.stringify(buildLedger(manifest, rounds)));
  return ledgerPath;
}

function spawnCli(
  manifestPath: string,
  ledgerPath: string,
  evidencePaths: string[],
): ReturnType<typeof spawnSync> {
  const useCompiledCli = process.env.XIAOBA_TEST_COMPILED_CACHE_CLI === '1';
  const runtimeArguments = useCompiledCli
    ? [path.join(process.cwd(), 'dist', 'cache-benchmark', 'cli.js')]
    : [require.resolve('tsx/cli'), path.join(process.cwd(), 'src', 'cache-benchmark', 'cli.ts')];
  return spawnSync(
    process.execPath,
    [
      ...runtimeArguments,
      '--manifest', manifestPath,
      '--ledger', ledgerPath,
      ...evidencePaths.flatMap(evidencePath => ['--evidence', evidencePath]),
      '--format', 'json',
    ],
    { encoding: 'utf8' },
  );
}
