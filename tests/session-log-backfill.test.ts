/**
 * Issue #79 — explicit bounded external Session Log Backfill.
 *
 * Focused coverage for the standalone backfill service so the implementation
 * remains disjoint from the active #77/#78 lanes.
 */

import { afterEach, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DistillationUnit, extractDistillationUnit } from '../src/utils/distillation-unit';
import { EvidenceIngestor } from '../src/utils/evidence-ingestor';
import { LearningEpisodeStore } from '../src/utils/learning-episode';
import { SessionTurnLogEntry } from '../src/utils/session-log-schema';
import {
  ExternalSessionLogBackfillRequest,
  ExternalSessionLogBackfillReadResult,
  ExternalSessionLogBackfillService,
  ExternalSessionLogBackfillSource,
  loadExternalSessionLogBackfillState,
} from '../src/utils/session-log-backfill';
import {
  SessionLogSourceIdentity,
  SessionLogSourceResource,
  SourceCursor,
} from '../src/utils/session-log-source';

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

interface TestEnv {
  readonly root: string;
  readonly stateFilePath: string;
  readonly auditFilePath: string;
  readonly episodeStore: LearningEpisodeStore;
  readonly evidenceIngestor: EvidenceIngestor;
}

interface FixtureBackfillItem {
  readonly resourceRef: string;
  readonly position: number;
  readonly unit: DistillationUnit | null;
  readonly contentHash?: string;
  readonly failMessage?: string;
  readonly ignoreCursor?: boolean;
}

class FixtureBackfillSource implements ExternalSessionLogBackfillSource {
  readonly identity: SessionLogSourceIdentity;
  private readonly resources: readonly SessionLogSourceResource[];
  private readonly itemsByRef: Map<string, FixtureBackfillItem>;

  constructor(
    items: readonly FixtureBackfillItem[],
    options: {
      sourceId?: string;
      provider?: string;
      label?: string;
    } = {},
  ) {
    const provider = options.provider ?? 'fixture-provider';
    const sourceId = options.sourceId ?? 'fixture-external-source';
    this.identity = {
      sourceId,
      label: options.label ?? 'Fixture External Backfill Source',
      category: 'external',
      provider,
      reader: 'fixture-backfill',
    };
    this.resources = items.map(item => ({
      resourceRef: item.resourceRef,
      firstEventIdentity: {
        eventId: `${sourceId}:${item.resourceRef}:${item.position}`,
        position: item.position,
        contentHash: item.contentHash,
      },
    }));
    this.itemsByRef = new Map(items.map(item => [item.resourceRef, item]));
  }

  discoverResources(): readonly SessionLogSourceResource[] {
    return this.resources;
  }

  read(resource: SessionLogSourceResource, cursor: SourceCursor): ExternalSessionLogBackfillReadResult {
    const item = this.itemsByRef.get(resource.resourceRef);
    if (!item) {
      return {
        events: [],
        status: 'stable',
        exhausted: true,
        newCursor: cursor,
      };
    }
    if (item.failMessage) {
      throw new Error(item.failMessage);
    }
    const position = resource.firstEventIdentity?.position ?? item.position;
    if (!item.ignoreCursor && cursor.position >= position + 1) {
      return {
        events: [],
        status: 'stable',
        exhausted: true,
        newCursor: cursor,
      };
    }
    if (!item.unit) {
      return {
        events: [],
        status: 'pending',
        exhausted: false,
        newCursor: cursor,
      };
    }
    const byteLength = Buffer.byteLength(JSON.stringify(item.unit), 'utf8');
    return {
      events: [{
        identity: resource.firstEventIdentity!,
        distillationUnit: item.unit,
        byteLength,
      }],
      status: 'stable',
      exhausted: true,
      newCursor: {
        resourceRef: resource.resourceRef,
        position: position + 1,
        processedCount: cursor.processedCount + 1,
      },
    };
  }
}

