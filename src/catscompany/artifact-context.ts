import type {
  MessageEnvelope,
  ScopedArtifactContext,
  ScopedArtifactPageContext,
  ScopedArtifactPageControl,
  ScopedArtifactPageControlType,
} from '../types/session-identity';

type UnknownRecord = Record<string, unknown>;

const ARTIFACT_CONTEXT_CONTRACT = 'catsco.artifact-context.v1';
const ARTIFACT_PAGE_CONTEXT_CONTRACT = 'catsco.artifact-page-context.v1';
const ARTIFACT_ID_PATTERN = /^[a-z0-9]+(?:[a-z0-9._-]*[a-z0-9])?$/;
const MAX_ARTIFACT_ID_LENGTH = 64;
const MAX_TITLE_LENGTH = 512;
const MAX_URL_LENGTH = 2048;
const MAX_TOPIC_ID_LENGTH = 256;
const MAX_AGENT_ID_LENGTH = 128;
const MAX_PAGE_CONTEXT_BYTES = 16 * 1024;
const MAX_PAGE_CONTROLS = 24;
const PAGE_CONTROL_TYPES = new Set<ScopedArtifactPageControlType>([
  'checkbox',
  'radio',
  'select-one',
  'select-multiple',
  'text',
  'search',
  'number',
  'range',
  'textarea',
]);

/**
 * Extracts server-canonical Artifact identity while keeping page-authored
 * labels and observations explicitly untrusted for Runtime consumption.
 */
export function extractCatsCoArtifactContext(
  metadata: Record<string, unknown> | undefined,
  envelope: MessageEnvelope,
  botUid?: string | null,
): ScopedArtifactContext | undefined {
  if (envelope.source !== 'catscompany' || envelope.identityTrust !== 'server_canonical') {
    return undefined;
  }

  const context = asRecord(metadata?.artifact_context);
  if (!context || exactStringField(context, 'contract_version', 64) !== ARTIFACT_CONTEXT_CONTRACT) {
    return undefined;
  }

  const artifactId = exactStringField(context, 'id', MAX_ARTIFACT_ID_LENGTH);
  const title = stringField(context, 'title', MAX_TITLE_LENGTH);
  const artifactKind = exactStringField(context, 'kind', 32);
  const url = exactStringField(context, 'url', MAX_URL_LENGTH);
  const topicId = exactStringField(context, 'topic_id', MAX_TOPIC_ID_LENGTH);
  const agentId = normalizeCatsCoUid(context.agent_uid, MAX_AGENT_ID_LENGTH);

  if (!artifactId || !ARTIFACT_ID_PATTERN.test(artifactId) || !title || !url || !topicId || !agentId) {
    return undefined;
  }
  if (artifactKind !== 'html' && artifactKind !== 'mini_app') return undefined;
  if (!isAbsoluteHttpUrl(url) || context.currently_visible !== true) return undefined;
  if (topicId !== envelope.topicId) return undefined;

  const expectedEnvelopeAgent = normalizeCatsCoUid(envelope.agentId, MAX_AGENT_ID_LENGTH);
  const expectedBotAgent = normalizeCatsCoUid(botUid, MAX_AGENT_ID_LENGTH);
  if (!expectedEnvelopeAgent && !expectedBotAgent) return undefined;
  if (expectedEnvelopeAgent && agentId !== expectedEnvelopeAgent) return undefined;
  if (expectedBotAgent && agentId !== expectedBotAgent) return undefined;

  const displayedVersion = optionalPositiveInteger(context, 'displayed_version');
  const latestVersion = optionalPositiveInteger(context, 'latest_version');
  if (displayedVersion === null || latestVersion === null) return undefined;
  const pageContext = parseArtifactPageContext(context.page_context);

  return pruneUndefined({
    kind: 'catsco_artifact_context',
    source: 'catscompany',
    contractVersion: ARTIFACT_CONTEXT_CONTRACT,
    artifactId,
    title,
    artifactKind,
    url,
    topicId,
    agentId,
    currentlyVisible: true,
    displayedVersion,
    latestVersion,
    pageContext,
    identityTrust: 'server_canonical',
    observationTrust: 'untrusted_content',
  }) as ScopedArtifactContext;
}

