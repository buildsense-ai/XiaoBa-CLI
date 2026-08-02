import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, test } from 'node:test';
import type { ModelAttemptEvent } from '../src/providers/provider';
import { MemoryLogStore } from '../src/core/memory-log-store';
import {
  AttemptCapabilityAttestor,
  BENCHMARK_GOAL_MARKER,
  BENCHMARK_IDENTITY_MARKER,
  BENCHMARK_RECOVERY_MARKER,
  buildBenchmarkPartitionMarker,
  buildOnlineCacheBenchmarkManifest,
  createSealedMemoryFixture,
  evaluateBenchmarkMemoryCompletion,
  CacheBenchmarkEvidenceStore,
  CACHE_BENCHMARK_ATTEMPT_SCHEMA,
  CACHE_BENCHMARK_ROUND_SCHEMA,
  fingerprintConfig,
  fingerprintManifest,
  fingerprintOnlineBenchmarkArtifact,
  loadOnlineProviderCredentials,
  OnlineBenchmarkRunLease,
  OnlineCredentialError,
  REQUIRED_CACHE_BENCHMARK_CAPABILITIES,
  parseManifestJson,
  prepareFreshRuntimeDataDirectory,
  safeOnlineBenchmarkErrorCode,
  StrictAttemptJournal,
} from '../src/cache-benchmark';

