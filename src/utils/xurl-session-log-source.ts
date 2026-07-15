import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { DistillationUnit } from './distillation-unit';
import {
  ExternalSourceActivationResource,
  ExternalSourceIncrementalDiscoveryRequest,
  ExternalSourceIncrementalDiscoveryResult,
  ExternalSourceRawEvent,
  ExternalSourceReader,
  ExternalSourceReaderResult,
  SessionLogSourceIdentity,
  SessionLogSourceResource,
  SourceCursor,
  SourceEventIdentity,
} from './session-log-source';
import {
  ExternalSessionLogBackfillEvent,
  ExternalSessionLogBackfillReadResult,
  ExternalSessionLogBackfillSource,
} from './session-log-backfill';
import { SessionTurnLogEntry } from './session-log-schema';

// ---------------------------------------------------------------------------
// Official xURL agents:// rendered-Timeline reader contract (ADR-0043).
//
// XiaoBa invokes the unmodified official xURL CLI through its documented
// `agents://` URI interface and consumes the provider-neutral rendered
// Timeline. It never invokes the private `session-log-v1` command, never
// forks xURL, never parses provider source formats, and never retains a
// private session-log-v1 fallback. Identity is derived from provider, thread,
// branch/child identity, and the normalized ordinal range plus an immutable
// content fingerprint computed over the rendered roles and content.
// ---------------------------------------------------------------------------

export const DEFAULT_XURL_TIMEOUT_MS = 10_000;
export const DEFAULT_XURL_MAX_OUTPUT_BYTES = 256 * 1024;
export const DEFAULT_XURL_QUERY_LIMIT = 100;
export const DEFAULT_XURL_MAX_ACTIVATION_CATALOG = 2048;
export const DEFAULT_XURL_MAX_ACTIVATION_OUTPUT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_XURL_MAX_ACTIVATION_DURATION_MS = 60_000;

/** Marker property used to detect activation-blocked errors without an import cycle. */
export const XURL_ACTIVATION_BLOCKED_MARKER = 'xurlActivationBlocked';

type XurlCommandKind = 'version' | 'query' | 'read' | 'head';

type TimelineRole = 'User' | 'Assistant' | 'Context Compacted';

interface RenderedFrontmatter {
  readonly fields: ReadonlyMap<string, string>;
  readonly raw: string;
}

interface RenderedThreadEntry {
  readonly ordinal: number;
  readonly role: TimelineRole;
  readonly content: string;
}

interface RenderedThreadSummary {
  readonly threadId: string;
  readonly uri: string;
  readonly branch: string;
  readonly ordinal: number;
  readonly fingerprint: string;
  readonly revision?: string;
}

interface RenderedCatalog {
  readonly provider: string;
  readonly uri: string;
  readonly next: string | null;
  readonly threads: readonly RenderedThreadSummary[];
}

interface RenderedTimeline {
  readonly provider: string;
  readonly threadId: string;
  readonly uri: string;
  readonly branch: string;
  readonly ordinal: number;
  readonly fingerprint: string;
  readonly revision?: string;
  readonly queriedAt: string;
  readonly entries: readonly RenderedThreadEntry[];
}

interface CanonicalEvent {
  readonly startOrdinal: number;
  readonly endOrdinal: number;
  readonly userContent: string;
  readonly assistantContent: string;
  readonly contextContent: string[];
  readonly contentHash: string;
}

export interface XurlProcessRunnerOptions {
  readonly command: string;
  readonly provider: string;
  readonly sourceId: string;
  readonly sourceLabel?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** When true the reader calls `xurl --version` once and records it for diagnostics. */
  readonly checkVersion?: boolean;
  /**
   * Maximum number of threads the activation baseline may discover before the
   * provider enters durable `activation_blocked`.
   */
  readonly maxActivationCatalog?: number;
  /** Maximum total rendered output bytes consumed during one activation pass. */
  readonly maxActivationOutputBytes?: number;
  /** Maximum wall-clock duration for one activation pass. */
  readonly maxActivationDurationMs?: number;
}

export interface XurlExternalSourceOptions extends XurlProcessRunnerOptions {
  /**
   * Diagnostic override that disables cursor filtering in read(), so every
   * canonical event in the rendered Timeline is returned. Production leaves
   * this false to preserve future-only admission. Used by operator-requested
   * full re-scan/replay verification.
   */
  readonly disableCursorFilter?: boolean;
}

interface XurlNormalizedReadPage {
  readonly status: 'stable' | 'pending';
  readonly exhausted: boolean;
  readonly newPosition: number;
  readonly events: readonly XurlNormalizedEvent[];
  readonly threadFingerprint?: string;
  readonly threadOrdinal?: number;
}

interface XurlNormalizedEvent {
  readonly identity: SourceEventIdentity;
  readonly distillationUnit: DistillationUnit;
  readonly byteLength: number;
}

/**
 * Thrown when the activation baseline exceeds the configured catalog, output,
 * or duration limits. Carries a marker property so the adapter can persist a
 * durable `activation_blocked` state without importing this module.
 */
export class XurlActivationBlockedError extends Error {
  readonly [XURL_ACTIVATION_BLOCKED_MARKER] = true;
  constructor(message: string) {
    super(message);
    this.name = 'XurlActivationBlockedError';
  }
}

function isXurlActivationBlockedError(error: unknown): boolean {
  return error != null && typeof error === 'object'
    && (error as Record<string, unknown>)[XURL_ACTIVATION_BLOCKED_MARKER] === true;
}

