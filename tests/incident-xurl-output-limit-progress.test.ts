/**
 * Incident regression: external-history import bounded-buffer mitigation,
 * structured errors, exact progress, and crash-replay safety.
 *
 * XiaoBa-side coverage (this file):
 * - Real fake-xurl child process: valid rendered output >256 KiB and <4 MiB
 *   succeeds through XurlExternalBackfillSource.read; >4 MiB fails with
 *   XurlOutputLimitError (real ERR_CHILD_PROCESS_STDIO_MAXBUFFER/ENOBUFS path).
 * - Both overflow error codes map structurally (never by English message).
 * - source.read overflow -> durable source_failed -> structured control/Device
 *   RPC error mapping (real child process + real backfill service + mapping).
 * - Progress carries exact durable counts and nullable-total semantics:
 *   discovering (total=null), importing (determinate total), complete, failed.
 * - Quota remaining and source-failure remaining are true, not zeroed.
 * - Crash after durable admission before cursor ack replays without duplicate
 *   episodes (idempotent admission seam), and progress increments only after
 *   durable replay acknowledgement.
 * - total=0 (stable empty catalog) stays determinate 0.
 *
 * Web/Go/bot-sdk coverage lives in the cats-company repository:
 * - webapp/src/api.test.js: structured oversized (resumable:false) and
 *   external_history_source_failed errors; total=0 not clamped; total=null.
 * - webapp/src/widgets/catsco-download-modal.test.jsx: modal indeterminate
 *   state when a running provider reports total=null (discovering copy);
 *   oversized-not-resumable and generic source-failure copy.
 * - server/device_rpc_test.go: Go total:null preserved, negative/zero/processed
 *   validation.
 * - bot-sdk: nullable total and total=0 progress transport.
 */

import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  XURL_TEST_HELPERS,
  XurlOutputLimitError,
  isXurlOutputLimitError,
  XURL_OUTPUT_LIMIT_CODE,
  DEFAULT_XURL_MAX_READ_OUTPUT_BYTES,
  DEFAULT_XURL_MAX_OUTPUT_BYTES,
  XurlExternalBackfillSource,
} from '../src/utils/xurl-session-log-source';
import { mapExternalBackfillReportToDeviceRpcError } from '../src/commands/external-source';
import { writeFakeXurlScript } from './helpers/fake-xurl-child-process';

