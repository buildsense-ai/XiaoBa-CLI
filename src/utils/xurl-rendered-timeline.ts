/**
 * Issue #94 — Strict parser for the official xURL rendered Timeline contract
 * (ADR-0043).
 *
 * XiaoBa invokes the unmodified official xURL CLI through its documented
 * `agents://` URI interface and consumes its provider-neutral rendered Timeline.
 * This module validates that rendering and derives canonical external events
 * from the provider identity, thread identity, normalized ordinal range, and
 * content fingerprint.
 *
 * This is the release-gate parser. Issue #90 will wire it into the reader; this
 * module is intentionally standalone so the Timeline contract is testable before
 * and after that integration.
 *
 * Accepted residual risk (ADR-0043): a structurally valid heading sequence
 * embedded at the tail of a message cannot be proven distinguishable from a real
 * Timeline entry without a machine-readable xURL contract. The parser treats any
 * line matching the Timeline heading pattern as a new entry boundary.
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const MAX_RENDERED_TIMELINE_BYTES = 512 * 1024;

export type RenderedTimelineRole = 'User' | 'Assistant' | 'Context Compacted';

/**
 * Non-conversation display roles that xURL may render for runtime chrome.
 * These are excluded from learning evidence and never mapped to User/Assistant.
 * Exported as a frozen list so callers cannot mutate classification policy.
 */
export const EXCLUDED_RENDERED_TIMELINE_ROLES: readonly string[] = Object.freeze([
  'Runtime 启动层',
  'Runtime Startup',
  'Runtime startup',
]);

const EXCLUDED_RENDERED_TIMELINE_ROLE_SET: ReadonlySet<string> = new Set(
  EXCLUDED_RENDERED_TIMELINE_ROLES,
);

/** True when the rendered role is runtime chrome and must not enter learning. */
export function isExcludedRenderedTimelineRole(roleText: string): boolean {
  return EXCLUDED_RENDERED_TIMELINE_ROLE_SET.has(roleText);
}

/**
 * Prompt-control roles that must never become learning evidence.
 * Matching is case-insensitive against the rendered role label.
 */
const FORBIDDEN_RENDERED_TIMELINE_ROLE_RE =
  /^(system|developer|tool(\s+system)?|prompt(\s+control)?|instructions?)$/i;

export interface RenderedTimelineEntry {
  readonly ordinal: number;
  readonly role: RenderedTimelineRole;
  readonly content: string;
}

export interface RenderedTimelineEvent {
  /**
   * Stable identity string derived from provider, thread, branch (when
   * present), and the normalized ordinal range. Suitable for deduplication.
   */
  readonly identity: string;
  /** First ordinal in this User→Assistant range (inclusive). */
  readonly ordinalStart: number;
  /** Last ordinal in this User→Assistant range (inclusive). */
  readonly ordinalEnd: number;
  /** All entries within the range, including Context Compacted context. */
  readonly roles: readonly RenderedTimelineEntry[];
  /**
   * SHA-256 content hash computed over normalized roles and content, not xURL
   * frontmatter or local paths. Used for integrity-conflict detection.
   */
  readonly contentHash: string;
}

export interface RenderedTimelineParseResult {
  readonly provider: string;
  readonly thread: string;
  readonly uri: string;
  readonly branch?: string;
  readonly ordinal?: number;
  readonly fingerprint?: string;
  readonly revision?: string;
  readonly queriedAt?: string;
  /** True when ordinal/fingerprint came from xURL frontmatter rather than the rendered entries. */
  readonly hasExplicitStabilityMetadata: boolean;
  readonly hasIncompleteTail: boolean;
  readonly events: readonly RenderedTimelineEvent[];
}