export class XurlExternalSourceReader implements ExternalSourceReader {
  readonly provider: string;
  readonly reader = 'xurl';
  private readonly runner: XurlOfficialRunner;
  private readonly disableCursorFilter: boolean;

  constructor(options: XurlExternalSourceOptions) {
    this.provider = options.provider;
    this.runner = new XurlOfficialRunner(options);
    this.disableCursorFilter = options.disableCursorFilter === true;
  }

  /** xURL version recorded on first discovery (best-effort, undefined if unchecked/failed). */
  get version(): string | undefined {
    return this.runner.version;
  }

  discoverResources(cursor: SourceCursor | null): readonly SessionLogSourceResource[] {
    return this.discoverIncremental({ cursor }).resources;
  }

  discoverIncremental(
    request: ExternalSourceIncrementalDiscoveryRequest,
  ): ExternalSourceIncrementalDiscoveryResult {
    const limit = normalizePositiveInteger(
      request.maxResources ?? DEFAULT_XURL_QUERY_LIMIT,
      DEFAULT_XURL_QUERY_LIMIT,
      'xurl query limit',
    );
    const catalog = this.runner.queryCatalog(limit, request.pageToken ?? null);
    this.runner.checkActivationLimits(catalog);

    const resources: SessionLogSourceResource[] = catalog.threads.map(summary => ({
      resourceRef: summary.threadId,
      firstEventIdentity: {
        eventId: canonicalEventId(this.provider, summary.threadId, summary.ordinal, summary.ordinal),
        position: summary.ordinal,
        conversationId: summary.threadId,
        branchId: summary.branch,
        ...(summary.revision ? { revision: summary.revision } : {}),
        contentHash: summary.fingerprint,
      },
    }));
    const activationResources: ExternalSourceActivationResource[] = catalog.threads.map((summary, index) => ({
      resource: resources[index]!,
      activationPosition: summary.ordinal,
    }));
    return {
      resources,
      activationResources,
      nextPageToken: catalog.next,
      activationWatermarkPosition: catalog.threads.length > 0
        ? Math.max(...catalog.threads.map(thread => thread.ordinal))
        : 0,
    };
  }

  read(resource: SessionLogSourceResource, cursor: SourceCursor): ExternalSourceReaderResult {
    const page = this.runner.readThreadTimeline(resource, cursor, this.disableCursorFilter);
    return {
      events: page.events.map(({ identity, distillationUnit }) => ({
        eventId: identity.eventId,
        position: identity.position,
        contentHash: identity.contentHash,
        conversationId: identity.conversationId,
        branchId: identity.branchId,
        revision: identity.revision,
        distillationUnit,
      } satisfies ExternalSourceRawEvent)),
      status: page.status,
      exhausted: page.exhausted,
      newPosition: page.newPosition,
      byteLength: page.events.reduce((sum, event) => sum + event.byteLength, 0),
    };
  }

  async readAsync(
    resource: SessionLogSourceResource,
    cursor: SourceCursor,
    signal: AbortSignal,
  ): Promise<ExternalSourceReaderResult> {
    const page = await this.runner.readPageAsync(resource, cursor, this.disableCursorFilter, signal);
    return {
      events: page.events.map(({ identity, distillationUnit }) => ({
        eventId: identity.eventId,
        position: identity.position,
        contentHash: identity.contentHash,
        conversationId: identity.conversationId,
        branchId: identity.branchId,
        revision: identity.revision,
        distillationUnit,
      } satisfies ExternalSourceRawEvent)),
      status: page.status,
      exhausted: page.exhausted,
      newPosition: page.newPosition,
      byteLength: page.events.reduce((sum, event) => sum + event.byteLength, 0),
    };
  }
}

export class XurlExternalBackfillSource implements ExternalSessionLogBackfillSource {
  readonly identity: SessionLogSourceIdentity;
  private readonly runner: XurlOfficialRunner;

  constructor(options: XurlExternalSourceOptions) {
    this.identity = {
      sourceId: requireNonEmptyText('xurl sourceId', options.sourceId),
      label: options.sourceLabel?.trim() || `External Source (${options.provider})`,
      category: 'external',
      provider: requireNonEmptyText('xurl provider', options.provider),
      reader: 'xurl',
    };
    this.runner = new XurlOfficialRunner(options);
  }

  /** xURL version recorded on first discovery (best-effort, undefined if unchecked/failed). */
  get version(): string | undefined {
    return this.runner.version;
  }

  discoverResources(): readonly SessionLogSourceResource[] {
    const limit = DEFAULT_XURL_QUERY_LIMIT;
    let pageToken: string | null = null;
    const resources: SessionLogSourceResource[] = [];
    // Explicit backfill discovers the complete in-scope catalog, paging until exhausted.
    for (;;) {
      const catalog = this.runner.queryCatalog(limit, pageToken);
      this.runner.checkActivationLimits(catalog);
      for (const summary of catalog.threads) {
        resources.push({
          resourceRef: summary.threadId,
          firstEventIdentity: {
            eventId: canonicalEventId(this.identity.provider, summary.threadId, summary.ordinal, summary.ordinal),
            position: summary.ordinal,
            conversationId: summary.threadId,
            branchId: summary.branch,
            ...(summary.revision ? { revision: summary.revision } : {}),
            contentHash: summary.fingerprint,
          },
        });
      }
      pageToken = catalog.next;
      if (pageToken == null) break;
    }
    return resources;
  }

