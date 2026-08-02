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
  parseLedgerJson,
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
    assert.equal(result.rounds[0].cells[0].qualification_cache_class, 'warm');
    assert.equal(result.rounds[0].cells[0].input_tokens, 1000);
    assert.equal(result.rounds[0].cells[0].cache_read_tokens, 940);
    assert.equal(result.rounds[0].cells[0].raw_read_ratio, 0.94);
    assert.equal(result.rounds[0].cells[0].capped_task_ratio, 0.94);
    assert.equal(result.rounds[0].cells[0].cold_input_tokens, 1000);
    assert.equal(result.rounds[0].cells[0].cold_cache_read_tokens, 940);
    assert.equal(result.rounds[0].cells[0].cold_read_ratio, 0.94);
    assert.equal(result.rounds[0].cells[0].all_input_tokens, 2000);
    assert.equal(result.rounds[0].cells[0].all_cache_read_tokens, 1880);
    assert.equal(result.rounds[0].cells[0].all_read_ratio, 0.94);
  });

  test('never promotes an explicit calibration profile to final acceptance', () => {
    const manifest = fixtureManifest();
    manifest.benchmark_profile = 'calibration';
    manifest.workload_contract_fingerprint = `sha256:${'c'.repeat(64)}`;
    const result = scoreRounds(manifest, [1, 2, 3].map(round => buildRound(manifest, round)));

    assert.equal(result.status, 'incomplete');
    assert.equal(result.exit_code, 1);
    assert.deepEqual(result.qualifying_rounds, [1, 2, 3]);
    assert.deepEqual(result.reasons, ['calibration_only']);
  });

  test('does not let calibration_only hide a real ratio failure', () => {
    const manifest = fixtureManifest();
    manifest.benchmark_profile = 'calibration';
    manifest.workload_contract_fingerprint = `sha256:${'c'.repeat(64)}`;
    const rounds = [1, 2, 3].map(round => buildRound(manifest, round));
    setProviderUsage(rounds[2].attempts[rounds[2].attempts.length - 1], 250, 234);
    const result = scoreRounds(manifest, rounds);

    assert.equal(result.status, 'failed');
    assert.equal(result.exit_code, 1);
    assert.ok(result.reasons.includes('minimum_read_ratio_not_met'));
    assert.equal(result.reasons.includes('calibration_only'), false);
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
      setProviderUsage(attempt, 50 * ordinal, 47 * ordinal);
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
    setProviderUsage(rounds[2].attempts[rounds[2].attempts.length - 1], 250, 234);
    const result = scoreRounds(manifest, rounds);

    assert.equal(result.status, 'failed');
    assert.equal(result.exit_code, 1);
    assert.ok(result.reasons.includes('minimum_read_ratio_not_met'));
  });

  test('does not credit cache writes in the numerator', () => {
    const manifest = fixtureManifest();
    const rounds = [1, 2, 3].map(round => buildRound(manifest, round, attempt => {
      setProviderUsage(attempt, 250, 0, 250);
    }));
    const result = scoreRounds(manifest, rounds);

    assert.equal(result.status, 'failed');
    assert.equal(result.rounds[0].cells[0].cache_read_tokens, 0);
  });

  test('keeps cold usage observable as diagnostics but qualifies on warm attempts only', () => {
    const manifest = fixtureManifest();
    const rounds = [1, 2, 3].map(round => buildRound(manifest, round, attempt => {
      if (attempt.cache_class === 'cold') setProviderUsage(attempt, 250, 0);
    }));
    const result = scoreRounds(manifest, rounds);
    const cell = result.rounds[0].cells[0];

    assert.equal(result.status, 'passed');
    assert.equal(cell.qualification_cache_class, 'warm');
    assert.equal(cell.raw_read_ratio, 0.94);
    assert.equal(cell.cold_input_tokens, 1000);
    assert.equal(cell.cold_cache_read_tokens, 0);
    assert.equal(cell.cold_read_ratio, 0);
    assert.equal(cell.all_read_ratio, 0.47);
  });

  test('does not let a cache-hot cold diagnostic rescue warm evidence below 94%', () => {
    const manifest = fixtureManifest();
    const rounds = [1, 2, 3].map(round => buildRound(manifest, round, attempt => {
      setProviderUsage(attempt, 250, attempt.cache_class === 'cold' ? 250 : 234);
    }));
    const result = scoreRounds(manifest, rounds);

    assert.equal(result.status, 'failed');
    assert.equal(result.rounds[0].cells[0].cold_read_ratio, 1);
    assert.equal(result.rounds[0].cells[0].raw_read_ratio, 0.936);
    assert.ok(result.reasons.includes('minimum_read_ratio_not_met'));
  });

  test('retains valid provider usage from failed physical attempts in diagnostics only', () => {
    const manifest = fixtureManifest();
    const rounds = [1, 2, 3].map(round => buildRound(manifest, round));
    rounds[2].attempts[1].outcome = 'failed';
    setProviderUsage(rounds[2].attempts[1], 300, 120);
    const result = scoreRounds(manifest, rounds);
    const cell = result.rounds[2].cells[0];

    assert.equal(result.status, 'invalid');
    assert.ok(result.reasons.includes('non_succeeded_attempt'));
    assert.equal(cell.input_tokens, 750);
    assert.equal(cell.cache_read_tokens, 705);
    assert.equal(cell.cold_input_tokens, 1000);
    assert.equal(cell.cold_cache_read_tokens, 940);
    assert.equal(cell.all_input_tokens, 2050);
    assert.equal(cell.all_cache_read_tokens, 1765);
  });

  test('keeps a missing cold provider cache-read value unobservable', () => {
    const manifest = fixtureManifest();
    const rounds = [1, 2, 3].map(round => buildRound(manifest, round));
    setProviderUsage(rounds[2].attempts[0], 250, undefined);
    const result = scoreRounds(manifest, rounds);

    assert.equal(result.status, 'unobservable');
    assert.equal(result.exit_code, 2);
    assert.ok(result.reasons.includes('cache_read_not_reported'));
  });

  test('treats a missing provider input component as unobservable', () => {
    const manifest = fixtureManifest();
    const rounds = [1, 2, 3].map(round => buildRound(manifest, round));
    setProviderUsage(rounds[2].attempts[0], undefined, 235);
    const result = scoreRounds(manifest, rounds);

    assert.equal(result.status, 'unobservable');
    assert.equal(result.exit_code, 2);
    assert.ok(result.reasons.includes('missing_input_usage'));
  });

  test('isolates provider instance, model, API type, and surface into separate cells', () => {
    const manifest = twoCellManifest();
    const rounds = [1, 2, 3].map(round => buildRound(manifest, round, attempt => {
      if (attempt.metadata.provider_instance_id === 'provider-local-b') {
        setProviderUsage(attempt, 250, 0);
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
        setProviderUsage(round.attempts[0], 250, 251);
      }, 'cache_read_exceeds_input'],
      ['zero input', round => {
        setProviderUsage(round.attempts[0], 0, 0);
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

  test('allows variable memory-branch physical attempts and weights every provider token', () => {
    const manifest = fixtureManifest();
    manifest.cases[2].execution_role = 'memory_branch';
    const rounds = [1, 2, 3].map(round => buildRound(manifest, round));
    for (const evidence of rounds) {
      const branchCold = evidence.attempts.find(attempt => (
        attempt.case_id === manifest.cases[2].case_id && attempt.logical_call === 1
      ))!;
      const branchWarm = evidence.attempts.find(attempt => (
        attempt.case_id === manifest.cases[2].case_id && attempt.logical_call === 2
      ))!;
      for (const [template, suffix] of [
        [branchCold, 'cold-extra-1'],
        [branchWarm, 'warm-extra-1'],
        [branchWarm, 'warm-extra-2'],
      ] as const) {
        const extra = structuredClone(template);
        extra.call_id = `${extra.call_id}-${suffix}`;
        extra.attempt_id = `${extra.attempt_id}-${suffix}`;
        extra.attempt_number = evidence.attempts.length + 1;
        evidence.attempts.push(extra);
      }
      const branchAttempts = evidence.attempts
        .filter(attempt => attempt.case_id === manifest.cases[2].case_id)
        .sort((left, right) => left.logical_call - right.logical_call);
      evidence.attempts = [
        ...evidence.attempts.filter(attempt => attempt.case_id !== manifest.cases[2].case_id),
        ...branchAttempts,
      ];
      evidence.attempts.forEach((attempt, index) => { attempt.attempt_number = index + 1; });
    }
    const result = scoreRounds(manifest, rounds);

    assert.equal(result.status, 'passed');
    assert.equal(result.rounds[0].cells[0].input_tokens, 1500);
    assert.equal(result.rounds[0].cells[0].cache_read_tokens, 1410);
    assert.equal(result.rounds[0].cells[0].raw_read_ratio, 0.94);
    assert.equal(result.rounds[0].cells[0].cold_input_tokens, 1250);
    assert.equal(result.rounds[0].cells[0].cold_cache_read_tokens, 1175);
  });

  test('invalidates joined memory-branch evidence recorded after its main attempt', () => {
    const manifest = fixtureManifest();
    manifest.cases[1].task_id = manifest.cases[0].task_id;
    manifest.cases[1].execution_role = 'memory_branch';
    manifest.cases[1].runs[0].run_id = manifest.cases[0].runs[0].run_id;
    const result = scoreRounds(manifest, [1, 2, 3].map(round => buildRound(manifest, round)));

    assert.equal(result.status, 'invalid');
    assert.ok(result.reasons.includes('attempt_order_mismatch'));
  });

  test('accepts multiple paired runs without comparing one run branch to another run main', () => {
    const manifest = fixtureManifest();
    const main = manifest.cases[0];
    const branch = manifest.cases[1];
    branch.task_id = main.task_id;
    branch.execution_role = 'memory_branch';
    branch.runs[0].run_id = main.runs[0].run_id;
    main.runs.push({ ...main.runs[0], run_id: 'run-1-second' });
    branch.runs.push({ ...branch.runs[0], run_id: 'run-1-second' });
    const rounds = [1, 2, 3].map(roundNumber => {
      const round = buildRound(manifest, roundNumber);
      const paired = round.attempts.filter(attempt => attempt.metadata.task_id === main.task_id);
      const other = round.attempts.filter(attempt => attempt.metadata.task_id !== main.task_id);
      paired.sort((left, right) => (
        left.run_id.localeCompare(right.run_id)
        || left.logical_call - right.logical_call
        || (left.attempt_role === right.attempt_role ? 0 : left.attempt_role === 'memory_branch' ? -1 : 1)
      ));
      round.attempts = [...paired, ...other];
      round.attempts.forEach((attempt, index) => { attempt.attempt_number = index + 1; });
      return round;
    });
    const result = scoreRounds(manifest, rounds);

    assert.equal(result.rounds[0].reasons.includes('attempt_order_mismatch'), false);
  });

  test('invalidates a warm logical call recorded before its cold call', () => {
    const manifest = fixtureManifest();
    const rounds = [1, 2, 3].map(roundNumber => {
      const round = buildRound(manifest, roundNumber);
      [round.attempts[0], round.attempts[1]] = [round.attempts[1], round.attempts[0]];
      round.attempts[0].attempt_number = 1;
      round.attempts[1].attempt_number = 2;
      return round;
    });
    const result = scoreRounds(manifest, rounds);

    assert.equal(result.status, 'invalid');
    assert.ok(result.reasons.includes('attempt_order_mismatch'));
  });

  test('rejects cache-cold evidence that reuses a prior round nonce', () => {
    const manifest = fixtureManifest();
    const rounds = [1, 2, 3].map(round => buildRound(manifest, round));
    rounds[2].header.cache_partition_nonce = rounds[1].header.cache_partition_nonce;
    const result = scoreRounds(manifest, rounds);

    assert.equal(result.status, 'invalid');
    assert.ok(result.ledger_reasons.includes('duplicate_cache_partition_nonce'));
  });

  test('requires both raw and 25% water-filled task ratios to pass', () => {
    const manifest = fixtureManifest();
    const rounds = [1, 2, 3].map(round => buildRound(manifest, round, attempt => {
      if (attempt.metadata.task_id === 'task-1') {
        setProviderUsage(attempt, 4850, 4850);
      } else {
        setProviderUsage(attempt, 50, 0);
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
    for (const attempt of rounds[3].attempts) setProviderUsage(attempt, 250, 0);
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
    setProviderUsage(rounds[0].attempts[0], 250, undefined);
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
    for (const attempt of rounds[3].attempts) setProviderUsage(attempt, 250, 0);
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
    heterogeneousSource.cases[1].cache_read_source = 'provider-compatible-declared' as any;
    assert.throws(() => parseManifestJson(JSON.stringify(heterogeneousSource)));

    const sourceMismatchManifest = fixtureManifest();
    const rounds = [1, 2, 3].map(round => buildRound(sourceMismatchManifest, round));
    rounds[2].attempts[0].usage.provider_usage = {
      contract: 'deepseek-chat-v1',
      prompt_tokens: 250,
      prompt_cache_hit_tokens: 235,
    };
    const result = scoreRounds(sourceMismatchManifest, rounds);
    assert.equal(result.status, 'invalid');
    assert.ok(result.reasons.includes('metadata_mismatch'));
  });

  test('derives Anthropic input only when every raw denominator component is explicit', () => {
    const manifest = fixtureManifest();
    for (const benchmarkCase of manifest.cases) {
      benchmarkCase.provider_adapter = 'anthropic';
      benchmarkCase.api_type = 'anthropic-messages';
      benchmarkCase.cache_read_source = 'anthropic.cache_read_input_tokens';
    }
    const rounds = [1, 2, 3].map(round => buildRound(manifest, round, attempt => {
      setProviderUsage(attempt, 250, 235, 0);
    }));
    assert.equal(scoreRounds(manifest, rounds).status, 'passed');

    const raw = rounds[2].attempts[0].usage.provider_usage;
    assert.equal(raw?.contract, 'anthropic-messages-v1');
    if (raw?.contract === 'anthropic-messages-v1') delete raw.cache_creation_input_tokens;
    const result = scoreRounds(manifest, rounds);
    assert.equal(result.status, 'unobservable');
    assert.ok(result.reasons.includes('missing_input_usage'));
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

  test('requires deterministic quality and safety gates on every provider attempt', () => {
    const qualityManifest = fixtureManifest();
    const qualityRounds = [1, 2, 3].map(round => buildRound(qualityManifest, round));
    qualityRounds[2].attempts[0].attestation.quality_status = 'failed';
    let result = scoreRounds(qualityManifest, qualityRounds);
    assert.equal(result.status, 'failed');
    assert.ok(result.reasons.includes('quality_gate_failed'));

    const safetyManifest = fixtureManifest();
    const safetyRounds = [1, 2, 3].map(round => buildRound(safetyManifest, round));
    safetyRounds[2].attempts[0].attestation.safety_status = 'unobservable';
    result = scoreRounds(safetyManifest, safetyRounds);
    assert.equal(result.status, 'unobservable');
    assert.ok(result.reasons.includes('safety_gate_unobservable'));
  });

  test('computes capability coverage from observed request attestations', () => {
    const manifest = fixtureManifest();
    const rounds = [1, 2, 3].map(round => buildRound(manifest, round));
    rounds[2].attempts
      .filter(attempt => attempt.case_id === 'case-4')
      .forEach(attempt => {
        attempt.attestation.observed_capabilities = ['runtime-feedback'];
      });
    const result = scoreRounds(manifest, rounds);

    assert.equal(result.status, 'incomplete');
    assert.ok(result.reasons.includes('capability_coverage_incomplete'));
    assert.deepEqual(result.capability_coverage[0].missing_capabilities, ['session-recovery']);
  });

  test('invalidates oracle, execution-plan, and stable-prefix drift', () => {
    const scenarios: Array<[string, (round: CacheBenchmarkRoundEvidence) => void, string]> = [
      ['oracle', round => {
        round.attempts[0].attestation.oracle_contract_fingerprint = `sha256:${'f'.repeat(64)}`;
      }, 'oracle_contract_mismatch'],
      ['execution plan', round => {
        round.attempts[0].attestation.execution_plan_fingerprint = `sha256:${'f'.repeat(64)}`;
      }, 'execution_plan_mismatch'],
      ['stable prefix', round => {
        round.attempts[1].attestation.stable_prefix_fingerprint = `sha256:${'f'.repeat(64)}`;
      }, 'stable_prefix_drift'],
    ];
    for (const [label, mutate, reason] of scenarios) {
      const manifest = fixtureManifest();
      const rounds = [1, 2, 3].map(round => buildRound(manifest, round));
      mutate(rounds[2]);
      const result = scoreRounds(manifest, rounds);
      assert.equal(result.status, 'invalid', label);
      assert.ok(result.reasons.includes(reason as any), label);
    }
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

    const collectorNormalized = JSON.parse(JSON.stringify(round.attempts[0]));
    collectorNormalized.usage = {
      input_tokens: 250,
      cache_read_tokens: 235,
      cache_read_source: 'openai.input_tokens_details.cached_tokens',
    };
    assert.throws(() => parseRoundJsonl(
      `${JSON.stringify(round.header)}\n${JSON.stringify(collectorNormalized)}\n`,
    ));
  });

  test('rejects all v4 evidence schemas and any attempt to include cold usage in the primary ratio', () => {
    const legacy = structuredClone(fixtureManifest()) as any;
    legacy.schema = 'xiaoba.cache_benchmark_manifest.v4';
    assert.throws(() => parseManifestJson(JSON.stringify(legacy)));

    const coldIncluded = structuredClone(fixtureManifest()) as any;
    coldIncluded.criteria.include_cold_in_primary_ratio = true;
    assert.throws(() => parseManifestJson(JSON.stringify(coldIncluded)));

    const round = buildRound(fixtureManifest(), 1);
    const legacyRound = structuredClone(round) as any;
    legacyRound.header.schema = 'xiaoba.cache_benchmark_round.v4';
    assert.throws(() => parseRoundJsonl(roundToJsonl(legacyRound)));

    const legacyAttempt = structuredClone(round) as any;
    legacyAttempt.attempts[0].schema = 'xiaoba.cache_benchmark_attempt.v4';
    assert.throws(() => parseRoundJsonl(roundToJsonl(legacyAttempt)));

    const legacyLedger = structuredClone(buildLedger(fixtureManifest(), [round])) as any;
    legacyLedger.schema = 'xiaoba.cache_benchmark_ledger.v4';
    assert.throws(() => parseLedgerJson(JSON.stringify(legacyLedger)));
  });

  test('renders warm qualification and cold diagnostics without ambiguity', () => {
    const manifest = fixtureManifest();
    const result = scoreRounds(manifest, [1, 2, 3].map(round => buildRound(manifest, round)));
    const report = renderCacheBenchmarkResult(result, 'text');

    assert.match(report, /qualification_cache_class=warm/);
    assert.match(report, /input_tokens=1000 cache_read_tokens=940/);
    assert.match(report, /cold_input_tokens=1000 cold_cache_read_tokens=940 cold_read_ratio=0\.940000/);
    assert.match(report, /all_input_tokens=2000 all_cache_read_tokens=1880 all_read_ratio=0\.940000/);
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
    setProviderUsage(failingRounds[2].attempts[1], 250, 234);
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

function providerUsageFor(
  source: CacheBenchmarkManifest['cases'][number]['cache_read_source'],
  input: number | undefined,
  read: number | undefined,
  write?: number,
): NonNullable<CacheBenchmarkAttempt['usage']['provider_usage']> {
  switch (source) {
    case 'openai.input_tokens_details.cached_tokens':
      return {
        contract: 'openai-responses-v1',
        ...(input === undefined ? {} : { input_tokens: input }),
        ...(read === undefined ? {} : { cached_tokens: read }),
        ...(write === undefined ? {} : { cache_write_tokens: write }),
      };
    case 'openai.prompt_tokens_details.cached_tokens':
      return {
        contract: 'openai-chat-v1',
        ...(input === undefined ? {} : { prompt_tokens: input }),
        ...(read === undefined ? {} : { cached_tokens: read }),
        ...(write === undefined ? {} : { cache_write_tokens: write }),
      };
    case 'deepseek.prompt_cache_hit_tokens':
      return {
        contract: 'deepseek-chat-v1',
        ...(input === undefined ? {} : { prompt_tokens: input }),
        ...(read === undefined ? {} : { prompt_cache_hit_tokens: read }),
      };
    case 'anthropic.cache_read_input_tokens': {
      const uncached = input === undefined
        ? undefined
        : Math.max(0, input - (read ?? 0) - (write ?? 0));
      return {
        contract: 'anthropic-messages-v1',
        ...(uncached === undefined ? {} : { input_tokens: uncached }),
        ...(read === undefined ? {} : { cache_read_input_tokens: read }),
        ...(write === undefined ? {} : { cache_creation_input_tokens: write }),
      };
    }
  }
}

function setProviderUsage(
  attempt: CacheBenchmarkAttempt,
  input: number | undefined,
  read: number | undefined,
  write?: number,
): void {
  const expectedSource = attempt.metadata.api_type === 'openai-responses'
    ? 'openai.input_tokens_details.cached_tokens'
    : attempt.metadata.provider_adapter === 'anthropic'
      ? 'anthropic.cache_read_input_tokens'
      : attempt.metadata.provider_instance_id === 'provider-local-b'
        ? 'deepseek.prompt_cache_hit_tokens'
        : 'openai.prompt_tokens_details.cached_tokens';
  attempt.usage.provider_usage = providerUsageFor(expectedSource, input, read, write);
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
          schema: 'xiaoba.cache_benchmark_attempt.v5',
          suite_id: manifest.suite_id,
          round,
          attempt_number: attempts.length + 1,
          attempt_role: entry.execution_role,
          logical_call: cacheClass === 'cold' ? 1 : 2,
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
            provider_usage: providerUsageFor(entry.cache_read_source, 250, 235),
          },
          attestation: {
            quality_status: 'passed',
            safety_status: 'passed',
            oracle_contract_fingerprint: entry.oracle_contract_fingerprint,
            execution_plan_fingerprint: entry.execution_plan_fingerprint,
            stable_prefix_fingerprint: fingerprintCanonical({
              provider: entry.provider_instance_id,
              model: entry.model,
              surface: entry.surface,
              case: entry.case_id,
            }),
            request_fingerprint: fingerprintCanonical({
              round,
              case: entry.case_id,
              run: run.run_id,
              cacheClass,
            }),
            observed_capabilities: [...entry.capabilities],
          },
        };
        mutateAttempt?.(attempt);
        attempts.push(attempt);
      }
    }
  }
  return {
    header: {
      schema: 'xiaoba.cache_benchmark_round.v5',
      suite_id: manifest.suite_id,
      round,
      cache_partition_nonce: round.toString(16).padStart(32, '0'),
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
    schema: 'xiaoba.cache_benchmark_ledger.v5',
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