const temporaryDirectories: string[] = [];
const require = createRequire(import.meta.url);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('strict credential loader accepts only the private non-shell provider contract', () => {
  const { directory, file } = credentialFixture();
  const providers = loadOnlineProviderCredentials(file);

  assert.deepEqual(providers.map(provider => ({
    alias: provider.alias,
    apiType: provider.apiType,
    cacheReadSource: provider.cacheReadSource,
    model: provider.model,
  })), [
    {
      alias: 'newcli',
      apiType: 'openai-responses',
      cacheReadSource: 'openai.input_tokens_details.cached_tokens',
      model: 'model-newcli',
    },
    {
      alias: 'deepseek',
      apiType: 'openai-chat-completions',
      cacheReadSource: 'openai.prompt_tokens_details.cached_tokens',
      model: 'model-deepseek',
    },
  ]);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test('online manifest counts the production memory branch for every capped task', () => {
  const { file } = credentialFixture();
  const credential = loadOnlineProviderCredentials(file)[0];
  const manifest = buildOnlineCacheBenchmarkManifest(credential, 24);

  assert.equal(manifest.criteria.include_cold_in_primary_ratio, false);
  assert.equal(manifest.cases.length, 8);
  assert.equal(new Set(manifest.cases.map(entry => entry.task_id)).size, 4);
  assert.equal(manifest.cases.filter(entry => entry.execution_role === 'main').length, 4);
  assert.equal(manifest.cases.filter(entry => entry.execution_role === 'memory_branch').length, 4);
  for (const benchmarkCase of manifest.cases) {
    assert.equal(benchmarkCase.runs[0].required_warm_calls, 24);
    if (benchmarkCase.execution_role === 'memory_branch') {
      assert.deepEqual(
        benchmarkCase.capabilities,
        benchmarkCase.task_id === 'unsafe-action-gate' ? ['tools', 'memory'] : ['tools'],
      );
    }
  }
  assert.deepEqual(
    [...new Set(manifest.cases.flatMap(entry => entry.capabilities))].sort(),
    [...REQUIRED_CACHE_BENCHMARK_CAPABILITIES].sort(),
  );
});

test('online provider cells bind a redacted endpoint identity', () => {
  const { file } = credentialFixture();
  const credential = loadOnlineProviderCredentials(file)[0];
  const first = buildOnlineCacheBenchmarkManifest(credential, 2);
  const second = buildOnlineCacheBenchmarkManifest({
    ...credential,
    apiBase: 'https://alternate.example.test/v1',
  }, 2);

  assert.notEqual(first.cases[0].provider_instance_id, second.cases[0].provider_instance_id);
  assert.match(first.cases[0].provider_instance_id, /^newcli:openai-responses:endpoint-[a-f0-9]{32}$/);
  assert.equal(JSON.stringify(first).includes(credential.apiBase), false);
  assert.notEqual(fingerprintManifest(first), fingerprintManifest(second));
});

test('online benchmark gives every case and round an explicit cache-cold partition', () => {
  const nonce = 'a'.repeat(32);
  const first = buildBenchmarkPartitionMarker('newcli-repository-orientation', 1, nonce);
  assert.equal(
    first,
    `[cache_benchmark_partition:v1] newcli-repository-orientation:round-1:nonce-${nonce}`,
  );
  assert.notEqual(first, buildBenchmarkPartitionMarker('newcli-repository-orientation', 2, nonce));
  assert.notEqual(first, buildBenchmarkPartitionMarker('newcli-test-triage', 1, nonce));
  assert.notEqual(first, buildBenchmarkPartitionMarker('newcli-repository-orientation', 1, 'b'.repeat(32)));
  assert.throws(() => buildBenchmarkPartitionMarker('../outside', 1, nonce), /benchmark_partition_case_invalid/);
  assert.throws(() => buildBenchmarkPartitionMarker('valid-case', 0, nonce), /benchmark_partition_round_invalid/);
  assert.throws(() => buildBenchmarkPartitionMarker('valid-case', 1, 'not-a-nonce'), /benchmark_partition_nonce_invalid/);
});

test('online CLI error projection never emits arbitrary error text', () => {
  assert.equal(safeOnlineBenchmarkErrorCode(new Error('SECRET_PROMPT_BODY')), 'online_benchmark_failed');
  assert.equal(safeOnlineBenchmarkErrorCode(new Error('artifact_drift_before_run')), 'artifact_drift_before_run');
});

test('online artifact fingerprint covers executable code, prompts, and dependency metadata', () => {
  const root = makeTemporaryDirectory('cache-artifact-');
  fs.mkdirSync(path.join(root, 'dist'));
  fs.mkdirSync(path.join(root, 'prompts'));
  fs.writeFileSync(path.join(root, 'dist', 'main.js'), 'first');
  fs.writeFileSync(path.join(root, 'prompts', 'system.md'), 'policy');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');

  const first = fingerprintOnlineBenchmarkArtifact(root);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  fs.writeFileSync(path.join(root, 'prompts', 'system.md'), 'changed policy');
  assert.notEqual(fingerprintOnlineBenchmarkArtifact(root), first);

  const link = path.join(root, 'dist', 'linked.js');
  fs.symlinkSync(path.join(root, 'dist', 'main.js'), link);
  assert.throws(() => fingerprintOnlineBenchmarkArtifact(root), /artifact_symlink_invalid/);
});

test('strict credential loader rejects weak modes, unknown keys, and symlinks', () => {
  const weak = credentialFixture();
  if (process.platform !== 'win32') {
    fs.chmodSync(weak.file, 0o644);
    assertCredentialError(() => loadOnlineProviderCredentials(weak.file), 'credential_file_not_private');
  }

  const unknown = credentialFixture('UNEXPECTED_KEY=value\n');
  assertCredentialError(() => loadOnlineProviderCredentials(unknown.file), 'credential_key_unknown');

  const target = credentialFixture();
  const link = path.join(target.directory, 'linked.env');
  fs.symlinkSync(target.file, link);
  assertCredentialError(() => loadOnlineProviderCredentials(link), 'credential_path_invalid');
});

test('credential loader rejects a path replacement during descriptor read', () => {
  const fixture = credentialFixture();
  const nativeFs = require('node:fs') as typeof import('node:fs');
  const readFileSync = nativeFs.readFileSync;
  let replaced = false;
  (nativeFs as any).readFileSync = ((target: any, options?: any) => {
    if (!replaced && typeof target === 'number') {
      replaced = true;
      fs.renameSync(fixture.file, `${fixture.file}.original`);
      fs.writeFileSync(fixture.file, 'UNEXPECTED_KEY=replacement\n', { mode: 0o600 });
    }
    return (readFileSync as any)(target, options);
  }) as typeof fs.readFileSync;
  try {
    assertCredentialError(
      () => loadOnlineProviderCredentials(fixture.file),
      'credential_path_invalid',
    );
    assert.equal(replaced, true);
  } finally {
    (nativeFs as any).readFileSync = readFileSync;
  }
});

test('synchronous attempt journal fsyncs only allowlisted fingerprints and usage', () => {
  const directory = makeTemporaryDirectory('cache-journal-');
  const stateDirectory = path.join(directory, 'state');
  const journal = new StrictAttemptJournal(stateDirectory);
  journal.observe(attemptEvent({ outcome: 'started' }));
  journal.observe(attemptEvent({
    outcome: 'succeeded',
    response: {
      content: 'RESPONSE_SECRET_MUST_NOT_PERSIST',
      usage: {
        promptTokens: 100,
        completionTokens: 2,
        totalTokens: 102,
        inputTokensReported: true,
        cachedReadTokens: 80,
        cacheReadSource: 'deepseek.prompt_cache_hit_tokens',
        providerUsage: {
          contract: 'deepseek-chat-v1',
          prompt_tokens: 100,
          prompt_cache_hit_tokens: 80,
        },
      },
    },
  }));
  journal.close();
  journal.assertHealthy();

  const source = fs.readFileSync(journal.filePath, 'utf8');
  assert.equal(source.includes('PROMPT_SECRET_MUST_NOT_PERSIST'), false);
  assert.equal(source.includes('RESPONSE_SECRET_MUST_NOT_PERSIST'), false);
  const records = source.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(record => record.outcome), ['started', 'succeeded']);
  assert.equal(records[1].cache_read_tokens, 80);
  assert.equal(records[1].cache_read_source, 'deepseek.prompt_cache_hit_tokens');
  assert.deepEqual(records[1].provider_usage, {
    contract: 'deepseek-chat-v1',
    prompt_tokens: 100,
    prompt_cache_hit_tokens: 80,
  });
  assert.match(records[0].request_fingerprint, /^sha256:[a-f0-9]{64}$/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(stateDirectory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(journal.filePath).mode & 0o777, 0o600);
  }
});

test('attempt request fingerprints ignore internal episode IDs but retain cache placement', () => {
  const root = makeTemporaryDirectory('cache-journal-visible-');
  const first = new StrictAttemptJournal(path.join(root, 'first'));
  const second = new StrictAttemptJournal(path.join(root, 'second'));
  const message = (episode: string): any => ({
    role: 'user',
    content: 'same provider-visible request',
    __episodeId: episode,
    __context: {
      schema: 'xiaoba.context_lifecycle.v1',
      source: 'runtime_feedback',
      lifecycle: 'episode',
      cacheScope: 'epoch',
      persistence: 'transient',
      epoch: episode,
    },
  });
  first.observe(attemptEvent({ request: { messages: [message('random-a')], tools: [] } }));
  second.observe(attemptEvent({ request: { messages: [message('random-b')], tools: [] } }));
  first.close();
  second.close();

  assert.equal(first.records[0].request_fingerprint, second.records[0].request_fingerprint);

  const third = new StrictAttemptJournal(path.join(root, 'third'));
  third.observe(attemptEvent({
    request: {
      messages: [message('random-c')],
      tools: [],
      cache: {
        strategy: 'openai-prompt-cache-key',
        stablePrefixEstimatedTokens: 1234,
        stableSystemMessages: 1,
        explicitBreakpoints: 0,
        promptCacheKeyFingerprint: 'different-placement',
      },
    },
  }));
  third.close();
  assert.notEqual(first.records[0].request_fingerprint, third.records[0].request_fingerprint);
});

test('attempt journal preserves dangling started records and refuses a torn tail', () => {
  const directory = makeTemporaryDirectory('cache-journal-resume-');
  const journal = new StrictAttemptJournal(directory);
  journal.observe(attemptEvent({ outcome: 'started' }));
  journal.close();

  const reopened = new StrictAttemptJournal(directory);
  reopened.assertHealthy();
  assert.equal(reopened.records.length, 1);
  assert.equal(reopened.records[0].outcome, 'started');
  reopened.close();

  fs.appendFileSync(journal.filePath, '{"torn":');
  const invalid = new StrictAttemptJournal(directory);
  assert.equal(invalid.failureCode, 'journal_existing_invalid');
});

test('attempt journal rejects path traversal and pre-existing weak files', () => {
  const directory = makeTemporaryDirectory('cache-journal-safety-');
  assert.throws(
    () => new StrictAttemptJournal(directory, '../outside.jsonl'),
    /journal_open_failed/,
  );

  if (process.platform !== 'win32') {
    const file = path.join(directory, 'weak.jsonl');
    fs.writeFileSync(file, '', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    const weak = new StrictAttemptJournal(directory, 'weak.jsonl');
    assert.equal(weak.failureCode, 'journal_existing_invalid');
  }
});

test('capability attestation rejects durable Goal and direct memory marker spoofing', () => {
  const attestor = new AttemptCapabilityAttestor();
  const event = attemptEvent({
    outcome: 'started',
    request: {
      messages: [
        {
          role: 'system',
          content: `${BENCHMARK_IDENTITY_MARKER}\nidentity`,
          __cacheScope: 'stable',
        },
        {
          role: 'user',
          content: `${BENCHMARK_GOAL_MARKER}\nobjective\n${BENCHMARK_RECOVERY_MARKER}\n[发言人: Benchmark Alice]`,
        },
        annotatedMessage('skills_list', 'skills'),
        annotatedMessage('plan_status', 'plan'),
        annotatedMessage('subagent_status', 'subagent'),
        annotatedMessage('runtime_feedback', 'feedback'),
        annotatedMessage('runtime_context', '可操作的用户电脑：\n- Benchmark Alice'),
        {
          role: 'user',
          content: '{"source":"memory"}',
          __runtimeObservation: true,
          runtimeObservationSource: 'memory',
        },
      ],
      tools: [{ name: 'lookup', description: 'lookup', parameters: { type: 'object', properties: {} } }],
    },
  });

  attestor.observe(event);

  assert.deepEqual(attestor.get(event.attemptId), [
    'identity',
    'group-chat-participants',
    'device-authorization',
    'tools',
    'skills',
    'plan',
    'subagent',
    'runtime-feedback',
    'session-recovery',
  ]);
});

test('capability attestation accepts typed Goal and memory only after a linked branch succeeds', () => {
  const attestor = new AttemptCapabilityAttestor();
  const branchStarted = attemptEvent({
    callId: 'branch-call',
    attemptId: 'branch-call:1',
    context: {
      sessionId: 'branch:memory:memory-test',
      episodeId: 'branch-episode',
      surface: 'memory_branch',
    },
  });
  attestor.observe(branchStarted);
  attestor.observe({ ...branchStarted, outcome: 'succeeded' });
  attestor.registerMemoryCompletion({
    branchId: 'memory-test',
    branchType: 'memory',
    status: 'published',
    observationId: 'observation-test',
    observationRefs: ['cache-benchmark/2026-01-01/memory-fixtures.jsonl#1'],
    observationRefDigests: {
      'cache-benchmark/2026-01-01/memory-fixtures.jsonl#1': `sha256:${'a'.repeat(64)}`,
    },
    toolNames: ['memory_search', 'memory_read_turn', 'finish_memory_search'],
  });

  const event = attemptEvent({
    callId: 'main-call',
    attemptId: 'main-call:1',
    request: {
      messages: [
        annotatedMessage('goal_status', 'active goal state'),
        {
          role: 'user',
          content: '{"source":"memory"}',
          __syntheticObservation: true,
          syntheticObservationId: 'observation-test',
          syntheticObservationProvenance: {
            branchType: 'memory',
            branchId: 'memory-test',
          },
          __context: {
            schema: 'xiaoba.context_lifecycle.v1',
            source: 'synthetic_observation',
            lifecycle: 'episode',
            cacheScope: 'epoch',
            persistence: 'transient',
          },
        },
      ],
      tools: [],
    },
  });
  attestor.observe(event);
  assert.deepEqual(attestor.get(event.attemptId), ['goal', 'memory']);
  assert.deepEqual(attestor.get(branchStarted.attemptId), ['tools', 'memory']);
});

test('capability attestation credits a successful suppressed branch without spoofing a main observation', () => {
  const attestor = new AttemptCapabilityAttestor();
  const branch = attemptEvent({
    callId: 'suppressed-branch',
    attemptId: 'suppressed-branch:1',
    context: { sessionId: 'branch:memory:suppressed-memory', surface: 'memory_branch' },
  });
  attestor.observe(branch);
  attestor.observe({ ...branch, outcome: 'succeeded' });
  attestor.registerMemoryCompletion({
    branchId: 'suppressed-memory',
    branchType: 'memory',
    status: 'suppressed',
    toolNames: ['memory_search', 'finish_memory_search'],
  });

  assert.deepEqual(attestor.get(branch.attemptId), ['tools']);

  const main = attemptEvent({
    callId: 'main-without-observation',
    attemptId: 'main-without-observation:1',
    request: { messages: [], tools: [] },
  });
  attestor.observe(main);
  assert.deepEqual(attestor.get(main.attemptId), []);
});

test('capability attestation rejects dangling, failed, and mismatched memory provenance', () => {
  const attestor = new AttemptCapabilityAttestor();
  const branch = attemptEvent({
    callId: 'failed-branch',
    attemptId: 'failed-branch:1',
    context: { sessionId: 'branch:memory:failed-memory', surface: 'memory_branch' },
  });
  attestor.observe(branch);
  attestor.observe({ ...branch, outcome: 'failed' });
  attestor.registerMemoryCompletion({
    branchId: 'failed-memory',
    branchType: 'memory',
    status: 'published',
    observationId: 'other-observation',
    toolNames: ['memory_search', 'finish_memory_search'],
  });
  const main = attemptEvent({
    callId: 'main-dangling',
    attemptId: 'main-dangling:1',
    request: {
      messages: [{
        role: 'tool',
        content: '{"source":"memory"}',
        __syntheticObservation: true,
        syntheticObservationId: 'claimed-observation',
        syntheticObservationProvenance: { branchType: 'memory', branchId: 'failed-memory' },
        __context: {
          schema: 'xiaoba.context_lifecycle.v1',
          source: 'synthetic_observation',
          lifecycle: 'episode',
          cacheScope: 'epoch',
          persistence: 'transient',
        },
      }],
      tools: [],
    },
  });
  attestor.observe(main);
  assert.deepEqual(attestor.get(branch.attemptId), ['tools']);
  assert.deepEqual(attestor.get(main.attemptId), []);
});

test('memory benchmark quality requires published only for the memory-only task', () => {
  const expectedReadFingerprint = `sha256:${'a'.repeat(64)}`;
  const published = {
    branchId: 'memory-published',
    branchType: 'memory',
    status: 'published' as const,
    observationId: 'observation-published',
    observationRefs: ['cache-benchmark/2026-01-01/memory-fixtures.jsonl#1'],
    observationRefDigests: {
      'cache-benchmark/2026-01-01/memory-fixtures.jsonl#1': expectedReadFingerprint,
    },
    toolNames: ['memory_search', 'memory_read_turn', 'finish_memory_search'],
  };
  const suppressed = {
    branchId: 'memory-suppressed',
    branchType: 'memory',
    status: 'suppressed' as const,
    toolNames: ['memory_search', 'finish_memory_search'],
  };

  assert.equal(evaluateBenchmarkMemoryCompletion(published, true, expectedReadFingerprint), true);
  assert.equal(evaluateBenchmarkMemoryCompletion(suppressed, true, expectedReadFingerprint), false);
  assert.equal(evaluateBenchmarkMemoryCompletion(published, false, expectedReadFingerprint), false);
  assert.equal(evaluateBenchmarkMemoryCompletion(suppressed, false, expectedReadFingerprint), true);
  assert.equal(evaluateBenchmarkMemoryCompletion({
    ...published,
    observationRefs: ['cache-benchmark/2026-01-01/memory-fixtures.jsonl#2'],
  }, true, expectedReadFingerprint), false);
});

test('fresh runtime bootstrap is private and cannot reuse an existing session root', () => {
  const parent = makeTemporaryDirectory('cache-runtime-parent-');
  const runtime = path.join(parent, 'fresh-runtime');
  prepareFreshRuntimeDataDirectory(runtime);
  assert.equal(fs.readFileSync(path.join(runtime, '.cache-benchmark-runtime-v1'), 'utf8'), 'synthetic benchmark runtime\n');
  assert.throws(() => prepareFreshRuntimeDataDirectory(runtime), /runtime_data_not_fresh/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(runtime).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(runtime, 'skills')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(runtime, '.cache-benchmark-runtime-v1')).mode & 0o777, 0o600);
  }
});