  read(resource: SessionLogSourceResource, cursor: SourceCursor): ExternalSessionLogBackfillReadResult {
    // Explicit backfill returns every canonical event in the rendered Timeline;
    // the backfill service filters by the requested range. No stability
    // sampling is applied because the operator explicitly requested the range.
    const page = this.runner.readThreadTimeline(resource, cursor, true);
    return {
      events: page.events.map(({ identity, distillationUnit, byteLength }) => ({
        identity,
        distillationUnit,
        byteLength,
      } satisfies ExternalSessionLogBackfillEvent)),
      status: page.status,
      exhausted: page.exhausted,
      newCursor: {
        resourceRef: resource.resourceRef,
        position: page.newPosition,
        processedCount: cursor.processedCount + page.events.length,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Official xURL process runner — invokes only documented agents:// commands.
// ---------------------------------------------------------------------------

class XurlOfficialRunner {
  private readonly command: string;
  private readonly provider: string;
  private readonly cwd?: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly checkVersion: boolean;
  private readonly maxActivationCatalog: number;
  private readonly maxActivationOutputBytes: number;
  private readonly maxActivationDurationMs: number;
  private versionCache: string | undefined;
  private versionChecked = false;
  private activationBytesAccum = 0;
  private activationStartedAt = 0;

  constructor(options: XurlProcessRunnerOptions) {
    this.command = requireNonEmptyText('xurl command', options.command);
    this.provider = requireNonEmptyText('xurl provider', options.provider);
    requireNonEmptyText('xurl sourceId', options.sourceId);
    this.cwd = options.cwd;
    this.env = options.env;
    this.timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_XURL_TIMEOUT_MS, 'xurl timeoutMs');
    this.maxOutputBytes = normalizePositiveInteger(
      options.maxOutputBytes,
      DEFAULT_XURL_MAX_OUTPUT_BYTES,
      'xurl maxOutputBytes',
    );
    this.checkVersion = options.checkVersion !== false;
    this.maxActivationCatalog = resolveActivationLimit(
      options.maxActivationCatalog,
      'XIAOBA_EXTERNAL_SESSION_LOG_XURL_MAX_ACTIVATION_CATALOG',
      DEFAULT_XURL_MAX_ACTIVATION_CATALOG,
      'xurl maxActivationCatalog',
    );
    this.maxActivationOutputBytes = resolveActivationLimit(
      options.maxActivationOutputBytes,
      'XIAOBA_EXTERNAL_SESSION_LOG_XURL_MAX_ACTIVATION_OUTPUT_BYTES',
      DEFAULT_XURL_MAX_ACTIVATION_OUTPUT_BYTES,
      'xurl maxActivationOutputBytes',
    );
    this.maxActivationDurationMs = resolveActivationLimit(
      options.maxActivationDurationMs,
      'XIAOBA_EXTERNAL_SESSION_LOG_XURL_MAX_ACTIVATION_DURATION_MS',
      DEFAULT_XURL_MAX_ACTIVATION_DURATION_MS,
      'xurl maxActivationDurationMs',
    );
  }

  get version(): string | undefined {
    return this.versionCache;
  }

  checkActivationLimits(catalog: RenderedCatalog): void {
    if (catalog.threads.length > this.maxActivationCatalog) {
      throw new XurlActivationBlockedError(
        `xurl activation catalog exceeded limit: ${catalog.threads.length} > ${this.maxActivationCatalog}`,
      );
    }
    if (this.activationBytesAccum > this.maxActivationOutputBytes) {
      throw new XurlActivationBlockedError(
        `xurl activation output exceeded limit: ${this.activationBytesAccum} > ${this.maxActivationOutputBytes}`,
      );
    }
    const elapsed = this.activationStartedAt === 0 ? 0 : Date.now() - this.activationStartedAt;
    if (elapsed > this.maxActivationDurationMs) {
      throw new XurlActivationBlockedError(
        `xurl activation duration exceeded limit: ${elapsed} > ${this.maxActivationDurationMs}`,
      );
    }
  }

  queryCatalog(limit: number, pageToken: string | null): RenderedCatalog {
    this.ensureVersion();
    if (this.activationStartedAt === 0) this.activationStartedAt = Date.now();
    const uri = pageToken
      ? `agents://${this.provider}?limit=${limit}&cursor=${pageToken}`
      : `agents://${this.provider}?limit=${limit}`;
    const stdout = this.invoke('query', [uri]);
    this.activationBytesAccum += Buffer.byteLength(stdout, 'utf8');
    return parseRenderedCatalog(stdout, this.provider, uri);
  }

  readThreadTimeline(
    resource: SessionLogSourceResource,
    cursor: SourceCursor,
    disableCursorFilter: boolean,
  ): XurlNormalizedReadPage {
    const uri = `agents://${this.provider}/${requireNonEmptyText('xurl thread', resource.resourceRef)}`;
    const stdout = this.invoke('read', [uri]);
    const timeline = parseRenderedTimeline(stdout, this.provider, resource.resourceRef, uri);
    const allEvents = canonicalizeEvents(timeline);

    const cursorPosition = normalizeNonNegativeInteger(cursor.position + 1, 'xurl cursor position') - 1;
    const newEvents = disableCursorFilter
      ? allEvents
      : allEvents.filter(event => event.endOrdinal > cursorPosition);

    // Explicit operator-requested backfill (disableCursorFilter) trusts the
    // rendered range as-is: no stability sampling, no head confirmation.
    if (disableCursorFilter) {
      if (newEvents.length === 0) {
        return {
          status: 'stable',
          exhausted: true,
          newPosition: timeline.ordinal,
          events: [],
          threadFingerprint: timeline.fingerprint,
          threadOrdinal: timeline.ordinal,
        };
      }
      const normalized = newEvents.map(event => normalizeCanonicalEvent(this.provider, resource, timeline, event));
      return {
        status: 'stable',
        exhausted: timeline.ordinal === newEvents[newEvents.length - 1]!.endOrdinal,
        newPosition: newEvents[newEvents.length - 1]!.endOrdinal,
        events: normalized,
        threadFingerprint: timeline.fingerprint,
        threadOrdinal: timeline.ordinal,
      };
    }

    if (newEvents.length === 0) {
      // No new complete ranges past the cursor. The tail may still be incomplete;
      // either way there is nothing stable to admit yet.
      const tailIncomplete = isTailIncomplete(allEvents, timeline.entries);
      return {
        status: tailIncomplete ? 'pending' : 'stable',
        exhausted: !tailIncomplete,
        newPosition: timeline.ordinal,
        events: [],
        threadFingerprint: timeline.fingerprint,
        threadOrdinal: timeline.ordinal,
      };
    }

    // A newly observed tail requires two identical bounded observations before
    // the durable cursor may advance. The primary read is the first observation;
    // the head (`-I`) is the second. If the head reports a different ordinal or
    // fingerprint the tail is still mutating and stays pending without counting
    // as a provider failure. (ADR-0043 stability sampling.)
    if (isTailIncomplete(allEvents, timeline.entries)) {
      return {
        status: 'pending',
        exhausted: false,
        newPosition: cursorPosition,
        events: [],
        threadFingerprint: timeline.fingerprint,
        threadOrdinal: timeline.ordinal,
      };
    }

    const head = this.headFrontmatter(resource);
    if (
      head.ordinal !== timeline.ordinal
      || head.fingerprint !== timeline.fingerprint
    ) {
      return {
        status: 'pending',
        exhausted: false,
        newPosition: cursorPosition,
        events: [],
        threadFingerprint: timeline.fingerprint,
        threadOrdinal: timeline.ordinal,
      };
    }

    const normalized = newEvents.map(event => normalizeCanonicalEvent(this.provider, resource, timeline, event));
    return {
      status: 'stable',
      exhausted: timeline.ordinal === newEvents[newEvents.length - 1]!.endOrdinal,
      newPosition: newEvents[newEvents.length - 1]!.endOrdinal,
      events: normalized,
      threadFingerprint: timeline.fingerprint,
      threadOrdinal: timeline.ordinal,
    };
  }

  private headFrontmatter(resource: SessionLogSourceResource): {
    readonly ordinal: number;
    readonly fingerprint: string;
  } {
    const uri = `agents://${this.provider}/${requireNonEmptyText('xurl thread', resource.resourceRef)}`;
    const stdout = this.invoke('head', ['-I', uri]);
    const frontmatter = parseFrontmatterOnly(stdout, 'xurl head response');
    const uriField = requireFrontmatterField(frontmatter, 'uri');
    if (uriField !== uri) {
      throw new Error(`xurl head uri mismatch: expected ${uri}`);
    }
    return {
      ordinal: normalizeNonNegativeInteger(
        Number(requireFrontmatterField(frontmatter, 'ordinal')),
        'xurl head ordinal',
      ),
      fingerprint: requireNonEmptyText('xurl head fingerprint', requireFrontmatterField(frontmatter, 'fingerprint')),
    };
  }

  private async headFrontmatterAsync(
    resource: SessionLogSourceResource,
    signal: AbortSignal,
  ): Promise<{ readonly ordinal: number; readonly fingerprint: string }> {
    const uri = `agents://${this.provider}/${requireNonEmptyText('xurl thread', resource.resourceRef)}`;
    const stdout = await this.invokeAsync('head', ['-I', uri], signal);
    const frontmatter = parseFrontmatterOnly(stdout, 'xurl head response');
    const uriField = requireFrontmatterField(frontmatter, 'uri');
    if (uriField !== uri) {
      throw new Error(`xurl head uri mismatch: expected ${uri}`);
    }
    return {
      ordinal: normalizeNonNegativeInteger(
        Number(requireFrontmatterField(frontmatter, 'ordinal')),
        'xurl head ordinal',
      ),
      fingerprint: requireNonEmptyText('xurl head fingerprint', requireFrontmatterField(frontmatter, 'fingerprint')),
    };
  }

  async readPageAsync(
    resource: SessionLogSourceResource,
    cursor: SourceCursor,
    disableCursorFilter: boolean,
    signal: AbortSignal,
  ): Promise<XurlNormalizedReadPage> {
    const uri = `agents://${this.provider}/${requireNonEmptyText('xurl thread', resource.resourceRef)}`;
    const stdout = await this.invokeAsync('read', [uri], signal);
    const timeline = parseRenderedTimeline(stdout, this.provider, resource.resourceRef, uri);
    const allEvents = canonicalizeEvents(timeline);

    const cursorPosition = normalizeNonNegativeInteger(cursor.position + 1, 'xurl cursor position') - 1;
    const newEvents = disableCursorFilter
      ? allEvents
      : allEvents.filter(event => event.endOrdinal > cursorPosition);

    if (disableCursorFilter) {
      if (newEvents.length === 0) {
        return {
          status: 'stable',
          exhausted: true,
          newPosition: timeline.ordinal,
          events: [],
          threadFingerprint: timeline.fingerprint,
          threadOrdinal: timeline.ordinal,
        };
      }
      const normalized = newEvents.map(event => normalizeCanonicalEvent(this.provider, resource, timeline, event));
      return {
        status: 'stable',
        exhausted: timeline.ordinal === newEvents[newEvents.length - 1]!.endOrdinal,
        newPosition: newEvents[newEvents.length - 1]!.endOrdinal,
        events: normalized,
        threadFingerprint: timeline.fingerprint,
        threadOrdinal: timeline.ordinal,
      };
    }

    if (newEvents.length === 0) {
      const tailIncomplete = isTailIncomplete(allEvents, timeline.entries);
      return {
        status: tailIncomplete ? 'pending' : 'stable',
        exhausted: !tailIncomplete,
        newPosition: timeline.ordinal,
        events: [],
        threadFingerprint: timeline.fingerprint,
        threadOrdinal: timeline.ordinal,
      };
    }

    if (isTailIncomplete(allEvents, timeline.entries)) {
      return {
        status: 'pending',
        exhausted: false,
        newPosition: cursorPosition,
        events: [],
        threadFingerprint: timeline.fingerprint,
        threadOrdinal: timeline.ordinal,
      };
    }

    const head = await this.headFrontmatterAsync(resource, signal);
    if (head.ordinal !== timeline.ordinal || head.fingerprint !== timeline.fingerprint) {
      return {
        status: 'pending',
        exhausted: false,
        newPosition: cursorPosition,
        events: [],
        threadFingerprint: timeline.fingerprint,
        threadOrdinal: timeline.ordinal,
      };
    }

    const normalized = newEvents.map(event => normalizeCanonicalEvent(this.provider, resource, timeline, event));
    return {
      status: 'stable',
      exhausted: timeline.ordinal === newEvents[newEvents.length - 1]!.endOrdinal,
      newPosition: newEvents[newEvents.length - 1]!.endOrdinal,
      events: normalized,
      threadFingerprint: timeline.fingerprint,
      threadOrdinal: timeline.ordinal,
    };
  }

  private ensureVersion(): void {
    if (!this.checkVersion || this.versionChecked) return;
    this.versionChecked = true;
    try {
      const stdout = this.invoke('version', ['--version']);
      const version = stdout.trim();
      if (version) this.versionCache = version;
    } catch {
      // Version is diagnostic only; a failure never blocks discovery or admission.
    }
  }

  private invoke(kind: XurlCommandKind, args: readonly string[]): string {
    try {
      const stdout = execFileSync(this.command, args, {
        cwd: this.cwd,
        env: this.env,
        encoding: 'utf8',
        timeout: this.timeoutMs,
        maxBuffer: this.maxOutputBytes,
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as string;
      return stdout;
    } catch (error) {
      throw mapXurlProcessError(kind, error, this.timeoutMs, this.maxOutputBytes);
    }
  }

  private async invokeAsync(
    kind: XurlCommandKind,
    args: readonly string[],
    signal: AbortSignal,
  ): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const child = execFile(
        this.command,
        args,
        {
          cwd: this.cwd,
          env: this.env,
          encoding: 'utf8',
          timeout: this.timeoutMs,
          maxBuffer: this.maxOutputBytes,
          signal,
        },
        (error, stdout, stderr) => {
          if (signal.aborted) {
            reject(new Error(`xurl ${kind} aborted`));
            return;
          }
          if (error) {
            reject(
              mapXurlProcessError(
                kind,
                {
                  ...(error as object),
                  stderr,
                },
                this.timeoutMs,
                this.maxOutputBytes,
              ),
            );
            return;
          }
          resolve(stdout as string);
        },
      );
      child.stdin?.end();
    });
  }
}

// ---------------------------------------------------------------------------
// Rendered-Timeline canonicalization and identity derivation.
// ---------------------------------------------------------------------------

function canonicalizeEvents(timeline: RenderedTimeline): readonly CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  const entries = timeline.entries;
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i]!;
    if (entry.role === 'Assistant') {
      throw new Error(`xurl timeline entry ${entry.ordinal} is an Assistant without a preceding User`);
    }
    if (entry.role === 'User') {
      const next = entries[i + 1];
      if (!next || next.role !== 'Assistant') {
        // Incomplete tail: a User with no following Assistant. The caller treats
        // this range as pending; it is not an error until a second observation.
        break;
      }
      events.push(buildCanonicalEvent(timeline, [], entry, next));
      i += 2;
      continue;
    }
    // Context Compacted: collect a bounded run of context entries then a User+Assistant.
    const context: RenderedThreadEntry[] = [];
    while (i < entries.length && entries[i]!.role === 'Context Compacted') {
      context.push(entries[i]!);
      i += 1;
    }
    const user = entries[i];
    if (!user || user.role !== 'User') {
      if (!user) break; // trailing context with no user — incomplete tail
      throw new Error(`xurl timeline Context Compacted at ordinal ${context[0]!.ordinal} not followed by a User`);
    }
    const assistant = entries[i + 1];
    if (!assistant || assistant.role !== 'Assistant') {
      break; // incomplete tail after context+user
    }
    events.push(buildCanonicalEvent(timeline, context, user, assistant));
    i += 2;
  }
  return events;
}

