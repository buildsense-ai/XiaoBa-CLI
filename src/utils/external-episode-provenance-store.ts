/**
 * External Episode Provenance Store — extracted from RuntimeLearning (issue #78).
 *
 * Focused responsibility: own the bidirectional index tying external session-log
 * events to Learning Episode ids, plus all durability, validation, corrupt-state,
 * quarantine, and recovery lifecycle for that index.
 *
 * RuntimeLearning decides *when* to record, look up, save, and recover; this
 * store owns *how* those operations preserve the bidirectional invariant,
 * fail closed on corruption, and atomically persist.
 *
 * Behaviour is preserved exactly from the private methods that previously lived
 * inside `runtime-learning.ts`:
 *   - `recordExternalEpisodeProvenance`
 *   - `getExternalEpisodeIdsForEvent`
 *   - `isEpisodeFromExternalSource` (the provenance-index portion only; the
 *     `external://event/` crash fallback stays in RuntimeLearning)
 *   - `getExternalEpisodeProvenanceEventKey`
 *   - `loadExternalEpisodeProvenanceState`
 *   - `saveExternalEpisodeProvenanceState`
 *   - `assertExternalEpisodeProvenanceHealthy`
 *   - `recoverExternalEpisodeProvenanceState`
 *   - `validateExternalEpisodeProvenanceState`
 *
 * This is local-substitutable filesystem logic — no port or adapter is needed.
 * Tests use a real temp directory; production uses the learning-episode store
 * directory.
 */

import * as fs from 'fs';
import * as path from 'path';

import { Logger } from './logger';
import type { SessionLogSourceIdentity, SourceEventIdentity } from './session-log-source';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;