test('backfill is opt-in and creates state only when explicitly triggered', () => {
  const env = makeEnv();
  const unit = buildUnit(env.root, 'conversation-0', 'session-0');
  const source = new FixtureBackfillSource([
    { resourceRef: 'conversation-0', position: 0, unit, contentHash: 'hash-0' },
  ]);
  const service = new ExternalSessionLogBackfillService({
    stateFilePath: env.stateFilePath,
    auditFilePath: env.auditFilePath,
    now: sequentialClock(),
  });

  assert.equal(countEpisodes(env.episodeStore), 0);
  assert.equal(fs.existsSync(env.stateFilePath), false);
  assert.equal(fs.existsSync(env.auditFilePath), false);

  const result = service.run(
    makeRequest({ resourceRefs: ['conversation-0'], endPosition: 0 }),
    source,
    unitToEpisodeIngestor(env.evidenceIngestor),
  );

  assert.equal(result.status, 'completed');
  assert.equal(countEpisodes(env.episodeStore), 1);
  assert.equal(fs.existsSync(env.stateFilePath), true);
  assert.equal(fs.existsSync(env.auditFilePath), true);
});

test('backfill requires explicit source selection plus bounded range and caps', () => {
  const env = makeEnv();
  const items = [0, 1, 2, 3].map(index => ({
    resourceRef: `conversation-${index}`,
    position: index,
    unit: buildUnit(env.root, `conversation-${index}`, `session-${index}`),
    contentHash: `hash-${index}`,
  }));
  const source = new FixtureBackfillSource(items);
  const service = new ExternalSessionLogBackfillService({
    stateFilePath: env.stateFilePath,
    auditFilePath: env.auditFilePath,
    now: sequentialClock(),
  });

  const result = service.run(
    makeRequest({
      resourceRefs: ['conversation-1', 'conversation-2', 'conversation-3'],
      startPosition: 1,
      endPosition: 3,
      maxResources: 2,
    }),
    source,
    unitToEpisodeIngestor(env.evidenceIngestor),
  );

  assert.equal(result.status, 'quota_reached');
  assert.equal(result.discoveredResources, 3);
  assert.equal(result.processedResources, 2);
  assert.equal(countEpisodes(env.episodeStore), 2);

  const state = loadExternalSessionLogBackfillState(env.stateFilePath)!;
  assert.deepEqual(
    Object.keys(state.processedEventIds).sort(),
    [
      'fixture-provider::fixture-external-source::fixture-external-source:conversation-1:1::1::hash-1::::::',
      'fixture-provider::fixture-external-source::fixture-external-source:conversation-2:2::2::hash-2::::::',
    ],
  );
});

test('backfill resumes from durable state across service restarts', () => {
  const env = makeEnv();
  const items = [0, 1, 2].map(index => ({
    resourceRef: `conversation-${index}`,
    position: index,
    unit: buildUnit(env.root, `resume-${index}`, `resume-session-${index}`),
    contentHash: `resume-hash-${index}`,
  }));
  const request = makeRequest({ resourceRefs: items.map(item => item.resourceRef), endPosition: 2, maxResources: 1 });

  const run1 = new ExternalSessionLogBackfillService({
    stateFilePath: env.stateFilePath,
    auditFilePath: env.auditFilePath,
    now: sequentialClock(),
  }).run(request, new FixtureBackfillSource(items), unitToEpisodeIngestor(env.evidenceIngestor));

  assert.equal(run1.status, 'quota_reached');
  assert.equal(countEpisodes(env.episodeStore), 1);

  const run2 = new ExternalSessionLogBackfillService({
    stateFilePath: env.stateFilePath,
    auditFilePath: env.auditFilePath,
    now: sequentialClock('2026-01-01T00:10:00.000Z'),
  }).run(request, new FixtureBackfillSource(items), unitToEpisodeIngestor(env.evidenceIngestor));

  assert.equal(run2.status, 'quota_reached');
  assert.equal(countEpisodes(env.episodeStore), 2);

  const run3 = new ExternalSessionLogBackfillService({
    stateFilePath: env.stateFilePath,
    auditFilePath: env.auditFilePath,
    now: sequentialClock('2026-01-01T00:20:00.000Z'),
  }).run(request, new FixtureBackfillSource(items), unitToEpisodeIngestor(env.evidenceIngestor));

  assert.equal(run3.status, 'completed');
  assert.equal(countEpisodes(env.episodeStore), 3);

  const state = loadExternalSessionLogBackfillState(env.stateFilePath)!;
  assert.equal(state.metrics.runsStarted, 3);
  assert.equal(state.metrics.resourcesProcessed, 3);
});