export interface RenderedTimelineParseOptions {
  readonly allowIncompleteTail?: boolean;
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

interface ParsedFrontmatter {
  readonly uri: string;
  readonly provider: string;
  readonly thread: string;
  readonly branch?: string;
  readonly ordinal?: number;
  readonly fingerprint?: string;
  readonly revision?: string;
  readonly queriedAt?: string;
}

export interface ParsedRenderedFrontmatter {
  readonly fields: ReadonlyMap<string, string>;
  readonly raw: string;
}

export interface ParsedRenderedDocument {
  readonly frontmatter: ParsedRenderedFrontmatter;
  readonly body: string;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const TIMELINE_HEADING_RE = /^#{2,3}\s+(\d+)(?:\.)?\s+(.*?)\s*$/;
const FRONTMATTER_DELIMITER = '---';
const CONVERSATION_ROLES = new Set<RenderedTimelineRole>(['User', 'Assistant', 'Context Compacted']);
const USER_ASSISTANT_JOIN = '\n\n';

export function parseRenderedTimeline(
  markdown: string,
  expectedProvider: string,
  expectedThread: string,
  options: RenderedTimelineParseOptions = {},
): RenderedTimelineParseResult {
  if (!markdown || !markdown.trim()) {
    throw new Error('rendered Timeline input is empty');
  }
  if (Buffer.byteLength(markdown, 'utf8') > MAX_RENDERED_TIMELINE_BYTES) {
    throw new Error(
      `rendered Timeline input exceeds ${MAX_RENDERED_TIMELINE_BYTES} bytes (oversized output)`,
    );
  }

  const document = parseRenderedDocument(markdown, 'rendered Timeline document');
  const frontmatter = parseFrontmatter(document.frontmatter, expectedProvider, expectedThread);
  const body = document.body;
  const timelineSection = extractSection(body, 'Timeline');
  if (!timelineSection) {
    throw new Error('rendered Timeline document must contain a ## Timeline section');
  }

  const entries = parseTimelineEntries(timelineSection);
  const hasExplicitStabilityMetadata = frontmatter.ordinal !== undefined
    && frontmatter.fingerprint !== undefined;
  const effectiveFrontmatter: ParsedFrontmatter = {
    ...frontmatter,
    branch: frontmatter.branch ?? expectedThread,
    ordinal: frontmatter.ordinal ?? entries[entries.length - 1]!.ordinal,
    fingerprint: frontmatter.fingerprint ?? computeContentHash(entries),
  };
  const grouped = groupCanonicalEvents(effectiveFrontmatter, entries, options);

  return {
    provider: effectiveFrontmatter.provider,
    thread: effectiveFrontmatter.thread,
    uri: effectiveFrontmatter.uri,
    branch: effectiveFrontmatter.branch,
    ordinal: effectiveFrontmatter.ordinal,
    fingerprint: effectiveFrontmatter.fingerprint,
    ...(effectiveFrontmatter.revision ? { revision: effectiveFrontmatter.revision } : {}),
    ...(effectiveFrontmatter.queriedAt ? { queriedAt: effectiveFrontmatter.queriedAt } : {}),
    hasExplicitStabilityMetadata,
    hasIncompleteTail: grouped.hasIncompleteTail,
    events: grouped.events,
  };
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

export function parseRenderedDocument(markdown: string, label: string): ParsedRenderedDocument {
  const text = markdown.replace(/^\uFEFF/, '');
  if (!text.trim()) {
    throw new Error(`${label} produced an empty response`);
  }

  const lines = text.split('\n');
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    throw new Error(`${label} is missing a valid frontmatter block`);
  }

  let endLine = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === FRONTMATTER_DELIMITER) {
      endLine = i;
      break;
    }
  }
  if (endLine === -1) {
    throw new Error(`${label} is missing a closing frontmatter delimiter`);
  }

  return {
    frontmatter: parseRenderedFrontmatter(lines.slice(1, endLine).join('\n'), label),
    body: lines.slice(endLine + 1).join('\n'),
  };
}

export function parseRenderedFrontmatterOnly(markdown: string, label: string): ParsedRenderedFrontmatter {
  return parseRenderedDocument(markdown, label).frontmatter;
}