function buildCanonicalEvent(
  timeline: RenderedTimeline,
  context: readonly RenderedThreadEntry[],
  user: RenderedThreadEntry,
  assistant: RenderedThreadEntry,
): CanonicalEvent {
  if (user.ordinal >= assistant.ordinal) {
    throw new Error(`xurl timeline event ordinals out of order at ${user.ordinal}`);
  }
  const userContent = normalizeEntryContent(user.content);
  const assistantContent = normalizeEntryContent(assistant.content);
  if (!userContent) {
    throw new Error(`xurl timeline entry ${user.ordinal} has an empty User message`);
  }
  if (!assistantContent) {
    throw new Error(`xurl timeline entry ${assistant.ordinal} has an empty Assistant message`);
  }
  const contextContent = context.map(entry => normalizeEntryContent(entry.content)).filter(Boolean);
  const contentHash = computeContentHash([
    ...context.map(entry => ({ role: entry.role, content: normalizeEntryContent(entry.content) })),
    { role: user.role, content: userContent },
    { role: assistant.role, content: assistantContent },
  ]);
  return {
    startOrdinal: (context[0] ?? user).ordinal,
    endOrdinal: assistant.ordinal,
    userContent,
    assistantContent,
    contextContent,
    contentHash,
  };
}

function isTailIncomplete(events: readonly CanonicalEvent[], entries: readonly RenderedThreadEntry[]): boolean {
  if (entries.length === 0) return false;
  const last = entries[entries.length - 1]!;
  if (last.role === 'Assistant') return false;
  // A trailing User or Context Compacted (without a completing Assistant) is incomplete.
  return true;
}