const tempRoots: string[] = [];
const fakeScripts: ReturnType<typeof writeFakeXurlScript>[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  for (const script of fakeScripts.splice(0)) {
    script.cleanup();
  }
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function eventIdentity(eventId: string, position = 0, contentHash = 'h1') {
  return {
    eventId,
    position,
    conversationId: 'c1',
    branchId: 'b1',
    contentHash,
  };
}

function makeResource(resourceRef: string, position = 0) {
  return {
    resourceRef,
    firstEventIdentity: {
      eventId: `agents://codex/${resourceRef}#${position}-${position}`,
      position,
      conversationId: resourceRef,
      branchId: resourceRef,
      contentHash: '0'.repeat(64),
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Structured error: XurlOutputLimitError + isXurlOutputLimitError
// ---------------------------------------------------------------------------

describe('structured overflow error', () => {
  test('XurlOutputLimitError carries stable code, command kind, and limitBytes', () => {
    const err = new XurlOutputLimitError('read', 4 * 1024 * 1024);
    assert.equal(err.code, XURL_OUTPUT_LIMIT_CODE);
    assert.equal(err.code, 'xurl_output_limit');
    assert.equal(err.commandKind, 'read');
    assert.equal(err.limitBytes, 4 * 1024 * 1024);
    assert.equal(err.name, 'XurlOutputLimitError');
    assert.match(err.message, /read.*4194304|read.*exceeded/i);
  });

  test('isXurlOutputLimitError detects both instance and structural duck-type', () => {
    const err = new XurlOutputLimitError('query', 256 * 1024);
    assert.ok(isXurlOutputLimitError(err));
    assert.ok(isXurlOutputLimitError({ code: XURL_OUTPUT_LIMIT_CODE, name: 'XurlOutputLimitError' }));
    assert.ok(!isXurlOutputLimitError(new Error('output exceeded')));
    assert.ok(!isXurlOutputLimitError(null));
    assert.ok(!isXurlOutputLimitError({ code: 'ENOBUFS' }));
  });

  test('mapXurlProcessError maps ENOBUFS to XurlOutputLimitError', () => {
    const mapped = XURL_TEST_HELPERS.mapXurlProcessError(
      'read',
      { code: 'ENOBUFS', stderr: '', message: 'spawn ENOBUFS' },
      10_000,
      4 * 1024 * 1024,
    );
    assert.ok(isXurlOutputLimitError(mapped), 'ENOBUFS must map to XurlOutputLimitError');
    if (isXurlOutputLimitError(mapped)) {
      assert.equal(mapped.commandKind, 'read');
      assert.equal(mapped.limitBytes, 4 * 1024 * 1024);
    }
  });

  test('mapXurlProcessError maps ERR_CHILD_PROCESS_STDIO_MAXBUFFER to XurlOutputLimitError', () => {
    const mapped = XURL_TEST_HELPERS.mapXurlProcessError(
      'read',
      { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stderr: '', message: 'maxBuffer exceeded' },
      10_000,
      4 * 1024 * 1024,
    );
    assert.ok(isXurlOutputLimitError(mapped), 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER must map to XurlOutputLimitError');
    if (isXurlOutputLimitError(mapped)) {
      assert.equal(mapped.commandKind, 'read');
      assert.equal(mapped.limitBytes, 4 * 1024 * 1024);
    }
  });

  test('mapXurlProcessError does not match overflow by English message text', () => {
    const mapped = XURL_TEST_HELPERS.mapXurlProcessError(
      'query',
      { code: 1, stderr: 'xurl query output exceeded 256 KiB', message: 'exited' },
      10_000,
      256 * 1024,
    );
    assert.ok(!isXurlOutputLimitError(mapped), 'English-message-only must not map to XurlOutputLimitError');
    assert.match(mapped.message, /status 1/i);
  });

  test('DEFAULT_XURL_MAX_OUTPUT_BYTES stays at 256 KiB for query/head', () => {
    assert.equal(DEFAULT_XURL_MAX_OUTPUT_BYTES, 256 * 1024);
  });

  test('DEFAULT_XURL_MAX_READ_OUTPUT_BYTES is an independent 4 MiB hard limit', () => {
    assert.equal(DEFAULT_XURL_MAX_READ_OUTPUT_BYTES, 4 * 1024 * 1024);
    assert.notEqual(DEFAULT_XURL_MAX_READ_OUTPUT_BYTES, DEFAULT_XURL_MAX_OUTPUT_BYTES);
  });
});

// ---------------------------------------------------------------------------
// 2. Real fake-xurl child process: 256 KiB / 4 MiB read boundaries
// ---------------------------------------------------------------------------

describe('real fake-xurl child-process read boundaries', () => {
  test('valid rendered output >256 KiB and <4 MiB succeeds through XurlExternalBackfillSource.read', async () => {
    const fake = writeFakeXurlScript();
    fakeScripts.push(fake);
    // 300 KiB of User content: above the 256 KiB query/head limit, below the
    // 4 MiB read limit and the 512 KiB parser ceiling.
    fake.setReadBytes(300 * 1024);

    const source = new XurlExternalBackfillSource({
      command: fake.command,
      provider: 'codex',
      sourceId: 'external-codex',
      sourceLabel: 'Codex Session Logs',
      env: fake.env,
      checkVersion: true,
    });
    source.restrictToResourceRefs(['thread-001']);

    const result = source.read(
      makeResource('thread-001'),
      { resourceRef: 'thread-001', position: -1, processedCount: 0 },
    );
    assert.ok(result.events.length > 0, 'read above 256 KiB must succeed under the 4 MiB read limit');
    assert.equal(result.status, 'stable');
  });

  test('read output >4 MiB fails with XurlOutputLimitError via real maxBuffer overflow', async () => {
    const fake = writeFakeXurlScript();
    fakeScripts.push(fake);
    // Just over the 4 MiB read hard limit.
    fake.setReadBytes(4 * 1024 * 1024 + 1024);

    const source = new XurlExternalBackfillSource({
      command: fake.command,
      provider: 'codex',
      sourceId: 'external-codex',
      sourceLabel: 'Codex Session Logs',
      env: fake.env,
      checkVersion: true,
    });
    source.restrictToResourceRefs(['thread-001']);

    assert.throws(
      () => source.read(
        makeResource('thread-001'),
        { resourceRef: 'thread-001', position: -1, processedCount: 0 },
      ),
      (error: unknown) => isXurlOutputLimitError(error),
      'read above 4 MiB must throw XurlOutputLimitError',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. source.read overflow -> durable source_failed -> structured Device RPC error
// ---------------------------------------------------------------------------

describe('source.read overflow -> durable source_failed -> Device RPC error', () => {
  test('real read overflow produces durable source_failed with xurl_output_limit code', async () => {
    const { ExternalSessionLogBackfillService } = await import('../src/utils/session-log-backfill');
    const fake = writeFakeXurlScript();
    fakeScripts.push(fake);
    fake.setReadBytes(4 * 1024 * 1024 + 1024);

    const root = tempDir('overflow-backfill-');
    const stateFilePath = path.join(root, 'state.json');
    const auditFilePath = path.join(root, 'audit.jsonl');

    const source = new XurlExternalBackfillSource({
      command: fake.command,
      provider: 'codex',
      sourceId: 'external-codex',
      sourceLabel: 'Codex Session Logs',
      env: fake.env,
      checkVersion: true,
    });
    source.restrictToResourceRefs(['thread-001']);

    const service = new ExternalSessionLogBackfillService({
      stateFilePath,
      auditFilePath,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });

    const result = await service.run(
      {
        operationId: 'op-overflow',
        triggeredBy: 'operator:test',
        provider: 'codex',
        sourceId: 'external-codex',
        range: { startPosition: 0, endPosition: Number.MAX_SAFE_INTEGER, resourceRefs: ['thread-001'] },
        limits: { maxResources: 10, maxBytes: 1024 * 1024 * 1024, maxElapsedMs: 60_000 },
      },
      source,
      () => ({ admittedEpisodeIds: ['ep-1'] }),
    );

    assert.equal(result.status, 'source_failed', 'read overflow must end in source_failed');
    assert.equal(result.failureCode, 'xurl_output_limit', 'durable failure code preserved');
    assert.ok(result.failureDetails, 'durable failure details preserved');
    assert.equal((result.failureDetails as Record<string, unknown>).commandKind, 'read');
    assert.equal((result.failureDetails as Record<string, unknown>).limitBytes, 4 * 1024 * 1024);

    // Durable state preserves the structured failure code on the resource.
    const durable = JSON.parse(fs.readFileSync(stateFilePath, 'utf8')) as {
      resourceStates?: Record<string, { failureCode?: string; status?: string }>;
      failures?: Array<{ code?: string }>;
    };
    assert.equal(durable.resourceStates?.['thread-001']?.status, 'failed');
    assert.equal(durable.resourceStates?.['thread-001']?.failureCode, 'xurl_output_limit');
    assert.equal(durable.failures?.[durable.failures.length - 1]?.code, 'xurl_output_limit');

    // End-to-end: the durable source_failed report maps to the structured
    // Device RPC error (external_history_record_too_large, resumable:false),
    // proving the real read-overflow path reaches the structured control error.
    const report = {
      status: result.status,
      failureCode: result.failureCode,
      failureDetails: result.failureDetails,
    };
    const deviceError = mapExternalBackfillReportToDeviceRpcError(report, 'codex')!;
    assert.equal(deviceError.errorCode, 'external_history_record_too_large');
    assert.equal(deviceError.details.resumable, false);
  });

  test('mapExternalBackfillReportToDeviceRpcError maps xurl_output_limit to external_history_record_too_large (resumable:false)', () => {
    const error = mapExternalBackfillReportToDeviceRpcError(
      {
        status: 'source_failed',
        failureCode: 'xurl_output_limit',
        failureDetails: { limitBytes: 4 * 1024 * 1024, commandKind: 'read' },
      },
      'codex',
    )!;
    assert.equal(error.ok, false);
    assert.equal(error.errorCode, 'external_history_record_too_large');
    assert.equal(error.details.resumable, false, 'oversized record is not resumable');
    assert.equal(error.details.limitBytes, 4 * 1024 * 1024);
    assert.equal(error.details.commandKind, 'read');
    assert.match(error.message, /目前无法导入/);
  });

  test('mapExternalBackfillReportToDeviceRpcError maps generic source_failed to external_history_source_failed', () => {
    const error = mapExternalBackfillReportToDeviceRpcError(
      { status: 'source_failed' },
      'pi',
    )!;
    assert.equal(error.ok, false);
    assert.equal(error.errorCode, 'external_history_source_failed');
    assert.equal(error.retryable, true);
    assert.equal(error.details.provider, 'pi');
  });

  test('a newer generic failure is not misclassified by an older structured failure', async () => {
    const { ExternalSessionLogBackfillService } = await import('../src/utils/session-log-backfill');
    const root = tempDir('latest-failure-');
    const stateFilePath = path.join(root, 'state.json');
    const auditFilePath = path.join(root, 'audit.jsonl');
    let attempt = 0;
    const source = {
      identity: {
        sourceId: 'test-source', label: 'Test', category: 'external' as const,
        provider: 'codex', reader: 'xurl' as const,
      },
      discoverResources: () => [makeResource('r1', 0)],
      read: () => {
        attempt += 1;
        if (attempt === 1) throw new XurlOutputLimitError('read', 4 * 1024 * 1024);
        throw new Error('new generic source failure');
      },
    };
    const request = {
      operationId: 'op-latest-failure', triggeredBy: 'operator:test',
      provider: 'codex', sourceId: 'test-source',
      range: { startPosition: 0, endPosition: 1, resourceRefs: ['r1'] },
      limits: { maxResources: 10, maxBytes: 1024 * 1024, maxElapsedMs: 60_000 },
    };
    const service = new ExternalSessionLogBackfillService({
      stateFilePath, auditFilePath, now: () => new Date('2026-01-01T00:00:00Z'),
    });

    const first = service.run(request, source as never, () => ({ admittedEpisodeIds: [] }));
    assert.equal(first.failureCode, 'xurl_output_limit');

    const second = service.run(request, source as never, () => ({ admittedEpisodeIds: [] }));
    assert.equal(second.status, 'source_failed');
    assert.equal(second.failureCode, undefined, 'only the latest failure may classify the current result');
    const mapped = mapExternalBackfillReportToDeviceRpcError({ status: second.status }, 'codex')!;
    assert.equal(mapped.errorCode, 'external_history_source_failed');
  });

  test('mapExternalBackfillReportToDeviceRpcError returns undefined for non-failure reports', () => {
    assert.equal(
      mapExternalBackfillReportToDeviceRpcError({ status: 'completed' }, 'codex'),
      undefined,
    );
    assert.equal(
      mapExternalBackfillReportToDeviceRpcError({ status: 'quota_reached' }, 'codex'),
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Progress: exact durable counts, nullable-total semantics, terminal truth
// ---------------------------------------------------------------------------

describe('progress semantics', () => {
  test('emits discovering with total=null after durable running state, before importing', async () => {
    const { ExternalSessionLogBackfillService } = await import('../src/utils/session-log-backfill');
    const root = tempDir('progress-discover-');
    const stateFilePath = path.join(root, 'state.json');
    const auditFilePath = path.join(root, 'audit.jsonl');

    const progressCalls: Array<{ phase: string; total: number | null; processed: number }> = [];
    const service = new ExternalSessionLogBackfillService({
      stateFilePath,
      auditFilePath,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });

    const source = {
      identity: {
        sourceId: 'test-source', label: 'Test', category: 'external' as const,
        provider: 'codex', reader: 'xurl' as const,
      },
      discoverResources: () => [makeResource('r1', 0)],
      read: () => ({
        events: [{
          identity: eventIdentity('e1', 0),
          distillationUnit: {} as never,
          byteLength: 100,
        }],
        status: 'stable' as const,
        exhausted: true,
        newCursor: { resourceRef: 'r1', position: 0, processedCount: 1 },
      }),
    };

    await service.run(
      {
        operationId: 'op-discover', triggeredBy: 'operator:test', provider: 'codex', sourceId: 'test-source',
        range: { startPosition: 0, endPosition: 1, resourceRefs: ['r1'] },
        limits: { maxResources: 10, maxBytes: 1024 * 1024, maxElapsedMs: 60_000 },
      },
      source as never,
      () => ({ admittedEpisodeIds: ['ep-1'] }),
      {
        onProgress: (p: { phase: string; total: number | null; processed: number }) => {
          progressCalls.push({ phase: p.phase, total: p.total, processed: p.processed });
        },
      },
    );

    const discovering = progressCalls.find(p => p.phase === 'discovering');
    assert.ok(discovering, 'discovering phase must be emitted');
    assert.equal(discovering!.total, null, 'discovering total must be null (indeterminate)');
    const importing = progressCalls.find(p => p.phase === 'importing');
    assert.ok(importing, 'importing phase must be emitted');
    assert.equal(importing!.total, 1, 'importing total is determinate (explicit resourceRefs count)');
    // discovering must precede importing.
    assert.ok(progressCalls.indexOf(discovering!) < progressCalls.indexOf(importing!));
  });

  test('run stays synchronous and total=0 remains determinate', async () => {
    const { ExternalSessionLogBackfillService } = await import('../src/utils/session-log-backfill');
    const root = tempDir('progress-zero-');
    const stateFilePath = path.join(root, 'state.json');
    const auditFilePath = path.join(root, 'audit.jsonl');

    const progressCalls: Array<{ phase: string; total: number | null; processed: number; remaining: number | null }> = [];
    const service = new ExternalSessionLogBackfillService({
      stateFilePath,
      auditFilePath,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });

    const source = {
      identity: {
        sourceId: 'test-source', label: 'Test', category: 'external' as const,
        provider: 'codex', reader: 'xurl' as const,
      },
      discoverResources: () => [],
      read: () => ({ events: [], status: 'stable' as const, exhausted: true, newCursor: { resourceRef: 'r1', position: 0, processedCount: 0 } }),
    };

    const result = service.run(
      {
        operationId: 'op-zero', triggeredBy: 'operator:test', provider: 'codex', sourceId: 'test-source',
        range: { startPosition: 0, endPosition: 1, resourceRefs: [] },
        limits: { maxResources: 10, maxBytes: 1024 * 1024, maxElapsedMs: 60_000 },
      },
      source as never,
      () => ({ admittedEpisodeIds: [] }),
      {
        onProgress: (p: { phase: string; total: number | null; processed: number; remaining: number | null }) => {
          progressCalls.push({ phase: p.phase, total: p.total, processed: p.processed, remaining: p.remaining });
        },
      },
    );

    assert.equal(typeof (result as { then?: unknown }).then, 'undefined', 'run must preserve its synchronous API');
    assert.equal(result.status, 'completed');
    const complete = progressCalls.find(p => p.phase === 'complete');
    assert.ok(complete, 'complete phase emitted');
    assert.equal(complete!.total, 0, 'empty catalog total stays 0');
    assert.equal(complete!.processed, 0);
    assert.equal(complete!.remaining, 0);
  });

  test('quota_reached keeps importing phase with true remaining, not zeroed', async () => {
    const { ExternalSessionLogBackfillService } = await import('../src/utils/session-log-backfill');
    const root = tempDir('progress-quota-');
    const stateFilePath = path.join(root, 'state.json');
    const auditFilePath = path.join(root, 'audit.jsonl');

    const progressCalls: Array<{ phase: string; total: number | null; processed: number; remaining: number | null }> = [];
    const service = new ExternalSessionLogBackfillService({
      stateFilePath,
      auditFilePath,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });

    const source = {
      identity: {
        sourceId: 'test-source', label: 'Test', category: 'external' as const,
        provider: 'codex', reader: 'xurl' as const,
      },
      discoverResources: () => [makeResource('r1', 0), makeResource('r2', 1)],
      read: () => ({
        events: [{
          identity: eventIdentity('e1', 0),
          distillationUnit: {} as never,
          byteLength: 100,
        }],
        status: 'stable' as const,
        exhausted: true,
        newCursor: { resourceRef: 'r1', position: 0, processedCount: 1 },
      }),
    };

    const result = await service.run(
      {
        operationId: 'op-quota', triggeredBy: 'operator:test', provider: 'codex', sourceId: 'test-source',
        range: { startPosition: 0, endPosition: 2, resourceRefs: ['r1', 'r2'] },
        limits: { maxResources: 1, maxBytes: 1024 * 1024, maxElapsedMs: 60_000 },
      },
      source as never,
      () => ({ admittedEpisodeIds: ['ep-1'] }),
      {
        onProgress: (p: { phase: string; total: number | null; processed: number; remaining: number | null }) => {
          progressCalls.push({ phase: p.phase, total: p.total, processed: p.processed, remaining: p.remaining });
        },
      },
    );

    assert.equal(result.status, 'quota_reached');
    // Terminal progress must be importing (paused/resumable) with true remaining.
    const terminal = progressCalls[progressCalls.length - 1]!;
    assert.equal(terminal.phase, 'importing', 'quota_reached terminal phase is importing (paused)');
    assert.equal(terminal.total, 2);
    assert.equal(terminal.processed, 1);
    assert.equal(terminal.remaining, 1, 'true remaining, not zeroed');
  });

  test('source_failed keeps failed phase with true remaining', async () => {
    const { ExternalSessionLogBackfillService } = await import('../src/utils/session-log-backfill');
    const root = tempDir('progress-failed-');
    const stateFilePath = path.join(root, 'state.json');
    const auditFilePath = path.join(root, 'audit.jsonl');

    const progressCalls: Array<{ phase: string; total: number | null; processed: number; failed: number; remaining: number | null }> = [];
    const service = new ExternalSessionLogBackfillService({
      stateFilePath,
      auditFilePath,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });

    let readFails = false;
    const source = {
      identity: {
        sourceId: 'test-source', label: 'Test', category: 'external' as const,
        provider: 'codex', reader: 'xurl' as const,
      },
      discoverResources: () => [makeResource('r1', 0), makeResource('r2', 1)],
      read: () => {
        if (readFails) throw new Error('source read failed');
        readFails = true;
        // Return an event missing its verified DistillationUnit so the backfill
        // service records a stable event-level failure and breaks the resource
        // loop; r2 is never reached and remains unprocessed (true remaining).
        return {
          events: [{
            identity: eventIdentity('e1', 0),
            distillationUnit: null as unknown,
            byteLength: 100,
          }],
          status: 'stable' as const,
          exhausted: true,
          newCursor: { resourceRef: 'r1', position: 0, processedCount: 1 },
        };
      },
    };

    const result = await service.run(
      {
        operationId: 'op-failed', triggeredBy: 'operator:test', provider: 'codex', sourceId: 'test-source',
        range: { startPosition: 0, endPosition: 2, resourceRefs: ['r1', 'r2'] },
        limits: { maxResources: 10, maxBytes: 1024 * 1024, maxElapsedMs: 60_000 },
      },
      source as never,
      () => ({ admittedEpisodeIds: ['ep-1'] }),
      {
        onProgress: (p: { phase: string; total: number | null; processed: number; failed: number; remaining: number | null }) => {
          progressCalls.push({ phase: p.phase, total: p.total, processed: p.processed, failed: p.failed, remaining: p.remaining });
        },
      },
    );

    assert.equal(result.status, 'source_failed');
    const terminal = progressCalls[progressCalls.length - 1]!;
    assert.equal(terminal.phase, 'failed', 'source_failed terminal phase is failed');
    assert.equal(terminal.total, 2);
    assert.equal(terminal.failed, 1);
    assert.equal(terminal.remaining, 1, 'true remaining, not zeroed');
  });

  test('processed counts durable processed resources only; remaining reconciles with total', async () => {
    const { ExternalSessionLogBackfillService } = await import('../src/utils/session-log-backfill');
    const root = tempDir('progress-reconcile-');
    const stateFilePath = path.join(root, 'state.json');
    const auditFilePath = path.join(root, 'audit.jsonl');

    const progressCalls: Array<{ phase: string; processed: number; total: number | null; remaining: number | null }> = [];
    const service = new ExternalSessionLogBackfillService({
      stateFilePath,
      auditFilePath,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });

    const source = {
      identity: {
        sourceId: 'test-source', label: 'Test', category: 'external' as const,
        provider: 'codex', reader: 'xurl' as const,
      },
      discoverResources: () => [makeResource('r1', 0), makeResource('r2', 1)],
      read: (_r: unknown, cursor: { resourceRef: string }) => ({
        events: [{
          identity: eventIdentity(`e-${cursor.resourceRef}`, cursor.resourceRef === 'r1' ? 0 : 1),
          distillationUnit: {} as never,
          byteLength: 100,
        }],
        status: 'stable' as const,
        exhausted: true,
        newCursor: { resourceRef: cursor.resourceRef, position: cursor.resourceRef === 'r1' ? 0 : 1, processedCount: 1 },
      }),
    };

    const result = await service.run(
      {
        operationId: 'op-reconcile', triggeredBy: 'operator:test', provider: 'codex', sourceId: 'test-source',
        range: { startPosition: 0, endPosition: 2, resourceRefs: ['r1', 'r2'] },
        limits: { maxResources: 10, maxBytes: 1024 * 1024, maxElapsedMs: 60_000 },
      },
      source as never,
      () => ({ admittedEpisodeIds: ['ep-1'] }),
      {
        onProgress: (p: { phase: string; processed: number; total: number | null; remaining: number | null }) => {
          progressCalls.push({ phase: p.phase, processed: p.processed, total: p.total, remaining: p.remaining });
        },
      },
    );

    assert.equal(result.status, 'completed');
    const complete = progressCalls.find(p => p.phase === 'complete')!;
    assert.equal(complete.processed, 2);
    assert.equal(complete.total, 2);
    assert.equal(complete.remaining, 0, 'completed reconciles remaining to 0');
  });
});

// ---------------------------------------------------------------------------
// 5. Crash after durable admission before cursor ack: safe replay
// ---------------------------------------------------------------------------

describe('crash-replay durability', () => {
  test('crash after durable admission before cursor ack replays without duplicate episodes', async () => {
    const { ExternalSessionLogBackfillService } = await import('../src/utils/session-log-backfill');
    const root = tempDir('crash-replay-');
    const stateFilePath = path.join(root, 'state.json');
    const auditFilePath = path.join(root, 'audit.jsonl');

    // Durable admission store simulating the external admission coordinator +
    // episode store. It survives the simulated crash (state file deletion),
    // representing the durable Episode/Capsule/provenance committed before the
    // backfill cursor acknowledgement was lost.
    //
    // Test seam: the real RuntimeLearning.executeExternalBackfill routes
    // ingestion through externalAdmissionCoordinator.admitPages, which commits
    // the Episode/Capsule durably before the backfill service saves its cursor.
    // Admitting the same event identity twice is idempotent (no duplicate
    // Episode/Capsule/provenance). This fake ingestor encodes that idempotent
    // contract directly so the backfill-service durability invariant is
    // testable without booting the full RuntimeLearning/AIService stack.
    const admittedEventKeys = new Set<string>();
    const provenance: string[] = [];
    let ingestCalls = 0;
    const ingest = (_unit: unknown, context: { provider: string; sourceId: string; eventIdentity: { eventId: string; contentHash: string } }) => {
      ingestCalls += 1;
      const key = `${context.provider}:${context.sourceId}:${context.eventIdentity.eventId}:${context.eventIdentity.contentHash}`;
      if (admittedEventKeys.has(key)) {
        // Idempotent admission: Episode/Capsule already committed durably.
        return { admittedEpisodeIds: [] };
      }
      admittedEventKeys.add(key);
      provenance.push(key);
      return { admittedEpisodeIds: ['ep-1'] };
    };

    const source = {
      identity: {
        sourceId: 'test-source', label: 'Test', category: 'external' as const,
        provider: 'codex', reader: 'xurl' as const,
      },
      discoverResources: () => [makeResource('r1', 0)],
      read: () => ({
        events: [{
          identity: eventIdentity('e1', 0, 'h1'),
          distillationUnit: {} as never,
          byteLength: 100,
        }],
        status: 'stable' as const,
        exhausted: true,
        newCursor: { resourceRef: 'r1', position: 0, processedCount: 1 },
      }),
    };

    const request = {
      operationId: 'op-crash-replay',
      triggeredBy: 'operator:test',
      provider: 'codex',
      sourceId: 'test-source',
      range: { startPosition: 0, endPosition: 1, resourceRefs: ['r1'] },
      limits: { maxResources: 10, maxBytes: 1024 * 1024, maxElapsedMs: 60_000 },
    };

    // First run: admits event durably, saves cursor ack.
    const service1 = new ExternalSessionLogBackfillService({
      stateFilePath, auditFilePath, now: () => new Date('2026-01-01T00:00:00Z'),
    });
    const first = await service1.run(request, source as never, ingest);
    assert.equal(first.status, 'completed');
    assert.equal(admittedEventKeys.size, 1, 'one Episode admitted durably');

    // Simulate crash: durable admission survived, but backfill cursor/state lost.
    fs.unlinkSync(stateFilePath);

    // Replay: re-reads event, ingestor dedups (idempotent), no new episode.
    const progressAfterAck: number[] = [];
    const service2 = new ExternalSessionLogBackfillService({
      stateFilePath, auditFilePath, now: () => new Date('2026-01-01T00:01:00Z'),
    });
    const second = await service2.run(request, source as never, ingest, {
      onProgress: (p: { phase: string; processed: number }) => {
        if (p.phase === 'importing' && p.processed === 1) {
          // Progress increments only after durable replay acknowledgement:
          // the state file must already record the resource as processed.
          const durable = JSON.parse(fs.readFileSync(stateFilePath, 'utf8')) as {
            resourceStates?: Record<string, { status?: string }>;
          };
          assert.equal(durable.resourceStates?.r1?.status, 'processed',
            'progress must fire only after durable cursor/resource acknowledgement');
          progressAfterAck.push(p.processed);
        }
      },
    });

    assert.equal(second.status, 'completed');
    // One Episode, one Capsule, no duplicate provenance.
    assert.equal(admittedEventKeys.size, 1, 'no duplicate Episode admission on replay');
    assert.equal(provenance.length, 1, 'provenance recorded once, no duplicate');
    assert.equal(ingestCalls, 2, 'ingest called twice; second is an idempotent no-op');
    assert.equal(second.admittedEpisodes, 0, 'replay admits no new episodes');
    assert.ok(progressAfterAck.length > 0, 'progress incremented after durable replay acknowledgement');
  });

  test('completed resources do not re-import on resume', async () => {
    const { ExternalSessionLogBackfillService } = await import('../src/utils/session-log-backfill');
    const root = tempDir('skip-completed-');
    const stateFilePath = path.join(root, 'state.json');
    const auditFilePath = path.join(root, 'audit.jsonl');

    let readCount = 0;
    let ingestCount = 0;
    const ingestor = () => {
      ingestCount += 1;
      return { admittedEpisodeIds: [`ep-${ingestCount}`] };
    };

    const resourceEvents: Record<string, { identity: ReturnType<typeof eventIdentity>; distillationUnit: unknown; byteLength: number }> = {
      r1: { identity: eventIdentity('e1', 0, 'h1'), distillationUnit: {}, byteLength: 100 },
      r2: { identity: eventIdentity('e2', 1, 'h2'), distillationUnit: {}, byteLength: 100 },
    };

    const source = {
      identity: {
        sourceId: 'test-source', label: 'Test', category: 'external' as const,
        provider: 'codex', reader: 'xurl' as const,
      },
      discoverResources: () => [makeResource('r1', 0), makeResource('r2', 1)],
      read: (_resource: unknown, cursor: { resourceRef: string; position: number }) => {
        readCount += 1;
        const ref = cursor.resourceRef;
        const event = resourceEvents[ref];
        const allEvents = cursor.position < 0 ? [event] : [];
        return {
          events: allEvents,
          status: 'stable' as const,
          exhausted: true,
          newCursor: { resourceRef: ref, position: event?.identity.position ?? 0, processedCount: allEvents.length },
        };
      },
    };

    const request = {
      operationId: 'op-skip-completed',
      triggeredBy: 'operator:test',
      provider: 'codex',
      sourceId: 'test-source',
      range: { startPosition: 0, endPosition: 2, resourceRefs: ['r1', 'r2'] },
      limits: { maxResources: 10, maxBytes: 1024 * 1024, maxElapsedMs: 60_000 },
    };

    const service1 = new ExternalSessionLogBackfillService({
      stateFilePath, auditFilePath, now: () => new Date('2026-01-01T00:00:00Z'),
    });
    const first = await service1.run(request, source as never, ingestor);
    assert.equal(first.status, 'completed');
    assert.equal(first.processedResources, 2);
    assert.equal(readCount, 2);
    assert.equal(ingestCount, 2);

    const service2 = new ExternalSessionLogBackfillService({
      stateFilePath, auditFilePath, now: () => new Date('2026-01-01T00:01:00Z'),
    });
    const ingestBefore = ingestCount;
    const second = await service2.run(request, source as never, ingestor);
    assert.equal(second.status, 'completed');
    assert.equal(second.processedResources, 0, 'no new resources processed (no false progress)');
    assert.equal(ingestCount, ingestBefore, 'completed resources not re-imported');
  });
});
