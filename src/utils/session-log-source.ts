/**
 * Session Log Source — source-neutral input boundary for the Heartbeat Log
 * Distillation Agent (issue #75).
 *
 * Introduces a source-neutral seam inside the existing local Heartbeat Log
 * Distillation Agent. The Runtime routes internal XiaoBa append-only logs
 * through an Internal Session Log Source adapter with no observable
 * regression, and exposes a deterministic fixture adapter through the public
 * RuntimeLearning.wake() path.
 *
 * The adapter contract distinguishes source, provider, and reader identity,
 * leaves stable Source Event Identity, bounded reads, and source provenance
 * representable, and keeps external sources explicitly disabled by default.
 *
 * See CONTEXT.md → "Session Log Source", "Internal Session Log Source",
 * "External Session Log Source", "Session Log Source Adapter",
 * "Source Event Identity".
 */

import * as fs from 'fs';
import * as path from 'path';

import { DistillationUnit, CrossFileContinuityOptions, extractDistillationUnit } from './distillation-unit';
import {
  LogCursorEntry,
  advanceCursor,
  getCursor,
  loadLogCursorState,
  markCursorFailed,
  saveLogCursorState,
} from './log-cursor-state';
import { DistillationHeartbeatConfig } from './distillation-heartbeat-config';

// ---------------------------------------------------------------------------
// Source identity
// ---------------------------------------------------------------------------

export type SessionLogSourceCategory = 'internal' | 'external';

/**
 * Source identity — describes the origin of a log, not an Agent that the
 * Runtime may invoke. This is distinct from External Agent executor identity:
 * the provider names the system that produced the log (e.g. "xiaoba", "pi",
 * "codex", "claude-code"), while the reader names the mechanism used to
 * access it (e.g. "filesystem-jsonl", "xurl", "fixture"). An External Agent
 * executor identity (the agent that runs the review branch) is a separate
 * concept managed by the skill-evolution runtime.
 */
export interface SessionLogSourceIdentity {
  readonly sourceId: string;
  readonly label: string;
  readonly category: SessionLogSourceCategory;
  readonly provider: string;
  readonly reader: string;
}

// ---------------------------------------------------------------------------
// Source Event Identity
// ---------------------------------------------------------------------------

/**
 * Stable provider-scoped identity and monotonic position used to resume a
 * Session Log Source without duplicating or losing events.
 */
export interface SourceEventIdentity {
  readonly eventId: string;
  readonly position: number;
  readonly contentHash?: string;
}

// ---------------------------------------------------------------------------
// Source cursor
// ---------------------------------------------------------------------------

export interface SourceCursor {
  readonly resourceRef: string;
  readonly position: number;
  readonly processedCount: number;
}

// ---------------------------------------------------------------------------
// Discovered resource
// ---------------------------------------------------------------------------

export interface SessionLogSourceResource {
  readonly resourceRef: string;
  readonly firstEventIdentity?: SourceEventIdentity;
}

// ---------------------------------------------------------------------------
// Read result
// ---------------------------------------------------------------------------

export type SessionLogSourceReadStatus = 'idle' | 'advanced' | 'exhausted' | 'disabled' | 'failed';

export interface SessionLogSourceReadResult {
  readonly distillationUnit: DistillationUnit | null;
  readonly advanced: boolean;
  readonly status: SessionLogSourceReadStatus;
  readonly newCursor: SourceCursor;
}

// ---------------------------------------------------------------------------
// Read context
// ---------------------------------------------------------------------------

export interface SessionLogSourceReadContext {
  readonly orderedResources: readonly SessionLogSourceResource[];
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

export interface SessionLogSourceAdapter {
  readonly identity: SessionLogSourceIdentity;
  isEnabled(): boolean;
  discoverResources(): readonly SessionLogSourceResource[];
  read(
    resource: SessionLogSourceResource,
    context: SessionLogSourceReadContext,
  ): SessionLogSourceReadResult;
  acknowledge(resource: SessionLogSourceResource, result: SessionLogSourceReadResult): void;
  markFailed(resource: SessionLogSourceResource, error: unknown): void;
}

// ---------------------------------------------------------------------------
// Internal Session Log Source Adapter
// ---------------------------------------------------------------------------

export class InternalSessionLogSourceAdapter implements SessionLogSourceAdapter {
  readonly identity: SessionLogSourceIdentity = {
    sourceId: 'internal-xiaoba',
    label: 'XiaoBa Internal Session Logs',
    category: 'internal',
    provider: 'xiaoba',
    reader: 'filesystem-jsonl',
  };