export function parseRenderedFrontmatter(raw: string, label: string): ParsedRenderedFrontmatter {
  const fields = new Map<string, string>();
  let nestedContainer: string | null = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    if (/^\s/.test(line)) {
      if (!nestedContainer) {
        throw new Error(`${label} frontmatter has an unexpected nested line: ${line.trim()}`);
      }
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!match) {
      throw new Error(`${label} frontmatter has an invalid line: ${line.trim()}`);
    }
    const key = match[1]!;
    const value = decodeFrontmatterScalar(match[2]!.trim(), label, key);
    if (fields.has(key)) {
      throw new Error(`${label} frontmatter has a duplicate field: ${key}`);
    }
    fields.set(key, value);
    nestedContainer = value === '' ? key : null;
  }
  return { fields, raw };
}

function parseFrontmatter(
  frontmatter: ParsedRenderedFrontmatter,
  expectedProvider: string,
  expectedThread: string,
): ParsedFrontmatter {
  const fm = Object.fromEntries(frontmatter.fields.entries());

  const uri = fm['uri'];
  if (!uri) {
    throw new Error('rendered Timeline frontmatter must include a uri field');
  }

  const provider = fm['provider'] ?? extractUriProvider(uri);
  const thread = fm['thread'] ?? extractUriThread(uri);

  if (!provider) {
    throw new Error('rendered Timeline frontmatter must include provider (in uri or field)');
  }
  if (!thread) {
    throw new Error('rendered Timeline frontmatter must include thread (in uri or field)');
  }
  if (provider !== expectedProvider) {
    throw new Error(
      `rendered Timeline frontmatter provider mismatch: expected ${expectedProvider}, got ${provider}`,
    );
  }
  if (thread !== expectedThread) {
    throw new Error(
      `rendered Timeline frontmatter thread mismatch: expected ${expectedThread}, got ${thread}`,
    );
  }

  const branch = fm['branch'] || undefined;
  const ordinalRaw = fm['ordinal'];
  const ordinal = ordinalRaw && /^\d+$/.test(ordinalRaw) ? parseInt(ordinalRaw, 10) : undefined;
  const fingerprint = fm['fingerprint'] || undefined;
  const revision = fm['revision'] || undefined;
  const queriedAt = fm['queried_at']
    || extractThreadMetadataTimestamp(frontmatter.raw)
    || undefined;
  return {
    uri,
    provider,
    thread,
    ...(branch ? { branch } : {}),
    ...(ordinal !== undefined ? { ordinal } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(revision ? { revision } : {}),
    ...(queriedAt ? { queriedAt } : {}),
  };
}

function extractUriProvider(uri: string): string | undefined {
  // agents://<provider>/<thread>
  const match = uri.match(/^agents:\/\/([^/]+)\/(.+)$/);
  return match?.[1];
}

function extractUriThread(uri: string): string | undefined {
  const match = uri.match(/^agents:\/\/[^/]+\/(.+)$/);
  return match?.[1];
}

// ---------------------------------------------------------------------------
// Section extraction
// ---------------------------------------------------------------------------

function extractSection(body: string, sectionName: string): string | undefined {
  const headingRe = new RegExp(`^##\\s+${sectionName}\\s*$`, 'm');
  const match = headingRe.exec(body);
  if (!match) return undefined;

  const start = match.index + match[0].length;
  const rest = body.slice(start);

  // xURL renders the Timeline as the terminal body section and message content
  // may legitimately contain arbitrary Markdown headings (including ## ...).
  // Treat the Timeline as extending to EOF rather than truncating on nested
  // headings inside assistant/user content.
  if (sectionName === 'Timeline') {
    return rest.trim();
  }

  const lines = rest.split('\n');
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^##\s+/.test(line) && !/^##\s+\d+\.?(?:\s|$)/.test(line)) {
      return lines.slice(0, index).join('\n').trim();
    }
  }
  return rest.trim();
}

function decodeFrontmatterScalar(value: string, label: string, key: string): string {
  if (value.length < 2) return value;
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      throw new Error(`${label} frontmatter has an invalid quoted scalar: ${key}`);
    }
  }
  return value;
}