function normalizeCanonicalEvent(
  provider: string,
  resource: SessionLogSourceResource,
  timeline: RenderedTimeline,
  event: CanonicalEvent,
): XurlNormalizedEvent {
  const identity: SourceEventIdentity = {
    eventId: canonicalEventId(provider, timeline.threadId, event.startOrdinal, event.endOrdinal),
    position: event.endOrdinal,
    conversationId: timeline.threadId,
    branchId: timeline.branch,
    contentHash: event.contentHash,
    ...(timeline.revision ? { revision: timeline.revision } : {}),
  };
  return {
    identity,
    distillationUnit: buildDistillationUnit(provider, resource.resourceRef, timeline, event),
    byteLength: Buffer.byteLength(event.userContent + event.assistantContent + event.contextContent.join(''), 'utf8'),
  };
}

function canonicalEventId(provider: string, threadId: string, startOrdinal: number, endOrdinal: number): string {
  return `agents://${provider}/${threadId}#${startOrdinal}-${endOrdinal}`;
}

function buildDistillationUnit(
  provider: string,
  resourceRef: string,
  timeline: RenderedTimeline,
  event: CanonicalEvent,
): DistillationUnit {
  const sessionId = `external:${provider}:${timeline.threadId}:${timeline.branch}`;
  const turn: SessionTurnLogEntry = {
    entry_type: 'turn',
    turn: event.endOrdinal,
    timestamp: requireIsoTimestamp('xurl timeline queried_at', timeline.queriedAt),
    session_id: sessionId,
    session_type: 'external',
    user: { text: event.userContent },
    assistant: {
      text: event.assistantContent,
      tool_calls: [],
    },
    tokens: {
      prompt: 0,
      completion: 0,
    },
  };

  return {
    filePath: `xurl://${provider}/${encodeURIComponent(resourceRef)}`,
    newTurns: [turn],
    continuityTurns: [],
    byteRange: {
      start: event.startOrdinal,
      end: event.endOrdinal,
    },
    generatedAt: turn.timestamp,
  };
}