  constructor(private readonly config: DistillationHeartbeatConfig) {}

  isEnabled(): boolean {
    return true;
  }

  discoverResources(): readonly SessionLogSourceResource[] {
    const sessionLogsRoot = resolveSessionLogsRoot(this.config.logsRoot);
    if (!fs.existsSync(sessionLogsRoot) || !fs.statSync(sessionLogsRoot).isDirectory()) {
      return [];
    }
    return collectJsonlFiles(sessionLogsRoot).map(filePath => ({
      resourceRef: filePath,
      firstEventIdentity: {
        eventId: filePath,
        position: 0,
      },
    }));
  }

  read(
    resource: SessionLogSourceResource,
    context: SessionLogSourceReadContext,
  ): SessionLogSourceReadResult {
    const filePath = resource.resourceRef;
    const state = loadLogCursorState(this.config.stateFilePath);
    const cursor = getCursor(state, filePath);

    let extracted;
    try {
      const orderedFilePaths = context.orderedResources.map(r => r.resourceRef);
      const crossFileContinuity: CrossFileContinuityOptions = { orderedFilePaths };
      extracted = extractDistillationUnit(filePath, cursor, { crossFileContinuity });
    } catch (error) {
      this.markFailed(resource, error);
      return {
        distillationUnit: null,
        advanced: false,
        status: 'failed',
        newCursor: {
          resourceRef: filePath,
          position: cursor.byteOffset,
          processedCount: cursor.processedTurnCount,
        },
      };
    }

    return {
      distillationUnit: extracted.distillationUnit,
      advanced: extracted.advanced,
      status: extracted.distillationUnit ? 'advanced' : (extracted.advanced ? 'advanced' : 'idle'),
      newCursor: {
        resourceRef: filePath,
        position: extracted.newCursor.byteOffset,
        processedCount: extracted.newCursor.processedTurnCount,
      },
    };
  }

  acknowledge(resource: SessionLogSourceResource, result: SessionLogSourceReadResult): void {
    const state = loadLogCursorState(this.config.stateFilePath);
    const cursor: LogCursorEntry = {
      filePath: resource.resourceRef,
      byteOffset: result.newCursor.position,
      processedTurnCount: result.newCursor.processedCount,
      updatedAt: new Date().toISOString(),
      status: 'completed',
    };
    advanceCursor(state, cursor);
    saveLogCursorState(this.config.stateFilePath, state);
  }

  markFailed(resource: SessionLogSourceResource, error: unknown): void {
    const state = loadLogCursorState(this.config.stateFilePath);
    const existing = getCursor(state, resource.resourceRef);
    markCursorFailed(state, resource.resourceRef, existing.byteOffset, error);
    saveLogCursorState(this.config.stateFilePath, state);
  }
}

// ---------------------------------------------------------------------------
// Fixture Session Log Source Adapter
// ---------------------------------------------------------------------------

export class FixtureSessionLogSourceAdapter implements SessionLogSourceAdapter {
  readonly identity: SessionLogSourceIdentity;
  private readonly resources: readonly SessionLogSourceResource[];
  private readonly units: readonly (DistillationUnit | null)[];
  private readonly cursors = new Map<string, SourceCursor>();

  constructor(
    units: readonly (DistillationUnit | null)[],
    options: { identity?: Partial<SessionLogSourceIdentity> } = {},
  ) {
    this.identity = {
      sourceId: options.identity?.sourceId ?? 'fixture-test',
      label: options.identity?.label ?? 'Test Fixture Source',
      category: options.identity?.category ?? 'internal',
      provider: options.identity?.provider ?? 'fixture',
      reader: options.identity?.reader ?? 'fixture',
    };
    this.units = units;
    this.resources = units.map((unit, index) => ({
      resourceRef: `fixture://${this.identity.sourceId}/event-${index}`,
      firstEventIdentity: unit
        ? { eventId: `fixture://${this.identity.sourceId}/event-${index}`, position: 0 }
        : undefined,
    }));
    for (const resource of this.resources) {
      this.cursors.set(resource.resourceRef, {
        resourceRef: resource.resourceRef,
        position: 0,
        processedCount: 0,
      });
    }
  }

