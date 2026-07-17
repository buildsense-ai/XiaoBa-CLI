import { afterEach, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  getExternalHistoryControlStatus,
  runExternalHistoryBackfillControl,
} from '../src/commands/external-source';
import { getDistillationHeartbeatConfig } from '../src/utils/distillation-heartbeat-config';
import {
  saveExternalSessionLogBackfillState,
  type ExternalSessionLogBackfillState,
} from '../src/utils/session-log-backfill';

const roots: string[] = [];
const savedRuntimeRoot = process.env.XIAOBA_RUNTIME_ROOT;

afterEach(() => {
  if (savedRuntimeRoot === undefined) delete process.env.XIAOBA_RUNTIME_ROOT;
  else process.env.XIAOBA_RUNTIME_ROOT = savedRuntimeRoot;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('status restores aggregate progress and preview resumes the latest operation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-external-history-status-'));
  roots.push(root);
  process.env.XIAOBA_RUNTIME_ROOT = root;

  const config = getDistillationHeartbeatConfig(root);
  const stateRoot = path.join(
    path.dirname(config.learningEpisodeStorePath),
    'external-session-log-backfills',
    'pi',
    'external-pi',
  );
  saveExternalSessionLogBackfillState(
    path.join(stateRoot, 'operation-old.state.json'),
    makeState({
      operationId: 'operation-old',
      updatedAt: '2026-07-17T01:00:00.000Z',
      resourceRefs: ['thread-a', 'thread-b'],
      processedRefs: ['thread-a'],
    }),
  );
  saveExternalSessionLogBackfillState(
    path.join(stateRoot, 'operation-current.state.json'),
    makeState({
      operationId: 'operation-current',
      updatedAt: '2026-07-17T02:00:00.000Z',
      resourceRefs: ['thread-a', 'thread-b', 'thread-c'],
      processedRefs: ['thread-b'],
    }),
  );

  const status = getExternalHistoryControlStatus(root);
  assert.deepEqual(status.imports, [{
    provider: 'pi',
    operationId: 'operation-current',
    status: 'quota_reached',
    selectedCount: 3,
    processedResources: 2,
    pendingResources: 1,
    failedResources: 0,
    resumable: true,
    quotaReached: true,
    updatedAt: '2026-07-17T02:00:00.000Z',
    completedAt: null,
  }]);

  const preview = await runExternalHistoryBackfillControl({
    provider: 'pi',
    updatedSince: '7d',
    preferExistingOperation: true,
    workingDirectory: root,
  });
  assert.equal(preview.mode, 'resume');
  assert.equal(preview.operationId, 'operation-current');
  assert.equal(preview.processedResources, 2);
  assert.equal(preview.selectedCount, 3);
});

function makeState(input: {
  operationId: string;
  updatedAt: string;
  resourceRefs: string[];
  processedRefs: string[];
}): ExternalSessionLogBackfillState {
  return {
    schemaVersion: 1,
    operationId: input.operationId,
    triggeredBy: 'operator:webapp-external-history',
    provider: 'pi',
    sourceId: 'external-pi',
    range: {
      startPosition: 0,
      endPosition: Number.MAX_SAFE_INTEGER,
      resourceRefs: input.resourceRefs,
    },
    status: 'quota_reached',
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: input.updatedAt,
    completedAt: null,
    resourceCursors: {},
    processedEventIds: {},
    resourceStates: Object.fromEntries(input.processedRefs.map(resourceRef => [resourceRef, {
      status: 'processed',
      updatedAt: input.updatedAt,
    }])),
    failures: [],
    metrics: {
      runsStarted: 1,
      resourcesDiscovered: input.resourceRefs.length,
      resourcesProcessed: input.processedRefs.length,
      pendingResources: input.resourceRefs.length - input.processedRefs.length,
      failedResources: 0,
      failedResourceAttempts: 0,
      pendingResourceAttempts: 0,
      ingestedEvents: input.processedRefs.length,
      duplicateEventsSkipped: 0,
      tombstonedEventsSkipped: 0,
      admittedEpisodes: input.processedRefs.length,
      bytesProcessed: 0,
      zeroProgressRuns: 0,
    },
  };
}