function computeContentHash(entries: readonly { readonly role: string; readonly content: string }[]): string {
  const payload = entries.map(entry => `${entry.role}|${entry.content}`).join('\n');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Strict rendered-document parsers.
//
// xURL renders Markdown with a YAML-scalar frontmatter (`---` delimited) and a
// structured body. The parser is intentionally strict: frontmatter must be
// scalar `key: value` lines, the catalog body must list `## Thread <id>` blocks
// with scalar metadata, and the Timeline body must contain contiguous numbered
// `### <n> <Role>` headings using only User, Assistant, or Context Compacted.
// Any ambiguity, mismatch, non-contiguity, overflow, timeout, or non-zero exit
// fails closed within the source lane.
// ---------------------------------------------------------------------------

interface ParsedDocument {
  readonly frontmatter: RenderedFrontmatter;
  readonly body: string;
}

function parseDocument(stdout: string, label: string): ParsedDocument {
  const text = stdout.replace(/^\uFEFF/, '');
  if (!text.trim()) {
    throw new Error(`${label} produced an empty response`);
  }
  const openIndex = text.indexOf('\n---\n');
  if (!text.startsWith('---\n') || openIndex < 0) {
    throw new Error(`${label} is missing a valid frontmatter block`);
  }
  const frontmatterRaw = text.slice(4, openIndex);
  const body = text.slice(openIndex + 5);
  return {
    frontmatter: parseFrontmatter(frontmatterRaw, label),
    body,
  };
}

function parseFrontmatter(raw: string, label: string): RenderedFrontmatter {
  const fields = new Map<string, string>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!match) {
      throw new Error(`${label} frontmatter has an invalid line: ${truncateLine(line, 120)}`);
    }
    const key = match[1]!;
    const value = match[2]!.trim();
    if (fields.has(key)) {
      throw new Error(`${label} frontmatter has a duplicate field: ${key}`);
    }
    fields.set(key, value);
  }
  return { fields, raw };
}

function parseFrontmatterOnly(stdout: string, label: string): RenderedFrontmatter {
  const text = stdout.replace(/^\uFEFF/, '');
  if (!text.trim()) {
    throw new Error(`${label} produced an empty response`);
  }
  if (!text.startsWith('---\n')) {
    throw new Error(`${label} is missing a valid frontmatter block`);
  }
  const end = text.indexOf('\n---\n');
  if (end < 0) {
    // A head response may end immediately after the closing `---` with no body.
    const closeLine = text.indexOf('\n---');
    if (closeLine < 0) {
      throw new Error(`${label} is missing a closing frontmatter delimiter`);
    }
    return parseFrontmatter(text.slice(4, closeLine), label);
  }
  return parseFrontmatter(text.slice(4, end), label);
}

