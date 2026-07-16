/**
 * Issue #91 — Durable multi-provider admission controls and activation lifecycle.
 *
 * Deterministic public-seam tests for:
 *   - Configuration accepts a normalized, deduplicated set of enabled opaque provider IDs.
 *   - Legacy selected-provider setting remains a tested one-item fallback.
 *   - External master switch defaults off and overrides every per-provider setting.
 *   - Durable provider overrides take precedence over environment startup defaults.
 *   - Override state survives restart (persisted to durable file).
 *   - Reset removes the override and restores the environment default.
 *   - Enable/disable/reset/rebaseline operations through public store methods.
 *   - Scope defaults global; narrowing preserves override; expansion baselines new.
 *   - Explicit rebaseline records an operator audit and skips unread events.
 *   - Provider status exposes enabled, source, scope, admission gate, and audit trail.
 *
 * Tests go through public seams only: config function, override store, CLI command.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { getDistillationHeartbeatConfig } from '../src/utils/distillation-heartbeat-config';
import {
  ExternalProviderOverrideStore,
  type ProviderStatus,
  type ExternalProviderOverrideState,
} from '../src/utils/external-provider-controls';
import {
  emptyExternalCursorState,
  loadExternalCursorState,
  resolveExternalCursorStorePath,
  saveExternalCursorState,
} from '../src/utils/session-log-source';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TSX_LOADER = pathToFileURL(require.resolve('tsx')).href;
const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

interface TestEnv {
  readonly root: string;
  readonly overridePath: string;
  readonly savedEnv: Record<string, string | undefined>;
  setup(): void;
  restore(): void;
}

function setupEnv(extraEnv?: Record<string, string | undefined>): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-provider-controls-'));
  tempRoots.push(root);
  const overridePath = path.join(root, 'data', 'external-provider-overrides.json');

  const baseEnv: Record<string, string | undefined> = {
    XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED: process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED,
    XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS: process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS,
    XIAOBA_EXTERNAL_SESSION_LOG_MAX_CONCURRENCY: process.env.XIAOBA_EXTERNAL_SESSION_LOG_MAX_CONCURRENCY,
    XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_PROVIDER: process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_PROVIDER,
    XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_SOURCE_ID: process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_SOURCE_ID,
    XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND: process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND,
    XIAOBA_EXTERNAL_SESSION_LOG_HISTORY_MODE: process.env.XIAOBA_EXTERNAL_SESSION_LOG_HISTORY_MODE,
    XIAOBA_RUNTIME_ROOT: process.env.XIAOBA_RUNTIME_ROOT,
    DISTILLATION_HEARTBEAT_ENABLED: process.env.DISTILLATION_HEARTBEAT_ENABLED,
    DISTILLATION_HEARTBEAT_LOG_ROOT: process.env.DISTILLATION_HEARTBEAT_LOG_ROOT,
  };

  return {
    root,
    overridePath,
    savedEnv: { ...baseEnv, ...extraEnv },
    setup() {
      process.env.XIAOBA_RUNTIME_ROOT = root;
      process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
      process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = 'logs';
      for (const [key, value] of Object.entries(this.savedEnv)) {
        if (value !== undefined && key !== 'XIAOBA_RUNTIME_ROOT' && key !== 'DISTILLATION_HEARTBEAT_ENABLED' && key !== 'DISTILLATION_HEARTBEAT_LOG_ROOT') {
          process.env[key] = value;
        }
      }
    },
    restore() {
      for (const [key, value] of Object.entries(this.savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Config: enabled provider set + legacy fallback
// ---------------------------------------------------------------------------

describe('config enabled provider set', () => {
  let env: TestEnv;
  beforeEach(() => { env = setupEnv(); env.setup(); });
  afterEach(() => env.restore());

  test('accepts a normalized, deduplicated, order-independent set of enabled provider IDs', () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = '  codex , claude, pi ,, codex,  claude ';
    const config = getDistillationHeartbeatConfig(env.root);
    assert.deepEqual(config.externalSessionLogEnabledProviders, ['codex', 'claude', 'pi']);
    assert.equal(config.externalSessionLogMaxConcurrency, 3);
  });

  test('max concurrency is configurable 1-8 with default 3', () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_MAX_CONCURRENCY = '5';
    const config = getDistillationHeartbeatConfig(env.root);
    assert.equal(config.externalSessionLogMaxConcurrency, 5);
  });

  test('max concurrency clamps to 1-8 range', () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_MAX_CONCURRENCY = '0';
    const config = getDistillationHeartbeatConfig(env.root);
    assert.equal(config.externalSessionLogMaxConcurrency, 3);

    process.env.XIAOBA_EXTERNAL_SESSION_LOG_MAX_CONCURRENCY = '99';
    const config2 = getDistillationHeartbeatConfig(env.root);
    assert.equal(config2.externalSessionLogMaxConcurrency, 8);
  });

  test('enabled providers defaults to empty when not set', () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    delete process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS;
    delete process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_PROVIDER;
    const config = getDistillationHeartbeatConfig(env.root);
    assert.deepEqual(config.externalSessionLogEnabledProviders, []);
  });

  test('legacy selected-provider is accepted as one-item fallback when enabled providers is absent', () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    delete process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS;
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_PROVIDER = 'codex';
    const config = getDistillationHeartbeatConfig(env.root);
    assert.deepEqual(config.externalSessionLogEnabledProviders, ['codex']);
    assert.equal(config.externalSessionLogSelectedProvider, 'codex');
  });

  test('enabled providers takes precedence over legacy selected-provider when both are set', () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'claude,pi';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SELECTED_PROVIDER = 'codex';
    const config = getDistillationHeartbeatConfig(env.root);
    assert.deepEqual(config.externalSessionLogEnabledProviders, ['claude', 'pi']);
  });

  test('master switch defaults to false', () => {
    delete process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED;
    const config = getDistillationHeartbeatConfig(env.root);
    assert.equal(config.externalSessionLogSourcesEnabled, false);
  });

  test('history mode accepts catch-up and bounds missing or invalid fallback diagnostics', () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_HISTORY_MODE = 'catch-up';
    assert.equal(getDistillationHeartbeatConfig(env.root).externalSessionLogHistoryMode, 'catch-up');

    delete process.env.XIAOBA_EXTERNAL_SESSION_LOG_HISTORY_MODE;
    const missing = getDistillationHeartbeatConfig(env.root);
    assert.equal(missing.externalSessionLogHistoryMode, 'future-only');
    assert.equal(missing.externalSessionLogHistoryModeDiagnostic, 'External history mode is not configured; using future-only.');

    process.env.XIAOBA_EXTERNAL_SESSION_LOG_HISTORY_MODE = 'an-unbounded-invalid-value-that-must-not-be-echoed';
    const invalid = getDistillationHeartbeatConfig(env.root);
    assert.equal(invalid.externalSessionLogHistoryMode, 'future-only');
    assert.equal(invalid.externalSessionLogHistoryModeDiagnostic, 'External history mode is invalid; using future-only.');
    assert.equal(invalid.externalSessionLogHistoryModeDiagnostic!.includes('an-unbounded'), false);
  });
});

// ---------------------------------------------------------------------------
// Durable override store: precedence, persistence, mutations
// ---------------------------------------------------------------------------

describe('ExternalProviderOverrideStore', () => {
  let env: TestEnv;
  beforeEach(() => { env = setupEnv(); env.setup(); });
  afterEach(() => env.restore());

  function createStore(now: () => Date = () => new Date('2026-01-01T00:00:00.000Z')): ExternalProviderOverrideStore {
    return new ExternalProviderOverrideStore({ stateFilePath: env.overridePath, now });
  }

  test('environment defaults produce the initial enabled set when no overrides exist', () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'codex,claude,pi';
    const config = getDistillationHeartbeatConfig(env.root);
    const store = createStore();
    const enabled = store.resolveEnabledProviders(config);
    assert.deepEqual([...enabled].sort(), ['claude', 'codex', 'pi']);
  });

  test('master switch off overrides every per-provider setting', () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'false';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'codex,claude,pi';
    const config = getDistillationHeartbeatConfig(env.root);
    const store = createStore();
    const enabled = store.resolveEnabledProviders(config);
    assert.deepEqual(enabled, []);
  });

  test('durable enable override adds a provider not in environment defaults', () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'codex';
    const config = getDistillationHeartbeatConfig(env.root);
    const store = createStore();
    store.enableProvider('claude');
    const enabled = store.resolveEnabledProviders(config);
    assert.ok(enabled.includes('codex'));
    assert.ok(enabled.includes('claude'));
    assert.equal(enabled.length, 2);
  });

  test('durable disable override removes a provider from environment defaults', () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'codex,claude,pi';
    const config = getDistillationHeartbeatConfig(env.root);
    const store = createStore();
    store.disableProvider('claude');
    const enabled = store.resolveEnabledProviders(config);
    assert.ok(enabled.includes('codex'));
    assert.ok(enabled.includes('pi'));
    assert.ok(!enabled.includes('claude'));
  });

  test('reset removes the override and restores the environment default', () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'codex,claude,pi';
    const config = getDistillationHeartbeatConfig(env.root);
    const store = createStore();
    store.disableProvider('claude');
    assert.ok(!store.resolveEnabledProviders(config).includes('claude'));
    store.resetProvider('claude');
    assert.ok(store.resolveEnabledProviders(config).includes('claude'));
  });

  test('override state survives restart (persisted to durable file)', () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'codex,claude';
    const config = getDistillationHeartbeatConfig(env.root);
    const store1 = createStore();
    store1.disableProvider('claude');
    store1.enableProvider('pi');

    // Simulate restart: create a new store reading the same file
    const store2 = createStore();
    const enabled = store2.resolveEnabledProviders(config);
    assert.ok(enabled.includes('codex'));
    assert.ok(!enabled.includes('claude'));
    assert.ok(enabled.includes('pi'));
  });

  test('durable history override survives restart and reset restores the environment mode', () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'codex';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_HISTORY_MODE = 'future-only';
    const config = getDistillationHeartbeatConfig(env.root);
    const first = createStore();
    first.setProviderHistoryMode('codex', 'catch-up');
    assert.equal(first.getProviderStatus('codex', config).historyMode, 'catch-up');
    assert.equal(first.getProviderStatus('codex', config).historyModeSource, 'override');

    const restarted = createStore();
    assert.equal(restarted.getProviderStatus('codex', config).historyMode, 'catch-up');
    restarted.resetProvider('codex');
    assert.equal(restarted.getProviderStatus('codex', config).historyMode, 'future-only');
    assert.equal(restarted.getProviderStatus('codex', config).historyModeSource, 'environment');
  });

  test('enable with scope narrow sets scope on the override', () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'codex';
    const config = getDistillationHeartbeatConfig(env.root);
    const store = createStore();
    store.enableProvider('codex', { scope: 'path', scopePath: '/project/a' });
    const status = store.getProviderStatus('codex', config);
    assert.equal(status.scope, 'path');
    assert.equal(status.scopePath, '/project/a');
  });

  test('scope defaults to global when not set', () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'codex';
    const config = getDistillationHeartbeatConfig(env.root);
    const store = createStore();
    const status = store.getProviderStatus('codex', config);
    assert.equal(status.scope, 'global');
  });

  test('explicit rebaseline records an operator audit entry', () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'codex';
    const config = getDistillationHeartbeatConfig(env.root);
    const store = createStore();
    store.rebaselineProvider('codex', true);
    const state = store.load();
    assert.equal(state.rebaselineAudit.length, 1);
    assert.equal(state.rebaselineAudit[0].provider, 'codex');
    assert.equal(state.rebaselineAudit[0].operation, 'rebaseline');
    assert.equal(state.rebaselineAudit[0].skipToNow, true);
  });

  test('rebasing a provider persists the rebaseline request across restart', () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'codex';
    const config = getDistillationHeartbeatConfig(env.root);
    const store1 = createStore();
    store1.rebaselineProvider('codex', true);
    const store2 = createStore();
    const status = store2.getProviderStatus('codex', config);
    assert.ok(status.rebaselineRequestedAt);
    assert.equal(state(store2).rebaselineAudit.length, 1);
  });

  test('getAllProviderStatuses returns all providers from both env and overrides', () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'codex,claude';
    const config = getDistillationHeartbeatConfig(env.root);
    const store = createStore();
    store.enableProvider('pi');
    store.disableProvider('claude');
    const statuses = store.getAllProviderStatuses(config);
    const providers = statuses.map(s => s.provider).sort();
    assert.deepEqual(providers, ['claude', 'codex', 'pi']);
    const codex = statuses.find(s => s.provider === 'codex')!;
    assert.equal(codex.enabled, true);
    assert.equal(codex.source, 'environment');
    const claude = statuses.find(s => s.provider === 'claude')!;
    assert.equal(claude.enabled, false);
    assert.equal(claude.source, 'override');
    const pi = statuses.find(s => s.provider === 'pi')!;
    assert.equal(pi.enabled, true);
    assert.equal(pi.source, 'override');
  });

  test('provider disabled by override shows admission gate closed', () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'codex';
    const config = getDistillationHeartbeatConfig(env.root);
    const store = createStore();
    store.disableProvider('codex');
    const status = store.getProviderStatus('codex', config);
    assert.equal(status.enabled, false);
    assert.equal(status.admissionGate, 'closed');
  });

  test('master switch off marks all providers as disabled with source master-off', () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'false';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'codex,claude';
    const config = getDistillationHeartbeatConfig(env.root);
    const store = createStore();
    const statuses = store.getAllProviderStatuses(config);
    assert.ok(statuses.length >= 2);
    for (const s of statuses) {
      assert.equal(s.enabled, false);
      assert.equal(s.source, 'master-off');
    }
  });
});

// ---------------------------------------------------------------------------
// CLI command surface
// ---------------------------------------------------------------------------

describe('external-source CLI command', () => {
  let env: TestEnv;
  beforeEach(() => { env = setupEnv(); env.setup(); });
  afterEach(() => env.restore());

  test('status --json outputs valid JSON with provider list', async () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'codex,claude';
    const { externalSourceCommand } = await import('../src/commands/external-source');
    const output = await captureOutput(() =>
      externalSourceCommand({
        subcommand: 'status',
        json: true,
        workingDirectory: env.root,
      }),
    );
    const parsed = JSON.parse(output.trim());
    assert.ok(Array.isArray(parsed.providers));
    assert.ok(parsed.providers.length >= 2);
    const providers = parsed.providers.map((p: { provider: string }) => p.provider).sort();
    assert.deepEqual(providers, ['claude', 'codex']);
  });

  test('enable creates a durable override', async () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'codex';
    const { externalSourceCommand } = await import('../src/commands/external-source');
    await externalSourceCommand({
      subcommand: 'enable',
      provider: 'claude',
      workingDirectory: env.root,
    });
    const store = new ExternalProviderOverrideStore({
      stateFilePath: path.join(env.root, 'data', 'external-provider-overrides.json'),
    });
    const config = getDistillationHeartbeatConfig(env.root);
    const enabled = store.resolveEnabledProviders(config);
    assert.ok(enabled.includes('claude'));
  });

  test('enable --history and history switching persist the provider policy', async () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'codex';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_HISTORY_MODE = 'future-only';
    const { externalSourceCommand } = await import('../src/commands/external-source');

    await externalSourceCommand({
      subcommand: 'enable',
      provider: 'codex',
      history: 'catch-up',
      workingDirectory: env.root,
    } as Parameters<typeof externalSourceCommand>[0]);

    const store = new ExternalProviderOverrideStore({
      stateFilePath: path.join(env.root, 'data', 'external-provider-overrides.json'),
    });
    const config = getDistillationHeartbeatConfig(env.root);
    assert.equal(store.getProviderStatus('codex', config).historyMode, 'catch-up');
    const statusOutput = await captureOutput(() => externalSourceCommand({
      subcommand: 'status',
      json: true,
      workingDirectory: env.root,
    }));
    const status = JSON.parse(statusOutput) as { providers: Array<{ provider: string; historyMode: string }> };
    assert.equal(status.providers.find(provider => provider.provider === 'codex')?.historyMode, 'catch-up');

    await externalSourceCommand({
      subcommand: 'history',
      provider: 'codex',
      history: 'future-only',
      workingDirectory: env.root,
    } as Parameters<typeof externalSourceCommand>[0]);

    const restartedStore = new ExternalProviderOverrideStore({
      stateFilePath: path.join(env.root, 'data', 'external-provider-overrides.json'),
    });
    assert.equal(restartedStore.getProviderStatus('codex', config).historyMode, 'future-only');
  });

  test('Commander wiring persists history mode and returns normal process exits', () => {
    const processEnv = {
      ...process.env,
      XIAOBA_RUNTIME_ROOT: env.root,
      DISTILLATION_HEARTBEAT_ENABLED: 'true',
      DISTILLATION_HEARTBEAT_LOG_ROOT: 'logs',
      XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED: 'true',
      XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS: 'codex',
      XIAOBA_EXTERNAL_SESSION_LOG_HISTORY_MODE: 'future-only',
    };
    const valid = spawnSync(process.execPath, [
      '--import',
      TSX_LOADER,
      path.join(PROJECT_ROOT, 'src/index.ts'),
      'external-source',
      'enable',
      'codex',
      '--history',
      'catch-up',
      '--working-directory',
      env.root,
    ], {
      cwd: PROJECT_ROOT,
      env: processEnv,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(valid.signal, null);
    assert.equal(valid.status, 0, valid.stderr);

    const store = new ExternalProviderOverrideStore({ stateFilePath: env.overridePath });
    assert.equal(store.getProviderStatus('codex', getDistillationHeartbeatConfig(env.root)).historyMode, 'catch-up');

    const invalid = spawnSync(process.execPath, [
      '--import',
      TSX_LOADER,
      path.join(PROJECT_ROOT, 'src/index.ts'),
      'external-source',
      'history',
      'codex',
      'invalid-mode',
      '--working-directory',
      env.root,
    ], {
      cwd: PROJECT_ROOT,
      env: processEnv,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(invalid.signal, null);
    assert.equal(invalid.status, 1);
    assert.equal(store.getProviderStatus('codex', getDistillationHeartbeatConfig(env.root)).historyMode, 'catch-up');
  });

  test('disable creates a durable override', async () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'codex,claude';
    const { externalSourceCommand } = await import('../src/commands/external-source');
    await externalSourceCommand({
      subcommand: 'disable',
      provider: 'claude',
      workingDirectory: env.root,
    });
    const store = new ExternalProviderOverrideStore({
      stateFilePath: path.join(env.root, 'data', 'external-provider-overrides.json'),
    });
    const config = getDistillationHeartbeatConfig(env.root);
    assert.ok(!store.resolveEnabledProviders(config).includes('claude'));
  });

  test('reset removes a durable override', async () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'codex,claude';
    const { externalSourceCommand } = await import('../src/commands/external-source');
    await externalSourceCommand({
      subcommand: 'disable',
      provider: 'claude',
      workingDirectory: env.root,
    });
    await externalSourceCommand({
      subcommand: 'reset',
      provider: 'claude',
      workingDirectory: env.root,
    });
    const store = new ExternalProviderOverrideStore({
      stateFilePath: path.join(env.root, 'data', 'external-provider-overrides.json'),
    });
    const config = getDistillationHeartbeatConfig(env.root);
    assert.ok(store.resolveEnabledProviders(config).includes('claude'));
  });

  test('rebaseline --skip-to-now runs the durable recovery lifecycle', async () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'codex';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_HISTORY_MODE = 'future-only';
    const sourceId = 'external-codex';
    const resourceRef = 'thread-cli-rebaseline';
    const cursorPath = resolveExternalCursorStorePath({ provider: 'codex', sourceId });
    const cursorState = emptyExternalCursorState();
    cursorState.sourceIdentities[sourceId] = {
      sourceId,
      label: 'Codex Session Logs',
      category: 'external',
      provider: 'codex',
      reader: 'external',
    };
    cursorState.catchUpTargets[resourceRef] = {
      targetId: 'target-cli-rebaseline',
      provider: 'codex',
      sourceId,
      resourceRef,
      position: 4,
      empty: false,
      prefixDigest: 'a'.repeat(64),
      creationGeneration: 1,
      scopeFingerprint: 'b'.repeat(64),
      observedAt: '2026-07-16T00:00:00.000Z',
    };
    cursorState.catchUpResources[resourceRef] = {
      status: 'historical-pending',
      historicalCursor: { resourceRef, position: 2, processedCount: 1 },
      observedPosition: 4,
      updatedAt: '2026-07-16T00:00:00.000Z',
    };
    saveExternalCursorState(cursorPath, cursorState);

    const { externalSourceCommand } = await import('../src/commands/external-source');
    await externalSourceCommand({
      subcommand: 'rebaseline',
      provider: 'codex',
      skipToNow: true,
      workingDirectory: env.root,
    });
    const store = new ExternalProviderOverrideStore({
      stateFilePath: path.join(env.root, 'data', 'external-provider-overrides.json'),
    });
    const state = store.load();
    assert.equal(state.rebaselineAudit.length, 1);
    assert.equal(state.rebaselineAudit[0].provider, 'codex');

    const recovered = loadExternalCursorState(cursorPath);
    assert.equal(recovered.catchUpResources[resourceRef]?.status, 'abandoned');
    assert.equal(recovered.cursors[resourceRef]?.cursor.position, 4);
    const tombstones = Object.values(recovered.tombstones);
    assert.equal(tombstones.length, 1);
    assert.equal(tombstones[0]?.kind, 'range-abandonment');
    assert.deepEqual(
      tombstones[0]?.kind === 'range-abandonment' ? tombstones[0].range : undefined,
      { startPosition: 3, endPosition: 4 },
    );
  });

  test('status human output contains provider names', async () => {
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
    process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'codex,claude';
    const { externalSourceCommand } = await import('../src/commands/external-source');
    const output = await captureOutput(() =>
      externalSourceCommand({
        subcommand: 'status',
        workingDirectory: env.root,
      }),
    );
    assert.ok(output.includes('codex'));
    assert.ok(output.includes('claude'));
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function state(store: ExternalProviderOverrideStore): ExternalProviderOverrideState {
  return store.load();
}

async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join('');
}