  isEnabled(): boolean {
    return true;
  }

  discoverResources(): readonly SessionLogSourceResource[] {
    return this.resources;
  }

  read(
    resource: SessionLogSourceResource,
    _context: SessionLogSourceReadContext,
  ): SessionLogSourceReadResult {
    const cursor = this.cursors.get(resource.resourceRef) ?? {
      resourceRef: resource.resourceRef,
      position: 0,
      processedCount: 0,
    };

    const index = this.resources.findIndex(r => r.resourceRef === resource.resourceRef);
    if (index < 0 || index >= this.units.length) {
      return {
        distillationUnit: null,
        advanced: false,
        status: 'exhausted',
        newCursor: cursor,
      };
    }

    // Each fixture resource yields exactly one distillation unit. A cursor
    // position > 0 means the resource has already been read — return exhausted.
    if (cursor.position > 0) {
      return {
        distillationUnit: null,
        advanced: false,
        status: 'exhausted',
        newCursor: cursor,
      };
    }

    const unit = this.units[index];
    if (!unit) {
      const newCursor: SourceCursor = {
        resourceRef: resource.resourceRef,
        position: cursor.position + 1,
        processedCount: cursor.processedCount,
      };
      this.cursors.set(resource.resourceRef, newCursor);
      return {
        distillationUnit: null,
        advanced: true,
        status: 'idle',
        newCursor,
      };
    }

    const newCursor: SourceCursor = {
      resourceRef: resource.resourceRef,
      position: cursor.position + 1,
      processedCount: cursor.processedCount + unit.newTurns.length,
    };
    this.cursors.set(resource.resourceRef, newCursor);

    return {
      distillationUnit: unit,
      advanced: true,
      status: 'advanced',
      newCursor,
    };
  }

  acknowledge(resource: SessionLogSourceResource, result: SessionLogSourceReadResult): void {
    void resource;
    void result;
  }

  markFailed(resource: SessionLogSourceResource, error: unknown): void {
    void error;
    const cursor = this.cursors.get(resource.resourceRef);
    if (cursor) {
      this.cursors.set(resource.resourceRef, {
        ...cursor,
        position: Math.max(0, cursor.position - 1),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// External Session Log Source Adapter (disabled by default)
// ---------------------------------------------------------------------------

export class ExternalSessionLogSourceAdapter implements SessionLogSourceAdapter {
  readonly identity: SessionLogSourceIdentity;
  private readonly enabled: boolean;

  constructor(
    options: {
      sourceId: string;
      label?: string;
      provider: string;
      reader?: string;
      enabled?: boolean;
    },
  ) {
    this.identity = {
      sourceId: options.sourceId,
      label: options.label ?? `External Source (${options.provider})`,
      category: 'external' as const,
      provider: options.provider,
      reader: options.reader ?? 'external',
    };
    this.enabled = options.enabled ?? false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  discoverResources(): readonly SessionLogSourceResource[] {
    if (!this.enabled) return [];
    return [];
  }

  read(
    _resource: SessionLogSourceResource,
    _context: SessionLogSourceReadContext,
  ): SessionLogSourceReadResult {
    return {
      distillationUnit: null,
      advanced: false,
      status: 'disabled',
      newCursor: {
        resourceRef: _resource.resourceRef,
        position: 0,
        processedCount: 0,
      },
    };
  }

  acknowledge(_resource: SessionLogSourceResource, _result: SessionLogSourceReadResult): void {}

  markFailed(_resource: SessionLogSourceResource, _error: unknown): void {}
}

// ---------------------------------------------------------------------------
// Source report (for RuntimeLearning discovery)
// ---------------------------------------------------------------------------

export interface SessionLogSourceReport {
  readonly sourceId: string;
  readonly category: SessionLogSourceCategory;
  readonly enabled: boolean;
  readonly resourcesDiscovered: number;
  readonly unitsProcessed: number;
  readonly advancedResources: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveSessionLogsRoot(logsRoot: string): string {
  const normalizedRoot = path.resolve(logsRoot);
  return path.basename(normalizedRoot) === 'sessions'
    ? normalizedRoot
    : path.join(normalizedRoot, 'sessions');
}

function collectJsonlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectJsonlFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath);
  }
  return files.sort();
}
