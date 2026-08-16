import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ExternalEpisodeProvenanceStore,
  type ExternalEpisodeProvenanceState,
} from '../src/utils/external-episode-provenance-store';
import type { SessionLogSourceIdentity, SourceEventIdentity } from '../src/utils/session-log-source';

function makeIdentity(overrides: Partial<SessionLogSourceIdentity> = {}): SessionLogSourceIdentity {
  return {
    sourceId: 'external-github',
    label: 'GitHub Session Logs',
    category: 'external',
    provider: 'github',
    reader: 'xurl',
    ...overrides,
  };
}

function makeEventIdentity(overrides: Partial<SourceEventIdentity> = {}): SourceEventIdentity {
  return {
    eventId: 'evt-1',
    position: 7,
    contentHash: 'hash-1',
    conversationId: 'conv-1',
    branchId: 'branch-main',
    revision: 'rev-1',
    ...overrides,
  };
}

function makePaths(root: string) {
  const stateFilePath = path.join(root, 'data', 'external-source-provenance.json');
  return {
    stateFilePath,
    corruptMarkerPath: `${stateFilePath}.state-corrupt`,
  };
}

function makeStore(root: string): ExternalEpisodeProvenanceStore {
  const { stateFilePath, corruptMarkerPath } = makePaths(root);
  return new ExternalEpisodeProvenanceStore({
    stateFilePath,
    corruptMarkerPath,
    clock: () => new Date('2026-07-19T00:00:00.000Z'),
  });
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('ExternalEpisodeProvenanceStore', () => {
  test('records lookups and remaps an episode to a newer event', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-external-provenance-'));
    roots.push(root);
    const store = makeStore(root);
    const identity = makeIdentity();
    const eventA = makeEventIdentity({ eventId: 'evt-a', position: 1 });
    const eventB = makeEventIdentity({ eventId: 'evt-b', position: 2 });

    store.record(identity, eventA, ['episode-1', 'episode-2']);
    assert.deepEqual(store.getEpisodeIdsForEvent(identity, eventA), ['episode-1', 'episode-2']);
    assert.equal(store.hasEpisode('episode-1'), true);

    store.record(identity, eventB, ['episode-1']);
    assert.deepEqual(store.getEpisodeIdsForEvent(identity, eventA), ['episode-2']);
    assert.deepEqual(store.getEpisodeIdsForEvent(identity, eventB), ['episode-1']);
  });

  test('distinguishes event-key identity by conversation branch revision and content hash', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-external-provenance-'));
    roots.push(root);
    const store = makeStore(root);
    const identity = makeIdentity();

    const base = makeEventIdentity();
    const sameEventIdDifferentConversation = makeEventIdentity({ conversationId: 'conv-2' });
    const sameEventIdDifferentBranch = makeEventIdentity({ branchId: 'branch-feature' });
    const sameEventIdDifferentRevision = makeEventIdentity({ revision: 'rev-2' });
    const sameEventIdDifferentHash = makeEventIdentity({ contentHash: 'hash-2' });

    store.record(identity, base, ['episode-base']);
    store.record(identity, sameEventIdDifferentConversation, ['episode-conv']);
    store.record(identity, sameEventIdDifferentBranch, ['episode-branch']);
    store.record(identity, sameEventIdDifferentRevision, ['episode-rev']);
    store.record(identity, sameEventIdDifferentHash, ['episode-hash']);

    assert.deepEqual(store.getEpisodeIdsForEvent(identity, base), ['episode-base']);
    assert.deepEqual(store.getEpisodeIdsForEvent(identity, sameEventIdDifferentConversation), ['episode-conv']);
    assert.deepEqual(store.getEpisodeIdsForEvent(identity, sameEventIdDifferentBranch), ['episode-branch']);
    assert.deepEqual(store.getEpisodeIdsForEvent(identity, sameEventIdDifferentRevision), ['episode-rev']);
    assert.deepEqual(store.getEpisodeIdsForEvent(identity, sameEventIdDifferentHash), ['episode-hash']);
  });

  test('persists and reloads the durable bidirectional index', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-external-provenance-'));
    roots.push(root);
    const identity = makeIdentity();
    const event = makeEventIdentity({ eventId: 'evt-persist', position: 42 });

    const store = makeStore(root);
    store.record(identity, event, ['episode-9']);
    store.flush();

    const reloaded = makeStore(root);
    assert.deepEqual(reloaded.getEpisodeIdsForEvent(identity, event), ['episode-9']);
    assert.equal(reloaded.hasEpisode('episode-9'), true);

    const { stateFilePath } = makePaths(root);
    const persisted = readJson(stateFilePath) as ExternalEpisodeProvenanceState;
    assert.equal(persisted.schemaVersion, 1);
    assert.equal(persisted.episodeToEvent['episode-9'] !== undefined, true);
  });

  test('clean flush is a no-op and does not create a durable file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-external-provenance-'));
    roots.push(root);
    const store = makeStore(root);
    const { stateFilePath } = makePaths(root);

    store.flush();

    assert.equal(fs.existsSync(stateFilePath), false);
  });

  test('fails closed on inconsistent persisted state and quarantines the file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-external-provenance-'));
    roots.push(root);
    const { stateFilePath, corruptMarkerPath } = makePaths(root);
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(stateFilePath, JSON.stringify({
      schemaVersion: 1,
      episodeToEvent: {
        'episode-1': 'event-a',
      },
      eventToEpisodes: {
        'event-b': ['episode-1'],
      },
    }, null, 2));

    const store = makeStore(root);
    assert.equal(fs.existsSync(corruptMarkerPath), true);
    assert.equal(fs.existsSync(stateFilePath), false);
    const quarantined = fs.readdirSync(path.dirname(stateFilePath))
      .filter(name => name.startsWith('external-source-provenance.json.corrupt-'));
    assert.equal(quarantined.length, 1);

    const marker = readJson(corruptMarkerPath) as Record<string, unknown>;
    assert.equal(marker.detectedAt, '2026-07-19T00:00:00.000Z');
    assert.equal(marker.sourcePath, stateFilePath);
    assert.match(String(marker.reason), /indexes disagree/);

    assert.throws(
      () => store.getEpisodeIdsForEvent(makeIdentity(), makeEventIdentity()),
      /recoverExternalEpisodeProvenanceState\(\)/,
    );
  });

  test('recovers a quarantined store clears the marker and restores lookups', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-external-provenance-'));
    roots.push(root);
    const { stateFilePath, corruptMarkerPath } = makePaths(root);
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(stateFilePath, '{not valid json', 'utf8');

    const store = makeStore(root);
    assert.equal(fs.existsSync(corruptMarkerPath), true);

    const recoveredState: ExternalEpisodeProvenanceState = {
      schemaVersion: 1,
      episodeToEvent: {
        'episode-7': 'event-7',
      },
      eventToEpisodes: {
        'event-7': ['episode-7'],
      },
    };

    store.recover(recoveredState);

    assert.equal(fs.existsSync(corruptMarkerPath), false);
    const reloaded = makeStore(root);
    assert.equal(reloaded.hasEpisode('episode-7'), true);

    const persisted = readJson(stateFilePath) as ExternalEpisodeProvenanceState;
    assert.deepEqual(persisted, recoveredState);
  });
});
