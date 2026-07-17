/**
 * Public CLI seam for explicit external-source backfill.
 *
 * Safe by default (dry-run). Execute path goes through RuntimeLearning +
 * XurlExternalBackfillSource with owner-lock and provider-lock discipline.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { acquireHeartbeatSchedulerOwnerLock } from '../src/utils/heartbeat-scheduler-owner-lock';
import { getDistillationHeartbeatConfig } from '../src/utils/distillation-heartbeat-config';
import {
  writeFakeXurl,
  writeScenario,
  type FakeXurlScenario,
} from './helpers/xurl-rendered-fixtures';

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
  readonly commandPath: string;
  readonly scenarioPath: string;
  readonly logPath: string;
  readonly savedEnv: Record<string, string | undefined>;
  setup(): void;
  restore(): void;
}

function setupEnv(): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-backfill-cli-'));
  tempRoots.push(root);
  const commandPath = path.join(root, 'fake-xurl.js');
  const scenarioPath = path.join(root, 'scenario.json');
  const logPath = path.join(root, 'invocations.jsonl');
  writeFakeXurl(commandPath);

  const keys = [
    'XIAOBA_RUNTIME_ROOT',
    'DISTILLATION_HEARTBEAT_ENABLED',
    'DISTILLATION_HEARTBEAT_LOG_ROOT',
    'XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED',
    'XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS',
    'XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND',
    'XIAOBA_EXTERNAL_SESSION_LOG_HISTORY_MODE',
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};
  for (const key of keys) savedEnv[key] = process.env[key];

  return {
    root,
    commandPath,
    scenarioPath,
    logPath,
    savedEnv,
    setup() {
      process.env.XIAOBA_RUNTIME_ROOT = root;
      process.env.DISTILLATION_HEARTBEAT_ENABLED = 'true';
      process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = 'logs';
      process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'true';
      process.env.XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS = 'codex';
      process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND = commandPath;
      process.env.XIAOBA_EXTERNAL_SESSION_LOG_HISTORY_MODE = 'future-only';
      process.env.XURL_SCENARIO_PATH = scenarioPath;
      process.env.XURL_LOG_PATH = logPath;
    },
    restore() {
      for (const [key, value] of Object.entries(this.savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      delete process.env.XURL_SCENARIO_PATH;
      delete process.env.XURL_LOG_PATH;
    },
  };
}

describe('external-source backfill CLI', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setupEnv();
    env.setup();
    writeScenario(env.scenarioPath, successCatalogScenario());
  });
  afterEach(() => env.restore());

  test('webapp control persists provider selection and keeps routine history future-only', async () => {
    const {
      configureExternalHistoryProviders,
      getExternalHistoryControlStatus,
      runExternalHistoryBackfillControl,
    } = await import('../src/commands/external-source');

    const configured = configureExternalHistoryProviders(['pi', 'codex'], env.root);
    assert.equal(configured.restartRequired, true);
    assert.deepEqual(
      configured.providers.filter(item => item.enabled).map(item => item.provider).sort(),
      ['codex', 'pi'],
    );
    assert.equal(configured.providers.every(item => item.historyMode === 'future-only'), true);
    assert.match(fs.readFileSync(path.join(env.root, '.env'), 'utf8'), /XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS="codex,pi"/);

    const status = getExternalHistoryControlStatus(env.root);
    assert.equal(status.heartbeatEnabled, true);
    assert.equal(status.sourcesEnabled, true);
    assert.equal(status.xurlConfigured, true);

    let stdout = '';
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      const preview = await runExternalHistoryBackfillControl({
        provider: 'codex',
        updatedSince: '7d',
        workingDirectory: env.root,
      });
      assert.equal(preview.mode, 'dry-run');
      assert.equal(preview.provider, 'codex');
      assert.equal(typeof preview.operationId, 'string');
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.equal(stdout, '');
  });

  test('dry-run is the default and reports selection metadata without transcript text', async () => {
    const { externalSourceCommand } = await import('../src/commands/external-source');
    const secretPath = path.join(env.root, 'private-project');
    const config = getDistillationHeartbeatConfig(env.root);
    const backfillRoot = path.join(
      path.dirname(config.learningEpisodeStorePath),
      'external-session-log-backfills',
    );
    const ownerLockRoot = path.join(env.root, '.xiaoba', 'heartbeat-scheduler-owner');
    const output = await captureOutput(() => externalSourceCommand({
      subcommand: 'backfill',
      provider: 'codex',
      updatedSince: '7d',
      scope: 'path',
      scopePath: secretPath,
      json: true,
      workingDirectory: env.root,
      now: () => new Date('2026-07-16T00:00:00.000Z'),
    }));

    const parsed = JSON.parse(output.trim()) as {
      mode: string;
      provider: string;
      cutoff: string;
      selectedCount: number;
      excludedMissingUpdatedAt: number;
      excludedInvalidUpdatedAt: number;
      excludedBeforeCutoff: number;
      operationId: string;
      scope: string;
      scopePath?: string;
      limits: {
        maxResources: number;
        maxEvents: number;
        maxBytes: number;
        maxElapsedMs: number;
      };
      resourceRefs?: string[];
    };

    assert.equal(parsed.mode, 'dry-run');
    assert.equal(parsed.provider, 'codex');
    assert.equal(parsed.cutoff, '2026-07-09T00:00:00.000Z');
    assert.equal(parsed.selectedCount, 2);
    assert.equal(parsed.excludedMissingUpdatedAt, 1);
    assert.equal(parsed.excludedInvalidUpdatedAt, 1);
    assert.equal(parsed.excludedBeforeCutoff, 1);
    assert.ok(parsed.operationId.length > 0);
    assert.equal(parsed.scope, 'path');
    assert.equal(parsed.scopePath, undefined);
    assert.equal(output.includes(secretPath), false);
    assert.equal(output.includes('Please generate'), false);
    assert.equal(output.includes('Done.'), false);
    assert.ok(parsed.limits.maxResources > 0);
    assert.ok(parsed.limits.maxEvents > 0);
    assert.ok(parsed.limits.maxBytes > 0);
    assert.ok(parsed.limits.maxElapsedMs > 0);
    assert.equal(fs.existsSync(backfillRoot), false);
    assert.equal(fs.existsSync(config.learningEpisodeStorePath), false);
    assert.equal(fs.existsSync(ownerLockRoot), false);
  });

  test('rejects invalid and future updated-since values', async () => {
    const { externalSourceCommand } = await import('../src/commands/external-source');

    await assert.rejects(
      () => externalSourceCommand({
        subcommand: 'backfill',
        provider: 'codex',
        updatedSince: 'not-a-duration',
        workingDirectory: env.root,
        now: () => new Date('2026-07-16T00:00:00.000Z'),
      }),
      /updated-since/i,
    );

    await assert.rejects(
      () => externalSourceCommand({
        subcommand: 'backfill',
        provider: 'codex',
        updatedSince: '2026-07-20T00:00:00.000Z',
        workingDirectory: env.root,
        now: () => new Date('2026-07-16T00:00:00.000Z'),
      }),
      /future/i,
    );
  });

  test('deterministic operation id preserves selected resource set for resume', async () => {
    const { externalSourceCommand } = await import('../src/commands/external-source');
    const first = JSON.parse(await captureOutput(() => externalSourceCommand({
      subcommand: 'backfill',
      provider: 'codex',
      updatedSince: '7d',
      json: true,
      workingDirectory: env.root,
      now: () => new Date('2026-07-16T00:00:00.000Z'),
    })));
    const second = JSON.parse(await captureOutput(() => externalSourceCommand({
      subcommand: 'backfill',
      provider: 'codex',
      updatedSince: '7d',
      json: true,
      workingDirectory: env.root,
      now: () => new Date('2026-07-16T00:00:00.000Z'),
    })));
    assert.equal(first.operationId, second.operationId);

    const explicit = JSON.parse(await captureOutput(() => externalSourceCommand({
      subcommand: 'backfill',
      provider: 'codex',
      updatedSince: '7d',
      operationId: 'op-resume-1',
      json: true,
      workingDirectory: env.root,
      now: () => new Date('2026-07-16T00:00:00.000Z'),
    })));
    assert.equal(explicit.operationId, 'op-resume-1');
  });

  test('execute refuses when xURL command is missing', async () => {
    delete process.env.XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND;
    const { externalSourceCommand } = await import('../src/commands/external-source');
    await assert.rejects(
      () => externalSourceCommand({
        subcommand: 'backfill',
        provider: 'codex',
        updatedSince: '7d',
        execute: true,
        workingDirectory: env.root,
        now: () => new Date('2026-07-16T00:00:00.000Z'),
      }),
      /xurl/i,
    );
  });

  test('execute refuses when writable Runtime owner cannot be acquired', async () => {
    const owner = acquireHeartbeatSchedulerOwnerLock({
      runtimeRoot: env.root,
      command: 'dashboard-owner',
    });
    assert.equal(owner.acquired, true);
    try {
      const { externalSourceCommand } = await import('../src/commands/external-source');
      await assert.rejects(
        () => externalSourceCommand({
          subcommand: 'backfill',
          provider: 'codex',
          updatedSince: '7d',
          execute: true,
          workingDirectory: env.root,
          now: () => new Date('2026-07-16T00:00:00.000Z'),
        }),
        /writable Runtime|owner/i,
      );
    } finally {
      if (owner.acquired) owner.release();
    }
  });

  test('execute admits complete stable history for selected threads', async () => {
    writeScenario(env.scenarioPath, executeScenario());
    const { externalSourceCommand } = await import('../src/commands/external-source');
    const output = await captureOutput(() => externalSourceCommand({
      subcommand: 'backfill',
      provider: 'codex',
      updatedSince: '7d',
      execute: true,
      json: true,
      maxResources: 10,
      maxEvents: 100,
      maxBytes: 1024 * 1024,
      maxElapsedMs: 60_000,
      workingDirectory: env.root,
      now: () => new Date('2026-07-16T00:00:00.000Z'),
    }));
    const parsed = JSON.parse(output.trim()) as {
      mode: string;
      status: string;
      selectedCount: number;
      processedResources: number;
      resumable: boolean;
      quotaReached: boolean;
    };
    assert.equal(parsed.mode, 'execute');
    assert.equal(parsed.status, 'completed');
    assert.equal(parsed.selectedCount, 1);
    assert.equal(parsed.processedResources, 1);
    assert.equal(parsed.resumable, false);
    assert.equal(parsed.quotaReached, false);
  });

  test('Commander wiring accepts backfill dry-run and rejects missing updated-since', () => {
    const processEnv = {
      ...process.env,
      XIAOBA_RUNTIME_ROOT: env.root,
      DISTILLATION_HEARTBEAT_ENABLED: 'true',
      DISTILLATION_HEARTBEAT_LOG_ROOT: 'logs',
      XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED: 'true',
      XIAOBA_EXTERNAL_SESSION_LOG_ENABLED_PROVIDERS: 'codex',
      XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND: env.commandPath,
      XURL_SCENARIO_PATH: env.scenarioPath,
      XURL_LOG_PATH: env.logPath,
    };
    const dryRun = spawnSync(process.execPath, [
      '--import',
      TSX_LOADER,
      path.join(PROJECT_ROOT, 'src/index.ts'),
      'external-source',
      'backfill',
      'codex',
      '--updated-since',
      '7d',
      '--json',
      '--working-directory',
      env.root,
    ], {
      cwd: PROJECT_ROOT,
      env: processEnv,
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(dryRun.signal, null);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const jsonStart = dryRun.stdout.indexOf('{');
    assert.ok(jsonStart >= 0, `expected JSON in stdout, got: ${dryRun.stdout.slice(0, 200)}`);
    const parsed = JSON.parse(dryRun.stdout.slice(jsonStart));
    assert.equal(parsed.mode, 'dry-run');
    assert.equal(parsed.selectedCount, 2);

    const missing = spawnSync(process.execPath, [
      '--import',
      TSX_LOADER,
      path.join(PROJECT_ROOT, 'src/index.ts'),
      'external-source',
      'backfill',
      'codex',
      '--working-directory',
      env.root,
    ], {
      cwd: PROJECT_ROOT,
      env: processEnv,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(missing.signal, null);
    assert.notEqual(missing.status, 0);
  });
});

function successCatalogScenario(): FakeXurlScenario {
  return {
    discover: {
      catalog: {
        provider: 'codex',
        next: null,
        threads: [
          thread('recent-a', '2026-07-15T12:00:00.000Z'),
          thread('recent-b', '2026-07-14T00:00:00.000Z'),
          thread('old', '2026-06-01T00:00:00.000Z'),
          thread('missing-updated'),
          thread('invalid-updated', 'not-a-date'),
        ],
      },
    },
  };
}

function executeScenario(): FakeXurlScenario {
  return {
    discover: {
      catalog: {
        provider: 'codex',
        next: null,
        threads: [
          {
            threadId: 'conversation-recent',
            branch: 'branch-main',
            ordinal: 2,
            fingerprint: 'fp-recent-2',
            revision: '2026-07-15T12:00:00.000Z',
          },
        ],
      },
    },
    read: {
      'conversation-recent': {
        timeline: {
          provider: 'codex',
          threadId: 'conversation-recent',
          branch: 'branch-main',
          ordinal: 2,
          fingerprint: 'fp-recent-2',
          revision: 'rev-recent',
          entries: [
            { ordinal: 1, role: 'User', content: 'Please generate and send the report.' },
            { ordinal: 2, role: 'Assistant', content: 'Done.' },
          ],
        },
      },
    },
  };
}

function thread(threadId: string, revision?: string) {
  return {
    threadId,
    branch: threadId,
    ordinal: 0,
    fingerprint: `fp-${threadId}`,
    ...(revision ? { revision } : {}),
  };
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