test('one long resource resumes page-sized event quanta without replay or loss', () => {
  const env = makeEnv();
  const resource: SessionLogSourceResource = {
    resourceRef: 'long-conversation',
    firstEventIdentity: {
      eventId: 'long-event-0',
      position: 0,
      contentHash: 'long-hash-0',
    },
  };
  const units = [0, 1, 2].map(position => buildUnit(
    env.root,
    `long-${position}`,
    `long-session-${position}`,
  ));
  const source: ExternalSessionLogBackfillSource = {
    identity: {
      sourceId: 'fixture-external-source',
      label: 'Long fixture source',
      category: 'external',
      provider: 'fixture-provider',
      reader: 'fixture-backfill',
    },
    discoverResources: () => [resource],
    read: (_resource, cursor) => {
      const remaining = [0, 1, 2]
        .filter(position => position > cursor.position)
        .map(position => ({
          identity: {
            eventId: `long-event-${position}`,
            position,
            contentHash: `long-hash-${position}`,
          },
          distillationUnit: units[position]!,
          byteLength: 100,
        }));
      return {
        events: remaining,
        status: 'stable' as const,
        exhausted: true,
        newCursor: {
          resourceRef: resource.resourceRef,
          position: remaining.at(-1)?.identity.position ?? cursor.position,
          processedCount: cursor.processedCount + remaining.length,
        },
      };
    },
  };
  const request = makeRequest({
    resourceRefs: [resource.resourceRef],
    endPosition: 2,
    maxEvents: 1,
  });
  const seen: string[] = [];
  const run = (startIso: string) => new ExternalSessionLogBackfillService({
    stateFilePath: env.stateFilePath,
    auditFilePath: env.auditFilePath,
    now: sequentialClock(startIso),
  }).run(request, source, (_unit, context) => {
    seen.push(context.eventIdentity.eventId);
    return { admittedEpisodeIds: [] };
  });

  const first = run('2026-01-01T00:00:00.000Z');
  assert.equal(first.status, 'quota_reached');
  assert.equal(first.state.resourceCursors[resource.resourceRef]?.position, 0);

  const second = run('2026-01-01T00:10:00.000Z');
  assert.equal(second.status, 'quota_reached');
  assert.equal(second.state.resourceCursors[resource.resourceRef]?.position, 1);

  const third = run('2026-01-01T00:20:00.000Z');
  assert.equal(third.status, 'completed');
  assert.equal(third.state.resourceCursors[resource.resourceRef]?.position, 2);
  assert.deepEqual(seen, ['long-event-0', 'long-event-1', 'long-event-2']);
  assert.equal(third.state.metrics.ingestedEvents, 3);
  assert.equal(third.state.metrics.resourcesProcessed, 1);
});