export interface ExternalEpisodeProvenanceState {
  schemaVersion: typeof SCHEMA_VERSION;
  episodeToEvent: Record<string, string>;
  eventToEpisodes: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeSourceHash(identity: SessionLogSourceIdentity): string {
  return `${identity.sourceId}::${identity.provider}::${identity.reader}`;
}

function normalizeSourceEventHash(contentHash: string | undefined): string {
  return (contentHash ?? '').trim();
}

function buildEventKey(
  identity: SessionLogSourceIdentity,
  eventIdentity: SourceEventIdentity,
): string {
  const sourceHash = normalizeSourceHash(identity);
  const contentHash = normalizeSourceEventHash(eventIdentity.contentHash);
  const conversationPart = eventIdentity.conversationId ? `::conversation=${eventIdentity.conversationId}` : '';
  const branchPart = eventIdentity.branchId ? `::branch=${eventIdentity.branchId}` : '';
  const revisionPart = eventIdentity.revision ? `::revision=${eventIdentity.revision}` : '';
  return `${identity.sourceId}::${identity.provider}::${identity.reader}::${sourceHash}::${eventIdentity.eventId}#${eventIdentity.position}`
    + conversationPart
    + branchPart
    + revisionPart
    + (contentHash ? `::${contentHash}` : '');
}

function validateState(value: unknown): ExternalEpisodeProvenanceState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('external provenance state must be an object');
  }
  const candidate = value as Partial<ExternalEpisodeProvenanceState>;
  if (candidate.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`unsupported external provenance schema: ${String(candidate.schemaVersion)}`);
  }
  if (!candidate.episodeToEvent || typeof candidate.episodeToEvent !== 'object'
    || Array.isArray(candidate.episodeToEvent)) {
    throw new Error('external provenance episodeToEvent must be an object');
  }
  if (!candidate.eventToEpisodes || typeof candidate.eventToEpisodes !== 'object'
    || Array.isArray(candidate.eventToEpisodes)) {
    throw new Error('external provenance eventToEpisodes must be an object');
  }

  const episodeToEvent: Record<string, string> = {};
  const expectedByEvent = new Map<string, string[]>();
  for (const [episodeId, eventKey] of Object.entries(candidate.episodeToEvent)) {
    if (!episodeId || typeof eventKey !== 'string' || !eventKey) {
      throw new Error('external provenance contains an invalid episode/event mapping');
    }
    episodeToEvent[episodeId] = eventKey;
    expectedByEvent.set(eventKey, [...(expectedByEvent.get(eventKey) ?? []), episodeId]);
  }

  const eventToEpisodes: Record<string, string[]> = {};
  for (const [eventKey, episodeIds] of Object.entries(candidate.eventToEpisodes)) {
    if (!eventKey || !Array.isArray(episodeIds)
      || episodeIds.some(episodeId => typeof episodeId !== 'string' || !episodeId)) {
      throw new Error('external provenance contains an invalid event/episodes mapping');
    }
    const normalized = [...new Set(episodeIds)].sort();
    if (normalized.length !== episodeIds.length) {
      throw new Error(`external provenance contains duplicate episode ids for event: ${eventKey}`);
    }
    eventToEpisodes[eventKey] = normalized;
  }

  const expectedKeys = [...expectedByEvent.keys()].sort();
  const actualKeys = Object.keys(eventToEpisodes).sort();
  if (expectedKeys.join('\n') !== actualKeys.join('\n')) {
    throw new Error('external provenance indexes disagree on event keys');
  }
  for (const eventKey of expectedKeys) {
    const expected = [...(expectedByEvent.get(eventKey) ?? [])].sort();
    if (expected.join('\n') !== eventToEpisodes[eventKey].join('\n')) {
      throw new Error(`external provenance indexes disagree for event: ${eventKey}`);
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    episodeToEvent,
    eventToEpisodes,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface ExternalEpisodeProvenanceStoreOptions {
  /** Path to the durable provenance JSON file. */
  stateFilePath: string;
  /** Path to the fail-closed marker written before a corrupt file is quarantined. */
  corruptMarkerPath: string;
  /** Clock function (defaults to Date.now). */
  clock?: () => Date;
}

export class ExternalEpisodeProvenanceStore {
  private readonly stateFilePath: string;
  private readonly corruptMarkerPath: string;
  private readonly clock: () => Date;
  private corrupt = false;
  private dirty = false;

  /** Episode id → event key. */
  private readonly episodeToEvent = new Map<string, string>();
  /** Event key → external episode ids. */
  private readonly eventToEpisodes = new Map<string, string[]>();

  constructor(options: ExternalEpisodeProvenanceStoreOptions) {
    this.stateFilePath = options.stateFilePath;
    this.corruptMarkerPath = options.corruptMarkerPath;
    this.clock = options.clock ?? (() => new Date());
    this.load();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Track that a specific external event maps to the listed episode ids.
   */
  record(
    identity: SessionLogSourceIdentity,
    eventIdentity: SourceEventIdentity,
    episodeIds: readonly string[],
  ): void {
    this.assertHealthy();
    if (episodeIds.length === 0) return;

    const eventKey = buildEventKey(identity, eventIdentity);
    const existingEventEpisodeIds = new Set(this.eventToEpisodes.get(eventKey) ?? []);
    const nextEventEpisodeIds = new Set(existingEventEpisodeIds);

    let changed = false;
    for (const episodeId of episodeIds) {
      nextEventEpisodeIds.add(episodeId);

      const previousEventKey = this.episodeToEvent.get(episodeId);
      if (previousEventKey === eventKey) {
        continue;
      }
      if (previousEventKey !== undefined) {
        const removedFromPrevious = this.eventToEpisodes.get(previousEventKey);
        if (removedFromPrevious) {
          const nextRemovedSet = new Set(removedFromPrevious);
          nextRemovedSet.delete(episodeId);
          const nextRemoved = [...nextRemovedSet];
          if (nextRemoved.length === 0) {
            this.eventToEpisodes.delete(previousEventKey);
          } else {
            this.eventToEpisodes.set(previousEventKey, nextRemoved);
          }
        }
      }
      this.episodeToEvent.set(episodeId, eventKey);
      changed = true;
    }

    const nextEventEpisodeIdsList = [...nextEventEpisodeIds].sort();
    const currentEventEpisodeIds = this.eventToEpisodes.get(eventKey);
    if (!currentEventEpisodeIds || currentEventEpisodeIds.join('|') !== nextEventEpisodeIdsList.join('|')) {
      this.eventToEpisodes.set(eventKey, nextEventEpisodeIdsList);
      changed = true;
    }
    if (changed) this.dirty = true;
  }

  /**
   * Resolve the external episode ids associated with an event, if any.
   * Throws if the store is in a fail-closed corrupt state.
   */
  getEpisodeIdsForEvent(
    identity: SessionLogSourceIdentity,
    eventIdentity: SourceEventIdentity,
  ): string[] {
    this.assertHealthy();
    const eventKey = buildEventKey(identity, eventIdentity);
    return [...(this.eventToEpisodes.get(eventKey) ?? [])];
  }

  /**
   * Check if an episode id is tracked by the provenance index.
   * Throws if the store is in a fail-closed corrupt state.
   */
  hasEpisode(episodeId: string): boolean {
    this.assertHealthy();
    return this.episodeToEvent.has(episodeId);
  }

  /**
   * Persist pending provenance changes atomically.
   * No-op when clean.
   */
  flush(): void {
    if (!this.dirty) return;
    this.persist();
  }

  /**
   * Explicitly restore a quarantined provenance index from a verified backup.
   * Recovery is never implicit because an empty replacement could misclassify
   * already-admitted external episodes as internal evidence.
   */
  recover(state: ExternalEpisodeProvenanceState): void {
    const validated = validateState(state);
    this.episodeToEvent.clear();
    this.eventToEpisodes.clear();
    for (const [episodeId, eventKey] of Object.entries(validated.episodeToEvent)) {
      this.episodeToEvent.set(episodeId, eventKey);
    }
    for (const [eventKey, episodeIds] of Object.entries(validated.eventToEpisodes)) {
      this.eventToEpisodes.set(eventKey, [...episodeIds]);
    }

    const marker = fs.existsSync(this.corruptMarkerPath)
      ? fs.readFileSync(this.corruptMarkerPath)
      : undefined;
    try {
      if (marker) fs.unlinkSync(this.corruptMarkerPath);
      this.corrupt = false;
      this.dirty = true;
      this.persist();
    } catch (error) {
      this.corrupt = true;
      if (marker && !fs.existsSync(this.corruptMarkerPath)) {
        fs.writeFileSync(this.corruptMarkerPath, marker, { mode: 0o600 });
      }
      throw error;
    }
  }

  /**
   * Fail-closed health invariant: throw if the store is corrupt or the
   * corrupt marker file exists on disk. All public methods that touch state
   * call this internally; callers that need to guard early (before any state
   * method is reached) may call this directly.
   */
  assertHealthy(): void {
    if (this.corrupt || fs.existsSync(this.corruptMarkerPath)) {
      this.corrupt = true;
      throw new Error(
        `external episode provenance is corrupt; restore a verified state and call recoverExternalEpisodeProvenanceState(): ${this.corruptMarkerPath}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Internal lifecycle
  // -----------------------------------------------------------------------

  private persist(): void {
    this.assertHealthy();
    const episodeToEvent: Record<string, string> = {};
    for (const [episodeId, eventKey] of this.episodeToEvent) {
      episodeToEvent[episodeId] = eventKey;
    }

    if (Object.keys(episodeToEvent).length === 0) {
      if (fs.existsSync(this.stateFilePath)) {
        fs.unlinkSync(this.stateFilePath);
      }
      this.dirty = false;
      return;
    }

    const eventToEpisodes: Record<string, string[]> = {};
    for (const [eventKey, episodeIds] of this.eventToEpisodes) {
      if (episodeIds.length > 0) {
        eventToEpisodes[eventKey] = [...episodeIds].sort();
      }
    }

    const payload: ExternalEpisodeProvenanceState = {
      schemaVersion: SCHEMA_VERSION,
      episodeToEvent,
      eventToEpisodes,
    };
    fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
    const tmpPath = `${this.stateFilePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      fs.renameSync(tmpPath, this.stateFilePath);
      this.dirty = false;
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // Preserve the original persistence failure; stale temp files are safe.
      }
    }
  }

  private load(): void {
    if (fs.existsSync(this.corruptMarkerPath)) {
      this.corrupt = true;
      Logger.warning(
        `[RuntimeLearning] external episode provenance is quarantined: ${this.corruptMarkerPath}`,
      );
      return;
    }

    try {
      if (!fs.existsSync(this.stateFilePath)) return;
      const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
      const parsed = validateState(JSON.parse(raw));
      for (const [episodeId, eventKey] of Object.entries(parsed.episodeToEvent)) {
        this.episodeToEvent.set(episodeId, eventKey);
      }
      for (const [eventKey, episodeIds] of Object.entries(parsed.eventToEpisodes)) {
        this.eventToEpisodes.set(eventKey, [...episodeIds]);
      }
    } catch (error) {
      this.corrupt = true;
      fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
      fs.writeFileSync(
        this.corruptMarkerPath,
        JSON.stringify({
          detectedAt: this.clock().toISOString(),
          sourcePath: this.stateFilePath,
          reason: error instanceof Error ? error.message : String(error),
        }, null, 2),
        { encoding: 'utf-8', mode: 0o600 },
      );
      const quarantinePath = `${this.stateFilePath}.corrupt-${Date.now()}`;
      try {
        if (fs.existsSync(this.stateFilePath)) {
          fs.renameSync(this.stateFilePath, quarantinePath);
        }
      } catch (quarantineError) {
        Logger.warning(
          `[RuntimeLearning] failed to quarantine corrupt external provenance: ${(quarantineError as Error).message}`,
        );
      }
      Logger.warning(
        `[RuntimeLearning] external episode provenance failed closed: ${(error as Error).message}`,
      );
    }
  }
}