function extractThreadMetadataTimestamp(raw: string): string | undefined {
  for (const line of raw.split('\n')) {
    const match = /^\s*-\s*['"]?(?:payload\.)?timestamp\s*=\s*(.+?)['"]?\s*$/.exec(line);
    if (match?.[1]) return match[1].replace(/['"]$/, '').trim();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Timeline entry parsing
// ---------------------------------------------------------------------------

interface RawTimelineEntry {
  readonly ordinal: number;
  readonly roleText: string;
  readonly content: string;
}

function classifyRenderedTimelineRole(roleText: string, ordinal: number): 'conversation' | 'excluded' {
  if (CONVERSATION_ROLES.has(roleText as RenderedTimelineRole)) return 'conversation';
  if (isExcludedRenderedTimelineRole(roleText)) return 'excluded';
  if (FORBIDDEN_RENDERED_TIMELINE_ROLE_RE.test(roleText)) {
    throw new Error(
      `rendered Timeline entry ${ordinal} has forbidden prompt-control role: ${roleText}`,
    );
  }
  throw new Error(
    `rendered Timeline entry ${ordinal} has unsupported role: ${roleText}`,
  );
}

function isRecognizedRenderedTimelineRoleHeading(roleText: string): boolean {
  return CONVERSATION_ROLES.has(roleText as RenderedTimelineRole)
    || isExcludedRenderedTimelineRole(roleText)
    || FORBIDDEN_RENDERED_TIMELINE_ROLE_RE.test(roleText);
}

function parseTimelineEntries(timelineBody: string): readonly RenderedTimelineEntry[] {
  const lines = timelineBody.split('\n');
  const rawEntries: RawTimelineEntry[] = [];
  let currentOrdinal: number | null = null;
  let currentRoleText: string | null = null;
  let contentLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const headingMatch = TIMELINE_HEADING_RE.exec(line);

    if (headingMatch) {
      const ordinal = parseInt(headingMatch[1]!, 10);
      const roleText = headingMatch[2]!.trim();
      const startsNewEntry = currentOrdinal === null
        || isRecognizedRenderedTimelineRoleHeading(roleText);
      if (!startsNewEntry) {
        if (currentOrdinal !== null) contentLines.push(line);
        continue;
      }

      // Flush previous entry
      if (currentOrdinal !== null && currentRoleText !== null) {
        rawEntries.push({
          ordinal: currentOrdinal,
          roleText: currentRoleText,
          content: contentLines.join('\n').trim(),
        });
      }

      if (!roleText) {
        throw new Error(
          `rendered Timeline entry ${ordinal} has an empty role`,
        );
      }

      currentOrdinal = ordinal;
      currentRoleText = roleText;
      contentLines = [];
    } else {
      if (currentOrdinal !== null) {
        contentLines.push(line);
      }
    }
  }

  // Flush final entry
  if (currentOrdinal !== null && currentRoleText !== null) {
    rawEntries.push({
      ordinal: currentOrdinal,
      roleText: currentRoleText,
      content: contentLines.join('\n').trim(),
    });
  }

  if (rawEntries.length === 0) {
    throw new Error('rendered Timeline contains no numbered entries');
  }

  validateOrdinals(rawEntries);

  const entries: RenderedTimelineEntry[] = [];
  for (const raw of rawEntries) {
    const classification = classifyRenderedTimelineRole(raw.roleText, raw.ordinal);
    if (classification === 'excluded') continue;
    entries.push({
      ordinal: raw.ordinal,
      role: raw.roleText as RenderedTimelineRole,
      content: raw.content,
    });
  }

  if (entries.length === 0) {
    throw new Error('rendered Timeline contains no conversation entries after excluding runtime metadata');
  }

  return entries;
}

function validateOrdinals(entries: readonly { readonly ordinal: number }[]): void {
  const seen = new Set<number>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (seen.has(entry.ordinal)) {
      throw new Error(`rendered Timeline has duplicate ordinal: ${entry.ordinal}`);
    }
    seen.add(entry.ordinal);

    if (i === 0 && entry.ordinal !== 1) {
      throw new Error(`rendered Timeline ordinals must start at 1, got ${entry.ordinal}`);
    }
    if (i > 0) {
      const prev = entries[i - 1]!;
      if (entry.ordinal !== prev.ordinal + 1) {
        throw new Error(
          `rendered Timeline ordinals are non-monotonic: ${prev.ordinal} → ${entry.ordinal}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Canonical event grouping
// ---------------------------------------------------------------------------

function groupCanonicalEvents(
  frontmatter: ParsedFrontmatter,
  entries: readonly RenderedTimelineEntry[],
  options: RenderedTimelineParseOptions,
): { readonly events: readonly RenderedTimelineEvent[]; readonly hasIncompleteTail: boolean } {
  const events: RenderedTimelineEvent[] = [];
  let rangeStart: number | null = null;
  let rangeEntries: RenderedTimelineEntry[] = [];
  let sawUserInRange = false;
  let sawAssistantInRange = false;

  for (const entry of entries) {
    if (entry.role === 'User') {
      // A User after a complete User→Assistant pair starts a new event.
      // Consecutive Users before any Assistant stay in the same range so
      // every user message is preserved (joined deterministically later).
      if (sawUserInRange && sawAssistantInRange) {
        events.push(buildEvent(frontmatter, rangeStart!, entry.ordinal - 1, rangeEntries));
        rangeEntries = [];
        sawAssistantInRange = false;
        rangeStart = entry.ordinal;
      } else if (!sawUserInRange) {
        rangeStart = entry.ordinal;
      }
      rangeEntries.push(entry);
      sawUserInRange = true;
    } else if (entry.role === 'Context Compacted') {
      // Context Compacted entries attach to the current or upcoming range.
      // They never split a multi-User or multi-Assistant span.
      rangeEntries.push(entry);
    } else if (entry.role === 'Assistant') {
      if (!sawUserInRange) {
        throw new Error(
          `rendered Timeline Assistant at ordinal ${entry.ordinal} has no preceding User`,
        );
      }
      rangeEntries.push(entry);
      sawAssistantInRange = true;
    }
  }

  let hasIncompleteTail = false;

  // Flush the final range
  if (sawUserInRange && !sawAssistantInRange) {
    if (!options.allowIncompleteTail) {
      throw new Error(
        `rendered Timeline has an incomplete tail: User at ordinal ${rangeStart} has no matching Assistant`,
      );
    }
    hasIncompleteTail = true;
  }
  if (sawUserInRange && sawAssistantInRange) {
    const lastOrdinal = rangeEntries[rangeEntries.length - 1]!.ordinal;
    events.push(buildEvent(frontmatter, rangeStart!, lastOrdinal, rangeEntries));
  }

  if (events.length === 0 && !hasIncompleteTail) {
    throw new Error('rendered Timeline contains no complete User→Assistant events');
  }

  return { events, hasIncompleteTail };
}

/**
 * Collapse consecutive same-role conversation entries while preserving every
 * message body. Used by the xURL adapter when materializing DistillationUnits.
 */
export function joinRenderedTimelineContents(
  entries: readonly RenderedTimelineEntry[],
  role: RenderedTimelineRole,
): string {
  return entries
    .filter(entry => entry.role === role)
    .map(entry => entry.content.trim())
    .filter(Boolean)
    .join(USER_ASSISTANT_JOIN);
}

function buildEvent(
  frontmatter: ParsedFrontmatter,
  ordinalStart: number,
  ordinalEnd: number,
  entries: readonly RenderedTimelineEntry[],
): RenderedTimelineEvent {
  const identity = buildIdentity(frontmatter, ordinalStart, ordinalEnd);
  const contentHash = computeContentHash(entries);
  return {
    identity,
    ordinalStart,
    ordinalEnd,
    roles: entries,
    contentHash,
  };
}

function buildIdentity(
  frontmatter: ParsedFrontmatter,
  ordinalStart: number,
  ordinalEnd: number,
): string {
  const parts = [frontmatter.provider, frontmatter.thread];
  if (frontmatter.branch) parts.push(frontmatter.branch);
  parts.push(`${ordinalStart}-${ordinalEnd}`);
  return parts.join(':');
}

function computeContentHash(entries: readonly RenderedTimelineEntry[]): string {
  const normalized = entries
    .map(entry => `${entry.role}:${entry.content}`)
    .join('\n');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}