test('blocked_zero_progress is resumable after bounds correction', () => {
  const env = makeEnv();
  const resourceRef = 'oversized-conversation';
  const unit = buildUnit(env.root, 'blocked-zero', 'blocked-session');
  const source: ExternalSessionLogBackfillSource = {
    identity: {
      sourceId: 'fixture-external-source',
      label: 'Blocked fixture source',
      category: 'external',
      provider: 'fixture-provider',
      reader: 'fixture-backfill',
    },
    discoverResources: () => [{
      resourceRef,
      firstEventIdentity: {
        eventId: 'blocked-event-0',
        position: 0,
        contentHash: 'blocked-hash-0',
      },
    }],
    read: (_resource, cursor) => ({
      events: [{
        identity: {
          eventId: 'blocked-event-0',
          position: 0,
          contentHash: 'blocked-hash-0',
        },
        distillationUnit: unit,
        // Larger than the first two runs' maxBytes so the page cannot progress.
        byteLength: 1_000,
      }],
      status: 'stable' as const,
      exhausted: true,
      newCursor: {
        resourceRef,
        position: 0,
        processedCount: cursor.processedCount + 1,
      },
    }),
  };

  const tightRequest = makeRequest({
    resourceRefs: [resourceRef],
    endPosition: 0,
    maxBytes: 100,
  });

  const service = new ExternalSessionLogBackfillService({
    stateFilePath: env.stateFilePath,
    auditFilePath: env.auditFilePath,
    now: sequentialClock(),
  });

  const first = service.run(tightRequest, source, unitToEpisodeIngestor(env.evidenceIngestor));
  assert.equal(first.status, 'quota_reached');
  assert.equal(first.ingestedEvents, 0);
  assert.equal(first.state.metrics.zeroProgressRuns, 1);

  const second = service.run(tightRequest, source, unitToEpisodeIngestor(env.evidenceIngestor));
  assert.equal(second.status, 'blocked_zero_progress');
  assert.equal(second.ingestedEvents, 0);
  assert.equal(second.state.metrics.zeroProgressRuns, 2);

  // Old permanent latch would return blocked immediately. After bounds
  // correction the same operation must reopen and progress.
  const raisedRequest = makeRequest({
    resourceRefs: [resourceRef],
    endPosition: 0,
    maxBytes: 10_000,
  });
  const third = service.run(raisedRequest, source, unitToEpisodeIngestor(env.evidenceIngestor));
  assert.equal(third.status, 'completed');
  assert.equal(third.ingestedEvents, 1);
  assert.ok(third.admittedEpisodes >= 1);
  assert.equal(third.state.metrics.zeroProgressRuns, 0);
  assert.equal(third.state.resourceStates[resourceRef]?.status, 'processed');
});

test('exact dedup skips replayed stable events for repeated bounded backfill', () => {
  const env = makeEnv();
  const item = {
    resourceRef: 'conversation-0',
    position: 0,
    unit: buildUnit(env.root, 'dedup-0', 'dedup-session-0'),
    contentHash: 'dedup-hash-0',
    ignoreCursor: true,
  } satisfies FixtureBackfillItem;
  const request = makeRequest({ resourceRefs: ['conversation-0'], endPosition: 0 });

  const first = new ExternalSessionLogBackfillService({
    stateFilePath: env.stateFilePath,
    auditFilePath: env.auditFilePath,
    now: sequentialClock(),
  }).run(request, new FixtureBackfillSource([item]), unitToEpisodeIngestor(env.evidenceIngestor));

  assert.equal(first.status, 'completed');
  assert.equal(countEpisodes(env.episodeStore), 1);

  const second = new ExternalSessionLogBackfillService({
    stateFilePath: env.stateFilePath,
    auditFilePath: env.auditFilePath,
    now: sequentialClock('2026-01-01T00:10:00.000Z'),
  }).run(request, new FixtureBackfillSource([item]), unitToEpisodeIngestor(env.evidenceIngestor));

  assert.equal(second.status, 'completed');
  assert.equal(second.duplicateEventsSkipped, 1);
  assert.equal(countEpisodes(env.episodeStore), 1, 'no duplicate learning episodes admitted');
});

test('backfill writes auditable records with operation identity and status transitions', () => {
  const env = makeEnv();
  const unit = buildUnit(env.root, 'audit-0', 'audit-session-0');
  const source = new FixtureBackfillSource([
    { resourceRef: 'conversation-audit', position: 0, unit, contentHash: 'audit-hash-0' },
  ]);
  const service = new ExternalSessionLogBackfillService({
    stateFilePath: env.stateFilePath,
    auditFilePath: env.auditFilePath,
    now: sequentialClock(),
  });

  service.run(
    makeRequest({ resourceRefs: ['conversation-audit'], endPosition: 0 }),
    source,
    unitToEpisodeIngestor(env.evidenceIngestor),
  );

  const auditEntries = loadAuditEntries(env.auditFilePath);
  assert.deepEqual(auditEntries.map(entry => entry.kind), ['started', 'resource_ingested', 'completed']);
  for (const entry of auditEntries) {
    assert.equal(entry.operationId, 'backfill-op-79');
    assert.equal(entry.provider, 'fixture-provider');
    assert.equal(entry.sourceId, 'fixture-external-source');
    assert.equal(entry.triggeredBy, 'operator:test');
    assert.equal(entry.range.startPosition, 0);
    assert.equal(entry.range.endPosition, 0);
  }
  assert.equal(auditEntries.at(-1)?.status, 'completed');
});

