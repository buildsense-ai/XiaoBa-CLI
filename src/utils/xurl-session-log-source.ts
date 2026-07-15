import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { DistillationUnit } from './distillation-unit';
import {
  ExternalSourceActivationResource,
  ExternalSourceIncrementalDiscoveryRequest,
  ExternalSourceIncrementalDiscoveryResult,
  ExternalSourceHistorySampleResult,
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
import { getXurlVersion } from './xurl-compatibility';
import {
  parseRenderedDocument as parseRenderedMarkdownDocument,
  parseRenderedFrontmatterOnly,
  parseRenderedTimeline as parseRenderedTimelineContract,
  type ParsedRenderedFrontmatter,
  type RenderedTimelineEvent,
} from './xurl-rendered-timeline';

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

type RenderedFrontmatter = ParsedRenderedFrontmatter;

interface RenderedThreadSummary {
  readonly threadId: string;
  readonly uri: string;
  readonly branch: string;
  readonly ordinal: number;
  readonly fingerprint: string;
  readonly revision?: string;
  readonly baselineComplete: boolean;
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
  readonly hasExplicitStabilityMetadata: boolean;
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
  readonly scope?: 'global' | 'path';
  readonly scopePath?: string;
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

interface ParsedTimelinePage {
  readonly timeline: RenderedTimeline;
  readonly events: readonly CanonicalEvent[];
  readonly hasIncompleteTail: boolean;
}

interface XurlNormalizedEvent {
  readonly identity: SourceEventIdentity;
  readonly distillationUnit: DistillationUnit;
  readonly byteLength: number;
}

interface XurlHistorySamplePage {
  readonly status: 'stable' | 'pending';
  readonly events: readonly XurlNormalizedEvent[];
  readonly newPosition: number;
  readonly observedPosition: number;
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

    const knownResourceRefs = new Set(request.knownResourceRefs ?? []);
    const summaries = catalog.threads.map(summary => (
      summary.baselineComplete || knownResourceRefs.has(summary.threadId)
        ? summary
        : this.runner.inspectThreadForActivation(summary)
    ));
    this.runner.checkActivationLimits({ ...catalog, threads: summaries });

    const resources: SessionLogSourceResource[] = summaries.map(summary => ({
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
    const activationResources: ExternalSourceActivationResource[] = summaries.map((summary, index) => ({
      resource: resources[index]!,
      activationPosition: summary.ordinal,
    }));
    return {
      resources,
      activationResources,
      nextPageToken: catalog.next,
      activationWatermarkPosition: summaries.length > 0
        ? Math.max(...summaries.map(thread => thread.ordinal))
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

  sampleHistory(resource: SessionLogSourceResource): ExternalSourceHistorySampleResult {
    return toExternalHistorySample(this.runner.sampleHistoryTimeline(resource));
  }

  async sampleHistoryAsync(
    resource: SessionLogSourceResource,
    signal: AbortSignal,
  ): Promise<ExternalSourceHistorySampleResult> {
    return toExternalHistorySample(await this.runner.sampleHistoryTimelineAsync(resource, signal));
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
  private readonly scope: 'global' | 'path';
  private readonly scopePath?: string;
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
    this.scope = options.scope === 'path' ? 'path' : 'global';
    this.scopePath = this.scope === 'path'
      ? requireNonEmptyText('xurl scopePath', options.scopePath)
      : undefined;
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

  private buildCatalogUri(limit: number, pageToken: string | null): string {
    if (this.scope === 'path') {
      const params = new URLSearchParams({
        providers: this.provider,
        limit: String(limit),
      });
      if (pageToken) params.set('cursor', pageToken);
      return `agents://${this.scopePath}?${params.toString()}`;
    }

    const params = new URLSearchParams({ limit: String(limit) });
    if (pageToken) params.set('cursor', pageToken);
    return `agents://${this.provider}?${params.toString()}`;
  }

  queryCatalog(limit: number, pageToken: string | null): RenderedCatalog {
    this.ensureVersion();
    if (this.activationStartedAt === 0) this.activationStartedAt = Date.now();
    const uri = this.buildCatalogUri(limit, pageToken);
    const stdout = this.invoke('query', [uri]);
    this.activationBytesAccum += Buffer.byteLength(stdout, 'utf8');
    return parseRenderedCatalog(stdout, this.provider, uri);
  }

  inspectThreadForActivation(summary: RenderedThreadSummary): RenderedThreadSummary {
    const stdout = this.invoke('read', [summary.uri]);
    this.activationBytesAccum += Buffer.byteLength(stdout, 'utf8');
    this.checkActivationLimits({
      provider: this.provider,
      uri: summary.uri,
      next: null,
      threads: [summary],
    });
    const page = parseTimelinePage(stdout, this.provider, summary.threadId, summary.uri);
    return {
      ...summary,
      branch: page.timeline.branch,
      ordinal: page.timeline.ordinal,
      fingerprint: page.timeline.fingerprint,
      ...(page.timeline.revision ? { revision: page.timeline.revision } : {}),
      baselineComplete: true,
    };
  }

  readThreadTimeline(
    resource: SessionLogSourceResource,
    cursor: SourceCursor,
    disableCursorFilter: boolean,
  ): XurlNormalizedReadPage {
    const uri = `agents://${this.provider}/${requireNonEmptyText('xurl thread', resource.resourceRef)}`;
    const stdout = this.invoke('read', [uri]);
    const page = parseTimelinePage(stdout, this.provider, resource.resourceRef, uri);
    const { timeline, events: allEvents, hasIncompleteTail } = page;

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
      return {
        status: hasIncompleteTail ? 'pending' : 'stable',
        exhausted: !hasIncompleteTail,
        newPosition: timeline.ordinal,
        events: [],
        threadFingerprint: timeline.fingerprint,
        threadOrdinal: timeline.ordinal,
      };
    }

    // A newly observed tail requires two identical bounded observations before
    // the durable cursor may advance. Older rendered contracts expose ordinal
    // and fingerprint through `-I`; current official xURL derives both from a
    // second Timeline rendering. (ADR-0043 stability sampling.)
    if (hasIncompleteTail) {
      return {
        status: 'pending',
        exhausted: false,
        newPosition: cursorPosition,
        events: [],
        threadFingerprint: timeline.fingerprint,
        threadOrdinal: timeline.ordinal,
      };
    }

    const head = timeline.hasExplicitStabilityMetadata
      ? this.headFrontmatter(resource)
      : this.confirmTimeline(resource);
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

  sampleHistoryTimeline(resource: SessionLogSourceResource): XurlHistorySamplePage {
    const uri = `agents://${this.provider}/${requireNonEmptyText('xurl thread', resource.resourceRef)}`;
    const first = parseTimelinePage(this.invoke('read', [uri]), this.provider, resource.resourceRef, uri);
    const second = parseTimelinePage(this.invoke('read', [uri]), this.provider, resource.resourceRef, uri);
    return buildXurlHistorySample(this.provider, resource, first, second);
  }

  async sampleHistoryTimelineAsync(
    resource: SessionLogSourceResource,
    signal: AbortSignal,
  ): Promise<XurlHistorySamplePage> {
    const uri = `agents://${this.provider}/${requireNonEmptyText('xurl thread', resource.resourceRef)}`;
    const first = parseTimelinePage(
      await this.invokeAsync('read', [uri], signal),
      this.provider,
      resource.resourceRef,
      uri,
    );
    const second = parseTimelinePage(
      await this.invokeAsync('read', [uri], signal),
      this.provider,
      resource.resourceRef,
      uri,
    );
    return buildXurlHistorySample(this.provider, resource, first, second);
  }

  private headFrontmatter(resource: SessionLogSourceResource): {
    readonly ordinal: number;
    readonly fingerprint: string;
  } {
    const uri = `agents://${this.provider}/${requireNonEmptyText('xurl thread', resource.resourceRef)}`;
    const stdout = this.invoke('head', ['-I', uri]);
    const frontmatter = parseRenderedFrontmatterOnly(stdout, 'xurl head response');
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

  private confirmTimeline(resource: SessionLogSourceResource): {
    readonly ordinal: number;
    readonly fingerprint: string;
  } {
    const uri = `agents://${this.provider}/${requireNonEmptyText('xurl thread', resource.resourceRef)}`;
    const stdout = this.invoke('read', [uri]);
    const page = parseTimelinePage(stdout, this.provider, resource.resourceRef, uri);
    return {
      ordinal: page.timeline.ordinal,
      fingerprint: page.timeline.fingerprint,
    };
  }

  private async headFrontmatterAsync(
    resource: SessionLogSourceResource,
    signal: AbortSignal,
  ): Promise<{ readonly ordinal: number; readonly fingerprint: string }> {
    const uri = `agents://${this.provider}/${requireNonEmptyText('xurl thread', resource.resourceRef)}`;
    const stdout = await this.invokeAsync('head', ['-I', uri], signal);
    const frontmatter = parseRenderedFrontmatterOnly(stdout, 'xurl head response');
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

  private async confirmTimelineAsync(
    resource: SessionLogSourceResource,
    signal: AbortSignal,
  ): Promise<{ readonly ordinal: number; readonly fingerprint: string }> {
    const uri = `agents://${this.provider}/${requireNonEmptyText('xurl thread', resource.resourceRef)}`;
    const stdout = await this.invokeAsync('read', [uri], signal);
    const page = parseTimelinePage(stdout, this.provider, resource.resourceRef, uri);
    return {
      ordinal: page.timeline.ordinal,
      fingerprint: page.timeline.fingerprint,
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
    const page = parseTimelinePage(stdout, this.provider, resource.resourceRef, uri);
    const { timeline, events: allEvents, hasIncompleteTail } = page;

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
      return {
        status: hasIncompleteTail ? 'pending' : 'stable',
        exhausted: !hasIncompleteTail,
        newPosition: timeline.ordinal,
        events: [],
        threadFingerprint: timeline.fingerprint,
        threadOrdinal: timeline.ordinal,
      };
    }

    if (hasIncompleteTail) {
      return {
        status: 'pending',
        exhausted: false,
        newPosition: cursorPosition,
        events: [],
        threadFingerprint: timeline.fingerprint,
        threadOrdinal: timeline.ordinal,
      };
    }

    const head = timeline.hasExplicitStabilityMetadata
      ? await this.headFrontmatterAsync(resource, signal)
      : await this.confirmTimelineAsync(resource, signal);
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
    const diagnostic = getXurlVersion(this.command, {
      timeoutMs: this.timeoutMs,
      env: this.env,
    });
    if (diagnostic.source === 'cli' && diagnostic.rawVersion) {
      this.versionCache = diagnostic.rawVersion;
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

function buildXurlHistorySample(
  provider: string,
  resource: SessionLogSourceResource,
  first: ParsedTimelinePage,
  second: ParsedTimelinePage,
): XurlHistorySamplePage {
  const firstPrefix = JSON.stringify([
    first.timeline.threadId,
    first.timeline.branch,
    first.events.map(event => [event.startOrdinal, event.endOrdinal, event.contentHash]),
  ]);
  const secondPrefix = JSON.stringify([
    second.timeline.threadId,
    second.timeline.branch,
    second.events.map(event => [event.startOrdinal, event.endOrdinal, event.contentHash]),
  ]);
  const stable = firstPrefix === secondPrefix;
  const events = stable
    ? second.events.map(event => normalizeCanonicalEvent(provider, resource, second.timeline, event))
    : [];
  return {
    status: stable ? 'stable' : 'pending',
    events,
    newPosition: events.length > 0 ? events[events.length - 1]!.identity.position : -1,
    observedPosition: Math.max(first.timeline.ordinal, second.timeline.ordinal),
  };
}

function toExternalHistorySample(page: XurlHistorySamplePage): ExternalSourceHistorySampleResult {
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
    exhausted: page.status === 'stable',
    newPosition: page.newPosition,
    observedPosition: page.observedPosition,
    byteLength: page.events.reduce((sum, event) => sum + event.byteLength, 0),
  };
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

function parseRenderedCatalog(stdout: string, provider: string, requestedUri: string): RenderedCatalog {
  const doc = parseRenderedMarkdownDocument(stdout, 'xurl catalog');
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

  const threads = /^## Threads\b/m.test(doc.body)
    ? splitThreadBlocks(stripAfter(doc.body, /^## Threads\b/m, 'xurl catalog Threads section'))
      .map(block => parseThreadSummary(block, provider))
    : parseOfficialThreadSummaries(doc.body, provider);
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
  return {
    threadId,
    uri,
    branch,
    ordinal,
    fingerprint,
    ...(revision ? { revision } : {}),
    baselineComplete: true,
  };
}

function parseOfficialThreadSummaries(body: string, provider: string): RenderedThreadSummary[] {
  const section = stripAfter(body, /^# Threads\s*$/m, 'xurl catalog Threads section');
  const matchedRaw = /^- Matched:\s+`(\d+)`\s*$/m.exec(section)?.[1];
  const declaredCount = matchedRaw === undefined
    ? undefined
    : normalizeNonNegativeInteger(Number(matchedRaw), 'xurl catalog matched threads');
  const heading = /^##\s+(\d+)\.\s+`([^`]+)`\s*$/gm;
  const matches = [...section.matchAll(heading)];
  const threads = matches.map((match, index) => {
    const expectedIndex = index + 1;
    if (Number(match[1]) !== expectedIndex) {
      throw new Error(`xurl catalog thread numbering is non-contiguous at ${match[1]}`);
    }
    const uri = requireNonEmptyText('xurl catalog thread uri', match[2]);
    const prefix = `agents://${provider}/`;
    if (!uri.startsWith(prefix) || uri.length === prefix.length) {
      throw new Error(`xurl catalog thread uri does not belong to provider ${provider}: ${uri}`);
    }
    const threadId = uri.slice(prefix.length);
    const blockStart = (match.index ?? 0) + match[0].length;
    const blockEnd = matches[index + 1]?.index ?? section.length;
    const fields = parseRenderedCatalogBulletFields(section.slice(blockStart, blockEnd));
    const fieldProvider = fields.get('Provider');
    const fieldThreadId = fields.get('Thread ID');
    if (fieldProvider !== provider) {
      throw new Error(`xurl catalog thread provider mismatch: expected ${provider}, got ${fieldProvider ?? 'missing'}`);
    }
    if (fieldThreadId !== threadId) {
      throw new Error(`xurl catalog thread id mismatch: expected ${threadId}, got ${fieldThreadId ?? 'missing'}`);
    }
    const updatedAt = fields.get('Updated At');
    return {
      threadId,
      uri,
      branch: threadId,
      ordinal: 0,
      fingerprint: createHash('sha256').update(`${uri}\n${updatedAt ?? ''}`, 'utf8').digest('hex'),
      ...(updatedAt ? { revision: updatedAt } : {}),
      baselineComplete: false,
    };
  });
  if (declaredCount !== undefined && declaredCount !== threads.length) {
    throw new Error(`xurl catalog matched count mismatch: body=${declaredCount} parsed=${threads.length}`);
  }
  return threads;
}

function parseRenderedCatalogBulletFields(raw: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const match = /^- ([A-Za-z][A-Za-z ]+):\s+`([^`]*)`\s*$/.exec(line);
    if (!match) continue;
    if (fields.has(match[1]!)) {
      throw new Error(`xurl catalog thread block has a duplicate field: ${match[1]}`);
    }
    fields.set(match[1]!, match[2]!);
  }
  return fields;
}

function parseTimelinePage(
  stdout: string,
  provider: string,
  threadId: string,
  requestedUri: string,
): ParsedTimelinePage {
  const parsed = parseRenderedTimelineContract(stdout, provider, threadId, {
    allowIncompleteTail: true,
  });
  if (parsed.uri !== requestedUri) {
    throw new Error(`xurl timeline uri mismatch: expected ${requestedUri}`);
  }
  const branch = parsed.branch;
  if (!branch) {
    throw new Error('xurl timeline branch is missing');
  }
  const ordinal = normalizeNonNegativeInteger(parsed.ordinal, 'xurl timeline ordinal');
  const fingerprint = requireNonEmptyText('xurl timeline fingerprint', parsed.fingerprint);
  const queriedAt = requireNonEmptyText('xurl timeline queried_at', parsed.queriedAt);
  const timeline: RenderedTimeline = {
    provider,
    threadId,
    uri: parsed.uri,
    branch,
    ordinal,
    fingerprint,
    ...(parsed.revision ? { revision: parsed.revision } : {}),
    queriedAt,
    hasExplicitStabilityMetadata: parsed.hasExplicitStabilityMetadata,
  };
  return {
    timeline,
    hasIncompleteTail: parsed.hasIncompleteTail,
    events: parsed.events.map(toCanonicalEvent),
  };
}

function toCanonicalEvent(event: RenderedTimelineEvent): CanonicalEvent {
  const user = event.roles.find(role => role.role === 'User');
  const assistant = event.roles.find(role => role.role === 'Assistant');
  if (!user || !assistant) {
    throw new Error(`xurl timeline event ${event.identity} is missing a User or Assistant role`);
  }
  const userContent = normalizeEntryContent(user.content);
  const assistantContent = normalizeEntryContent(assistant.content);
  if (!userContent) {
    throw new Error(`xurl timeline entry ${user.ordinal} has an empty User message`);
  }
  if (!assistantContent) {
    throw new Error(`xurl timeline entry ${assistant.ordinal} has an empty Assistant message`);
  }
  return {
    startOrdinal: event.ordinalStart,
    endOrdinal: event.ordinalEnd,
    userContent,
    assistantContent,
    contextContent: event.roles
      .filter(role => role.role === 'Context Compacted')
      .map(role => normalizeEntryContent(role.content))
      .filter(Boolean),
    contentHash: event.contentHash,
  };
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

function computeContentHash(entries: readonly { readonly role: string; readonly content: string }[]): string {
  const payload = entries.map(entry => `${entry.role}:${entry.content}`).join('\n');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
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
  parseRenderedTimeline: parseRenderedTimelineContract,
  parseFrontmatterOnly: parseRenderedFrontmatterOnly,
};