test('sealed memory fixture reads only its held source and detects in-place restoration', async () => {
  const workspace = makeTemporaryDirectory('sealed-memory-workspace-');
  if (process.platform !== 'win32') fs.chmodSync(workspace, 0o700);
  const source = JSON.stringify({
    entry_type: 'turn',
    turn: 1,
    timestamp: '2026-01-01T00:00:00.000Z',
    session_id: 'sealed:test',
    session_type: 'cache-benchmark',
    user: { text: 'sealed_unique_fact' },
    assistant: { text: 'sealed answer', tool_calls: [] },
    tokens: { prompt: 1, completion: 1 },
  }) + '\n';
  const fixture = createSealedMemoryFixture({
    workspace,
    nonce: 'a'.repeat(32),
    canonicalPath: 'cache-benchmark/2026-01-01/memory-fixtures.jsonl',
    source,
  });
  try {
    const extraDir = path.join(workspace, 'logs', 'sessions', 'chat', '2026-01-01');
    fs.mkdirSync(extraDir, { recursive: true });
    fs.writeFileSync(path.join(extraDir, 'extra.jsonl'), source.replace(/sealed_unique_fact/g, 'extra_unique_fact'));
    const store = new MemoryLogStore(workspace, { sealedSource: fixture });
    assert.equal((await store.search({ keywords: ['sealed_unique_fact'] })).length, 1);
    assert.equal((await store.search({ keywords: ['extra_unique_fact'] })).length, 0);

    if (process.platform !== 'win32') fs.chmodSync(fixture.filePath, 0o600);
    fs.writeFileSync(fixture.filePath, source.replace('sealed answer', 'tampered answer'));
    fs.writeFileSync(fixture.filePath, source);
    if (process.platform !== 'win32') fs.chmodSync(fixture.filePath, 0o400);
    assert.throws(() => fixture.assertUntampered(), /benchmark_memory_fixture_tampered/);
  } finally {
    fixture.close();
  }
});