test('backfill isolates failures and leaves failed resource cursor unadvanced', () => {
  const env = makeEnv();
  const source = new FixtureBackfillSource([
    {
      resourceRef: 'conversation-ok-1',
      position: 0,
      unit: buildUnit(env.root, 'failure-ok-1', 'failure-session-1'),
      contentHash: 'failure-hash-1',
    },
    {
      resourceRef: 'conversation-fail',
      position: 1,
      unit: buildUnit(env.root, 'failure-bad', 'failure-session-bad'),
      contentHash: 'failure-hash-bad',
      failMessage: 'source unavailable',
    },
    {
      resourceRef: 'conversation-ok-2',
      position: 2,
      unit: buildUnit(env.root, 'failure-ok-2', 'failure-session-2'),
      contentHash: 'failure-hash-2',
    },
  ]);

  const result = new ExternalSessionLogBackfillService({
    stateFilePath: env.stateFilePath,
    auditFilePath: env.auditFilePath,
    now: sequentialClock(),
  }).run(
    makeRequest({
      resourceRefs: ['conversation-ok-1', 'conversation-fail', 'conversation-ok-2'],
      endPosition: 2,
      maxResources: 3,
    }),
    source,
    unitToEpisodeIngestor(env.evidenceIngestor),
  );

  assert.equal(result.status, 'source_failed');
  assert.equal(result.processedResources, 2);
  assert.equal(result.failedResources, 1);
  assert.equal(result.ingestedEvents, 2);

  const state = loadExternalSessionLogBackfillState(env.stateFilePath)!;
  assert.ok(state.resourceCursors['conversation-ok-1']);
  assert.ok(state.resourceCursors['conversation-ok-2']);
  assert.equal(state.resourceCursors['conversation-fail'], undefined);
  assert.equal(state.failures.length, 1);
  assert.match(state.failures[0].message, /source unavailable/);

  const auditEntries = loadAuditEntries(env.auditFilePath);
  assert.ok(auditEntries.some(entry => entry.kind === 'resource_failed' && entry.resourceRef === 'conversation-fail'));
});

test('backfill rejects resources with events outside requested range and marks source_failed', () => {
  const env = makeEnv();
  const outOfRange = buildUnit(env.root, 'oor', 'session-oor');
  const resources: readonly SessionLogSourceResource[] = [
    {
      resourceRef: 'conversation-0',
      firstEventIdentity: {
        eventId: 'fixture-external-source:conversation-0:0',
        position: 5,
        contentHash: 'oor-hash',
      },
    },
  ];
  const source: ExternalSessionLogBackfillSource = {
    identity: {
      sourceId: 'fixture-external-source',
      label: 'Fixture External Backfill Source',
      category: 'external',
      provider: 'fixture-provider',
      reader: 'fixture-backfill',
    },
    discoverResources: () => resources,
    read: () => ({
      events: [{
        identity: {
          eventId: 'fixture-external-source:conversation-0:0',
          position: 0,
          contentHash: 'oor-hash',
        },
        distillationUnit: outOfRange,
        byteLength: 1024,
      }],
      status: 'stable',
      exhausted: true,
      newCursor: { resourceRef: 'conversation-0', position: 1, processedCount: 1 },
    }),
  };
  const service = new ExternalSessionLogBackfillService({
    stateFilePath: env.stateFilePath,
    auditFilePath: env.auditFilePath,
    now: sequentialClock(),
  });

  const result = service.run(
    makeRequest({
      resourceRefs: ['conversation-0'],
      startPosition: 5,
      endPosition: 5,
    }),
    source,
    unitToEpisodeIngestor(env.evidenceIngestor),
  );

  assert.equal(result.status, 'source_failed');
  const state = loadExternalSessionLogBackfillState(env.stateFilePath)!;
  assert.equal(state.resourceCursors['conversation-0'], undefined);
  assert.equal(state.failures.length, 1);
  const audits = loadAuditEntries(env.auditFilePath);
  assert.ok(audits.some(entry => entry.kind === 'source_failed'));
});