function parseRenderedCatalog(stdout: string, provider: string, requestedUri: string): RenderedCatalog {
  const doc = parseDocument(stdout, 'xurl catalog');
  const uri = requireFrontmatterField(doc.frontmatter, 'uri');
  if (uri !== requestedUri) {
    throw new Error(`xurl catalog uri mismatch: expected ${requestedUri}`);
  }
  const catalogProvider = requireFrontmatterField(doc.frontmatter, 'provider');
  if (catalogProvider !== provider) {
    throw new Error(`xurl catalog provider mismatch: expected ${provider}, got ${catalogProvider}`);
  }
  const nextRaw = optionalFrontmatterField(doc.frontmatter, 'next');
  const next = nextRaw && nextRaw.trim() ? nextRaw.trim() : null;
  const threadsValue = optionalFrontmatterField(doc.frontmatter, 'threads');
  const declaredCount = threadsValue ? normalizeNonNegativeInteger(Number(threadsValue), 'xurl catalog threads') : undefined;

  const body = stripAfter(doc.body, /^## Threads\b/m, 'xurl catalog Threads section');
  const threads: RenderedThreadSummary[] = [];
  for (const block of splitThreadBlocks(body)) {
    threads.push(parseThreadSummary(block, provider));
  }
  if (declaredCount !== undefined && declaredCount !== threads.length) {
    throw new Error(`xurl catalog threads count mismatch: frontmatter=${declaredCount} body=${threads.length}`);
  }
  return { provider, uri, next, threads };
}

function parseThreadSummary(block: string, provider: string): RenderedThreadSummary {
  const firstLine = block.split('\n', 1)[0] ?? '';
  const match = /^## Thread (\S+)\s*$/.exec(firstLine);
  if (!match) {
    throw new Error(`xurl catalog has an invalid thread heading: ${truncateLine(block.split('\n')[0] ?? '', 120)}`);
  }
  const threadId = match[1]!;
  const fields = parseScalarLines(block.slice(match[0]!.length), 'xurl catalog thread block');
  const uri = requireScalarField(fields, 'uri', 'xurl catalog thread uri');
  const expectedUri = `agents://${provider}/${threadId}`;
  if (uri !== expectedUri) {
    throw new Error(`xurl catalog thread uri mismatch: expected ${expectedUri}, got ${uri}`);
  }
  const branch = requireScalarField(fields, 'branch', 'xurl catalog thread branch');
  const ordinal = normalizeNonNegativeInteger(Number(requireScalarField(fields, 'ordinal', 'xurl catalog thread ordinal')), 'xurl catalog thread ordinal');
  const fingerprint = requireNonEmptyText('xurl catalog thread fingerprint', requireScalarField(fields, 'fingerprint', 'xurl catalog thread fingerprint'));
  const revision = optionalScalarField(fields, 'revision');
  return { threadId, uri, branch, ordinal, fingerprint, ...(revision ? { revision } : {}) };
}

function parseRenderedTimeline(
  stdout: string,
  provider: string,
  threadId: string,
  requestedUri: string,
): RenderedTimeline {
  const doc = parseDocument(stdout, 'xurl timeline');
  const uri = requireFrontmatterField(doc.frontmatter, 'uri');
  if (uri !== requestedUri) {
    throw new Error(`xurl timeline uri mismatch: expected ${requestedUri}`);
  }
  const timelineProvider = requireFrontmatterField(doc.frontmatter, 'provider');
  if (timelineProvider !== provider) {
    throw new Error(`xurl timeline provider mismatch: expected ${provider}, got ${timelineProvider}`);
  }
  const frontThread = requireFrontmatterField(doc.frontmatter, 'thread');
  if (frontThread !== threadId) {
    throw new Error(`xurl timeline thread mismatch: expected ${threadId}, got ${frontThread}`);
  }
  const branch = requireFrontmatterField(doc.frontmatter, 'branch');
  const ordinal = normalizeNonNegativeInteger(Number(requireFrontmatterField(doc.frontmatter, 'ordinal')), 'xurl timeline ordinal');
  const fingerprint = requireNonEmptyText('xurl timeline fingerprint', requireFrontmatterField(doc.frontmatter, 'fingerprint'));
  const revision = optionalFrontmatterField(doc.frontmatter, 'revision');
  const queriedAt = requireFrontmatterField(doc.frontmatter, 'queried_at');

  const body = stripAfter(doc.body, /^## Timeline\s*$/m, 'xurl timeline Timeline section');
  const entries = parseTimelineEntries(body);

  return {
    provider,
    threadId,
    uri,
    branch,
    ordinal,
    fingerprint,
    ...(revision ? { revision } : {}),
    queriedAt,
    entries,
  } as RenderedTimeline;
}

function parseTimelineEntries(body: string): readonly RenderedThreadEntry[] {
  const entries: RenderedThreadEntry[] = [];
  const lines = body.split('\n');
  let i = 0;
  let expectedOrdinal = 1;
  while (i < lines.length) {
    const line = lines[i]!;
    const match = /^### (\d+) (\S.*?)(?:\s*)$/.exec(line);
    if (!match) {
      if (line.trim() === '') { i += 1; continue; }
      // Lines outside a numbered heading before the first heading are ignored;
      // lines after a heading belong to that heading's content (handled below).
      if (entries.length === 0) { i += 1; continue; }
      // Unknown structural line after entries started — fail closed.
      if (line.startsWith('#')) {
        throw new Error(`xurl timeline has an unrecognized heading: ${truncateLine(line, 120)}`);
      }
      i += 1;
      continue;
    }
    const ordinal = normalizeNonNegativeInteger(Number(match[1]!), 'xurl timeline ordinal');
    const role = parseTimelineRole(match[2]!.trim());
    if (ordinal !== expectedOrdinal) {
      throw new Error(`xurl timeline ordinals are not contiguous: expected ${expectedOrdinal}, got ${ordinal}`);
    }
    // Collect content lines until the next `### ` heading or EOF.
    const contentLines: string[] = [];
    i += 1;
    while (i < lines.length && !/^### \d+ /.test(lines[i]!)) {
      contentLines.push(lines[i]!);
      i += 1;
    }
    const content = contentLines.join('\n').replace(/\n+$/, '');
    entries.push({ ordinal, role, content });
    expectedOrdinal += 1;
  }
  if (entries.length === 0) {
    throw new Error('xurl timeline has no numbered Timeline entries');
  }
  return entries;
}

function parseTimelineRole(value: string): TimelineRole {
  if (value === 'User' || value === 'Assistant' || value === 'Context Compacted') return value;
  throw new Error(`xurl timeline entry has an unsupported role: ${value}`);
}

// ---------------------------------------------------------------------------
// Frontmatter / scalar-line parsing helpers.
// ---------------------------------------------------------------------------

function requireFrontmatterField(frontmatter: RenderedFrontmatter, key: string): string {
  const value = frontmatter.fields.get(key);
  if (value === undefined) {
    throw new Error(`xurl frontmatter is missing required field: ${key}`);
  }
  return value;
}

function optionalFrontmatterField(frontmatter: RenderedFrontmatter, key: string): string | undefined {
  return frontmatter.fields.get(key);
}

function parseScalarLines(raw: string, label: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!match) {
      throw new Error(`${label} has an invalid metadata line: ${truncateLine(line, 120)}`);
    }
    const key = match[1]!;
    const value = match[2]!.trim();
    if (fields.has(key)) {
      throw new Error(`${label} has a duplicate field: ${key}`);
    }
    fields.set(key, value);
  }
  return fields;
}