test('sealed memory fixture detects atomic path replacement', () => {
  const workspace = makeTemporaryDirectory('sealed-memory-replace-');
  if (process.platform !== 'win32') fs.chmodSync(workspace, 0o700);
  const source = '{"entry_type":"turn"}\n';
  const fixture = createSealedMemoryFixture({
    workspace,
    nonce: 'b'.repeat(32),
    canonicalPath: 'cache-benchmark/2026-01-01/memory-fixtures.jsonl',
    source,
  });
  try {
    const displaced = `${fixture.filePath}.old`;
    fs.renameSync(fixture.filePath, displaced);
    fs.writeFileSync(fixture.filePath, source, { mode: 0o400 });
    assert.throws(() => fixture.assertUntampered(), /benchmark_memory_fixture_tampered/);
  } finally {
    fixture.close();
  }
});

test('online run lease serializes writers and makes an interrupted round permanent', () => {
  const directory = path.join(makeTemporaryDirectory('cache-run-lease-parent-'), 'suite');
  const leaseInput = {
    directory,
    suiteId: 'suite-a',
    round: 1,
    artifactFingerprint: `sha256:${'a'.repeat(64)}`,
    manifestFingerprint: `sha256:${'b'.repeat(64)}`,
    configFingerprint: `sha256:${'c'.repeat(64)}`,
    cachePartitionNonce: 'd'.repeat(32),
  };
  const first = new OnlineBenchmarkRunLease(leaseInput);
  const started = fs.readFileSync(first.runPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.equal(started[0].cache_partition_nonce, leaseInput.cachePartitionNonce);
  assert.throws(() => new OnlineBenchmarkRunLease(leaseInput), /EEXIST|online_round_already_reserved/);
  first.close();
  assert.throws(() => new OnlineBenchmarkRunLease({ ...leaseInput, round: 2 }), /online_incomplete_round_exists/);

  const completedDirectory = path.join(makeTemporaryDirectory('cache-run-sealed-parent-'), 'suite');
  const completed = new OnlineBenchmarkRunLease({ ...leaseInput, directory: completedDirectory });
  completed.complete(`sha256:${'d'.repeat(64)}`);
  const second = new OnlineBenchmarkRunLease({ ...leaseInput, directory: completedDirectory, round: 2 });
  second.complete(`sha256:${'e'.repeat(64)}`);
  assert.equal(fs.existsSync(path.join(completedDirectory, '.online-run.lock')), false);
});

test('online run lease surfaces lock release failures', () => {
  const directory = path.join(makeTemporaryDirectory('cache-run-lock-fault-parent-'), 'suite');
  const lease = new OnlineBenchmarkRunLease({
    directory,
    suiteId: 'suite-a',
    round: 1,
    artifactFingerprint: `sha256:${'a'.repeat(64)}`,
    manifestFingerprint: `sha256:${'b'.repeat(64)}`,
    configFingerprint: `sha256:${'c'.repeat(64)}`,
    cachePartitionNonce: 'd'.repeat(32),
  });
  const lock = path.join(directory, '.online-run.lock');
  fs.unlinkSync(lock);
  fs.mkdirSync(lock);

  assert.throws(() => lease.close(), /online_lock_release_failed/);
});

test('evidence store seals a round before advancing its private contiguous ledger', () => {
  const directory = makeTemporaryDirectory('cache-evidence-store-');
  const manifest = parseManifestJson(fs.readFileSync(
    path.join(process.cwd(), 'tests/fixtures/cache-benchmark/manifest.json'),
    'utf8',
  ));
  const benchmarkCase = manifest.cases[0];
  const run = benchmarkCase.runs[0];
  const manifestFingerprint = fingerprintManifest(manifest);
  const evidence = {
    header: {
      schema: CACHE_BENCHMARK_ROUND_SCHEMA,
      suite_id: manifest.suite_id,
      round: 1,
      cache_partition_nonce: 'a'.repeat(32),
      artifact_fingerprint: `sha256:${'a'.repeat(64)}`,
      manifest_fingerprint: manifestFingerprint,
      config_fingerprint: fingerprintConfig(manifest),
    },
    attempts: [{
      schema: CACHE_BENCHMARK_ATTEMPT_SCHEMA,
      suite_id: manifest.suite_id,
      round: 1,
      attempt_number: 1,
      attempt_role: benchmarkCase.execution_role,
      logical_call: 1,
      case_id: benchmarkCase.case_id,
      run_id: run.run_id,
      call_id: 'call-1',
      attempt_id: 'call-1:1',
      metadata: {
        provider_instance_id: benchmarkCase.provider_instance_id,
        provider_adapter: benchmarkCase.provider_adapter,
        model: benchmarkCase.model,
        api_type: benchmarkCase.api_type,
        surface: benchmarkCase.surface,
        task_id: benchmarkCase.task_id,
        task_fixture_fingerprint: benchmarkCase.task_fixture_fingerprint,
        scenario_family: benchmarkCase.scenario_family,
        session_type: benchmarkCase.session_type,
      },
      cache_class: 'cold' as const,
      outcome: 'succeeded' as const,
      usage: {
        provider_usage: {
          contract: 'openai-responses-v1' as const,
          input_tokens: 100,
          cached_tokens: 0,
        },
      },
      attestation: {
        quality_status: 'passed' as const,
        safety_status: 'passed' as const,
        oracle_contract_fingerprint: benchmarkCase.oracle_contract_fingerprint,
        execution_plan_fingerprint: benchmarkCase.execution_plan_fingerprint,
        stable_prefix_fingerprint: `sha256:${'b'.repeat(64)}`,
        request_fingerprint: `sha256:${'c'.repeat(64)}`,
        observed_capabilities: [...benchmarkCase.capabilities],
      },
    }],
  };
  const store = new CacheBenchmarkEvidenceStore(directory);
  const sealed = store.sealRound(manifest, evidence);

  assert.equal(fs.existsSync(sealed.evidencePath), true);
  const ledger = JSON.parse(fs.readFileSync(sealed.ledgerPath, 'utf8'));
  assert.equal(ledger.latest_round, 1);
  assert.equal(ledger.rounds[0].evidence_fingerprint, sealed.evidenceFingerprint);
  assert.equal(store.sealRound(manifest, evidence).evidenceFingerprint, sealed.evidenceFingerprint);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(sealed.evidencePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(sealed.ledgerPath).mode & 0o777, 0o600);
  }
});