function makeEnv(): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-backfill-'));
  tempRoots.push(root);
  const stateFilePath = path.join(root, 'data', 'backfill-state.json');
  const auditFilePath = path.join(root, 'data', 'backfill-audit.jsonl');
  const episodeStorePath = path.join(root, 'data', 'learning-episodes.json');
  const episodeStore = new LearningEpisodeStore(episodeStorePath);
  const evidenceIngestor = new EvidenceIngestor({ episodeStore, settlementWindowMs: 0 });
  return { root, stateFilePath, auditFilePath, episodeStore, evidenceIngestor };
}

function makeRequest(overrides: Partial<{
  resourceRefs: string[];
  startPosition: number;
  endPosition: number;
  maxResources: number;
  maxBytes: number;
  maxElapsedMs: number;
  maxEvents: number;
}> = {}): ExternalSessionLogBackfillRequest {
  return {
    operationId: 'backfill-op-79',
    triggeredBy: 'operator:test',
    provider: 'fixture-provider',
    sourceId: 'fixture-external-source',
    range: {
      startPosition: overrides.startPosition ?? 0,
      endPosition: overrides.endPosition ?? 99,
      resourceRefs: overrides.resourceRefs,
    },
    limits: {
      maxResources: overrides.maxResources ?? 10,
      maxBytes: overrides.maxBytes ?? Number.MAX_SAFE_INTEGER,
      maxElapsedMs: overrides.maxElapsedMs ?? 60_000,
      ...(overrides.maxEvents === undefined ? {} : { maxEvents: overrides.maxEvents }),
    },
  };
}

function unitToEpisodeIngestor(evidenceIngestor: EvidenceIngestor) {
  return (unit: DistillationUnit) => evidenceIngestor.ingest(unit);
}

function countEpisodes(store: LearningEpisodeStore): number {
  return Object.keys(store.load().episodes).length;
}

function loadAuditEntries(auditFilePath: string): Array<Record<string, any>> {
  return fs.readFileSync(auditFilePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, any>);
}

function sequentialClock(startIso = '2026-01-01T00:00:00.000Z'): () => Date {
  const start = Date.parse(startIso);
  let tick = 0;
  return () => new Date(start + (tick++) * 1000);
}

function buildUnit(root: string, name: string, sessionId: string): DistillationUnit {
  const filePath = path.join(root, 'fixtures', `${name}.jsonl`);
  writeLog(filePath, deliveryPair(sessionId, name));
  const extraction = extractDistillationUnit(filePath, {
    filePath,
    byteOffset: 0,
    processedTurnCount: 0,
    updatedAt: '',
    status: 'pending',
  });
  if (!extraction.distillationUnit) {
    throw new Error(`failed to build distillation unit for ${name}`);
  }
  return extraction.distillationUnit;
}

function writeLog(filePath: string, entries: object[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
}

function deliveryPair(sessionId: string, label: string): [SessionTurnLogEntry, SessionTurnLogEntry] {
  return [
    futureTurn(
      1,
      sessionId,
      `Please produce ${label}.`,
      `Produced ${label}.`,
      [{ id: `${label}-send`, name: 'send_file', arguments: { path: `${label}.md` }, result: `${label} sent` }],
    ),
    futureTurn(2, sessionId, `Thanks for ${label}.`, `You're welcome for ${label}.`),
  ];
}

function futureTurn(
  turn: number,
  sessionId: string,
  userText: string,
  assistantText: string,
  toolCalls: { id: string; name: string; arguments: any; result: string }[] = [],
): SessionTurnLogEntry {
  return {
    entry_type: 'turn',
    turn,
    timestamp: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    session_id: sessionId,
    session_type: 'chat',
    user: { text: userText },
    assistant: { text: assistantText, tool_calls: toolCalls },
    tokens: { prompt: 10, completion: 20 },
  };
}