function requireScalarField(fields: Map<string, string>, key: string, label: string): string {
  const value = fields.get(key);
  if (value === undefined) {
    throw new Error(`${label} is missing required field: ${key}`);
  }
  return value;
}

function optionalScalarField(fields: Map<string, string>, key: string): string | undefined {
  return fields.get(key);
}

function splitThreadBlocks(body: string): string[] {
  const blocks: string[] = [];
  const lines = body.split('\n');
  let current: string[] | null = null;
  for (const line of lines) {
    if (/^## Thread \S+/.test(line)) {
      if (current) blocks.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current.join('\n'));
  return blocks;
}

function stripAfter(body: string, marker: RegExp, label: string): string {
  const match = marker.exec(body);
  if (!match) {
    throw new Error(`${label} is missing`);
  }
  return body.slice(match.index! + match[0]!.length);
}

function normalizeEntryContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

// ---------------------------------------------------------------------------
// Process error mapping (fail-closed within the source lane).
// ---------------------------------------------------------------------------

function mapXurlProcessError(kind: XurlCommandKind, error: unknown, timeoutMs: number, maxOutputBytes: number): Error {
  const candidate = error as {
    code?: string | number | null;
    status?: number | null;
    signal?: string | null;
    killed?: boolean;
    stderr?: string | Buffer;
    message?: string;
  };
  if (candidate?.code === 'ENOBUFS') {
    return new Error(`xurl ${kind} output exceeded ${maxOutputBytes} bytes`);
  }
  if (
    candidate?.code === 'ETIMEDOUT'
    || candidate?.signal === 'SIGTERM'
    || candidate?.signal === 'SIGKILL'
    || candidate?.killed === true
  ) {
    return new Error(`xurl ${kind} timed out after ${timeoutMs}ms`);
  }
  const stderr = typeof candidate?.stderr === 'string'
    ? candidate.stderr
    : Buffer.isBuffer(candidate?.stderr)
      ? candidate.stderr.toString('utf8')
      : '';
  const detail = truncateLine((stderr || candidate?.message || '').trim(), 240);
  const exitStatus = candidate?.status ?? candidate?.code ?? 'unknown';
  return new Error(`xurl ${kind} exited with status ${String(exitStatus)}${detail ? `: ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// Shared validation helpers.
// ---------------------------------------------------------------------------

function resolveActivationLimit(
  option: number | undefined,
  envKey: string,
  fallback: number,
  label: string,
): number {
  if (option !== undefined) return normalizePositiveInteger(option, fallback, label);
  const envValue = process.env[envKey];
  if (envValue !== undefined && envValue !== '') {
    return normalizePositiveInteger(Number(envValue), fallback, label);
  }
  return fallback;
}

function normalizePositiveInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Math.floor(value);
}

function normalizeNonNegativeInteger(value: unknown, label: string): number {
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num) || num < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return Math.floor(num);
}

function requireNonEmptyText(label: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  const text = value.trim();
  if (!text) {
    throw new Error(`${label} must be non-empty`);
  }
  if (text.includes('\u0000')) {
    throw new Error(`${label} must not contain NUL`);
  }
  return text;
}

function requireIsoTimestamp(label: string, value: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function truncateLine(value: string, maxLength: number): string {
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

// Exported for deterministic tests that need to assert identity derivation
// without depending on xURL internals.
export const XURL_TEST_HELPERS = {
  canonicalEventId,
  computeContentHash,
  isXurlActivationBlockedError,
  parseRenderedCatalog,
  parseRenderedTimeline,
  parseFrontmatterOnly,
};