function attemptEvent(overrides: Partial<ModelAttemptEvent>): ModelAttemptEvent {
  return {
    schema: 'xiaoba.model_attempt.v1',
    callId: 'call-1',
    attemptId: 'call-1:1',
    attemptNumber: 1,
    timestamp: '2026-08-02T01:02:03.000Z',
    outcome: 'started',
    provider: 'openai',
    model: 'model-deepseek',
    apiType: 'openai-chat-completions',
    stream: false,
    context: {
      sessionId: 'private-session-id',
      episodeId: 'private-episode-id',
      surface: 'catscompany',
    },
    request: {
      messages: [
        { role: 'system', content: 'stable policy', __cacheScope: 'stable' },
        { role: 'user', content: 'PROMPT_SECRET_MUST_NOT_PERSIST' },
      ],
      tools: [{ name: 'lookup', description: 'lookup', parameters: { type: 'object', properties: {} } }],
    },
    ...overrides,
  };
}

function annotatedMessage(source: any, content: string): any {
  return {
    role: 'system',
    content,
    __context: {
      schema: 'xiaoba.context_lifecycle.v1',
      source,
      lifecycle: 'episode',
      cacheScope: 'epoch',
      persistence: 'transient',
    },
  };
}

function credentialFixture(extra = ''): { directory: string; file: string } {
  const directory = makeTemporaryDirectory('cache-credentials-');
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, 'providers.env');
  fs.writeFileSync(file, [
    'XIAOBA_BENCH_NEWCLI_API_KEY=test-newcli-key',
    'XIAOBA_BENCH_NEWCLI_BASE_URL=https://newcli.example.test/v1',
    'XIAOBA_BENCH_NEWCLI_MODEL=model-newcli',
    'XIAOBA_BENCH_DEEPSEEK_API_KEY=test-deepseek-key',
    'XIAOBA_BENCH_DEEPSEEK_BASE_URL=https://deepseek.example.test/v1',
    'XIAOBA_BENCH_DEEPSEEK_MODEL=model-deepseek',
    extra.trimEnd(),
  ].filter(Boolean).join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { directory, file };
}

function assertCredentialError(operation: () => unknown, code: string): void {
  assert.throws(operation, (error: unknown) => (
    error instanceof OnlineCredentialError && error.code === code
  ));
}

function makeTemporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