function parseArtifactPageContext(value: unknown): ScopedArtifactPageContext | undefined {
  const context = asRecord(value);
  if (!context || exactStringField(context, 'contract_version', 64) !== ARTIFACT_PAGE_CONTEXT_CONTRACT) {
    return undefined;
  }
  if (encodedByteLength(context) > MAX_PAGE_CONTEXT_BYTES) return undefined;
  const observedAt = exactStringField(context, 'observed_at', 64);
  if (!observedAt || !Number.isFinite(Date.parse(observedAt))) return undefined;

  const pageContext: ScopedArtifactPageContext = {
    contractVersion: ARTIFACT_PAGE_CONTEXT_CONTRACT,
    observedAt,
  };
  const title = stringField(context, 'title', 256);
  if (title) pageContext.title = title;
  const location = parsePageLocation(context.location);
  if (location) pageContext.location = location;
  const selectedText = stringField(context, 'selected_text', 2000);
  if (selectedText) pageContext.selectedText = selectedText;
  const lastInteraction = parsePageInteraction(context.last_interaction);
  if (lastInteraction) pageContext.lastInteraction = lastInteraction;
  const controls = parsePageControls(context.controls);
  if (controls.length > 0) pageContext.controls = controls;

  return Object.keys(pageContext).length > 2 ? pageContext : undefined;
}

function parsePageLocation(value: unknown): ScopedArtifactPageContext['location'] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const location: NonNullable<ScopedArtifactPageContext['location']> = {};
  const pathname = exactStringField(record, 'pathname', 1024);
  if (pathname?.startsWith('/')) location.pathname = pathname;
  const hash = exactStringField(record, 'hash', 512);
  if (hash?.startsWith('#')) location.hash = hash;
  return Object.keys(location).length > 0 ? location : undefined;
}

function parsePageInteraction(value: unknown): ScopedArtifactPageContext['lastInteraction'] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const interaction: NonNullable<ScopedArtifactPageContext['lastInteraction']> = {};
  const tag = exactStringField(record, 'tag', 32)?.toLowerCase();
  if (tag && /^[a-z][a-z0-9-]*$/.test(tag)) interaction.tag = tag;
  const role = stringField(record, 'role', 64);
  const name = stringField(record, 'name', 256);
  const text = stringField(record, 'text', 256);
  if (role) interaction.role = role;
  if (name) interaction.name = name;
  if (text) interaction.text = text;
  return Object.keys(interaction).length > 0 ? interaction : undefined;
}

function parsePageControls(value: unknown): ScopedArtifactPageControl[] {
  if (!Array.isArray(value)) return [];
  const controls: ScopedArtifactPageControl[] = [];
  for (const item of value.slice(0, MAX_PAGE_CONTROLS)) {
    const record = asRecord(item);
    if (!record) continue;
    const type = exactStringField(record, 'type', 32)?.toLowerCase() as ScopedArtifactPageControlType | undefined;
    if (!type || !PAGE_CONTROL_TYPES.has(type)) continue;
    const control: ScopedArtifactPageControl = { type };
    const name = stringField(record, 'name', 256);
    const ariaLabel = stringField(record, 'aria_label', 256);
    const role = stringField(record, 'role', 64);
    const controlValue = stringField(record, 'value', 512);
    const text = stringField(record, 'text', 256);
    if (name) control.name = name;
    if (ariaLabel) control.ariaLabel = ariaLabel;
    if (role) control.role = role;
    if (controlValue) control.value = controlValue;
    if (text) control.text = text;
    if (typeof record.checked === 'boolean' && (type === 'checkbox' || type === 'radio')) {
      control.checked = record.checked;
    }
    if (Object.keys(control).length > 1) controls.push(control);
  }
  return controls;
}

function encodedByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function asRecord(value: unknown): UnknownRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as UnknownRecord;
}

function stringField(record: UnknownRecord, key: string, maxLength: number): string | undefined {
  const value = record[key];
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.length > maxLength) return undefined;
  return text;
}

function exactStringField(record: UnknownRecord, key: string, maxLength: number): string | undefined {
  const value = record[key];
  if (typeof value !== 'string' || value !== value.trim()) return undefined;
  return value && value.length <= maxLength ? value : undefined;
}

function normalizeCatsCoUid(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return undefined;
  const raw = String(value).trim();
  if (!raw || raw.length > maxLength) return undefined;
  const numeric = raw.match(/^(?:usr)?(\d+)$/i);
  if (numeric) {
    const digits = numeric[1].replace(/^0+(?=\d)/, '');
    return digits === '0' ? undefined : `usr${digits}`;
  }
  return raw;
}

function optionalPositiveInteger(record: UnknownRecord, key: string): number | undefined | null {
  if (!(key in record) || record[key] === undefined) return undefined;
  const value = record[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && Boolean(parsed.hostname)
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

function pruneUndefined<T>(value: T): T {
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key];
  }
  return value;
}
