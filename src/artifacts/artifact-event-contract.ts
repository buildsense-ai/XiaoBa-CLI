import { randomUUID, createHash } from 'crypto';

/**
 * Artifact A2UI interaction & annotation event contract.
 *
 * This module owns the wire -> domain normalization for dashboard-submitted
 * artifact events. It is intentionally free of any event-bus dependency: the
 * dashboard route validates inputs into `ArtifactEventEnvelope`s and hands
 * them to an injected `ArtifactEventSink`, which Track 1 can later implement
 * with the ExternalEventRouter in one line.
 */

export const ARTIFACT_EVENT_SCHEMA = 'xiaoba.artifact_event.v1' as const;

export type A2uiEventKind = 'a2ui_action' | 'a2ui_form_submit' | 'a2ui_state_change';
export type AnnotationEventKind =
  | 'annotation_create'
  | 'annotation_update'
  | 'annotation_resolve'
  | 'annotation_dismiss';
export type ArtifactEventKind = A2uiEventKind | AnnotationEventKind;
export type ArtifactEventFamily = 'a2ui' | 'annotation';

/**
 * Delivery priority for the wake router.
 * - `immediate`: wake the owning session right away (default for A2UI
 *   interactions and for explicitly submitted annotation batches).
 * - `coalesce`: mergeable; the router may batch several events into one wake
 *   (default for annotation edits that are still in progress).
 */
export type ArtifactEventPriority = 'immediate' | 'coalesce';

const A2UI_KINDS: ReadonlySet<string> = new Set<A2uiEventKind>([
  'a2ui_action',
  'a2ui_form_submit',
  'a2ui_state_change',
]);
const ANNOTATION_KINDS: ReadonlySet<string> = new Set<AnnotationEventKind>([
  'annotation_create',
  'annotation_update',
  'annotation_resolve',
  'annotation_dismiss',
]);
const PRIORITIES: ReadonlySet<string> = new Set<ArtifactEventPriority>(['immediate', 'coalesce']);
const MAX_STRING_FIELD_LENGTH = 512;
const MAX_COMMENT_LENGTH = 16_384;
const MAX_JSON_DEPTH = 8;

export class ArtifactEventValidationError extends Error {
  readonly status: 400 | 422;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, status: 400 | 422, code: string, details?: unknown) {
    super(message);
    this.name = 'ArtifactEventValidationError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Anchor describing where an annotation is attached inside an artifact. */
export type AnnotationAnchor =
  | {
      type: 'text';
      /** Exact selected text. */
      exact: string;
      prefix?: string;
      suffix?: string;
      start?: number;
      end?: number;
    }
  | {
      type: 'region';
      x: number;
      y: number;
      width: number;
      height: number;
      /** Optional page/surface index for paged artifacts. */
      page?: number;
    }
  | {
      type: 'component';
      componentId: string;
      selector?: string;
    };

export interface A2uiActionPayload {
  componentId: string;
  actionName: string;
  params?: Record<string, unknown>;
}

export interface A2uiFormSubmitPayload {
  componentId: string;
  actionName: string;
  formData: Record<string, unknown>;
}

export interface A2uiStateChangePayload {
  componentId: string;
  state: Record<string, unknown>;
  previousState?: Record<string, unknown>;
}

export type A2uiEventPayload =
  | A2uiActionPayload
  | A2uiFormSubmitPayload
  | A2uiStateChangePayload;

export interface AnnotationEventPayload {
  annotationId: string;
  anchor?: AnnotationAnchor;
  /** Quoted artifact content the annotation refers to. */
  quote?: string;
  /** User-authored comment body. */
  comment?: string;
  /** True when the client explicitly submitted the annotation batch. */
  batchSubmit: boolean;
}

export interface ArtifactEventEnvelope {
  schema: typeof ARTIFACT_EVENT_SCHEMA;
  eventId: string;
  /** Caller-supplied idempotency key when provided (clientEventId / eventId / idempotencyKey). */
  clientEventId?: string;
  kind: ArtifactEventKind;
  family: ArtifactEventFamily;
  priority: ArtifactEventPriority;
  artifactId: string;
  /** Deterministic dedup/coalesce key for the event router. */
  dedupKey: string;
  sessionKey?: string;
  topic?: string;
  actorUserId?: string;
  occurredAt: string;
  payload: A2uiEventPayload | AnnotationEventPayload;
  /** Model-facing wake prompt rendered for this event. */
  prompt?: string;
  /** Shared batch prompt, set when several annotations target one artifact. */
  batchPrompt?: string;
}

export interface ArtifactSessionBinding {
  artifactId: string;
  sessionKey?: string;
  topic?: string;
  boundByUserId?: string;
  boundAt: string;
}

export interface ArtifactEventEmitResult {
  eventId: string;
  accepted: boolean;
  /** True when the sink merged this event into a pending coalesce group. */
  deduplicated?: boolean;
  queueDepth?: number;
}

export interface ArtifactBindResult {
  ok: boolean;
  binding?: ArtifactSessionBinding;
  reason?: string;
}

/**
 * Boundary between the dashboard route and the event bus. Implementations may
 * be synchronous or async; the route awaits either.
 */
export interface ArtifactEventSink {
  emitEvent(envelope: ArtifactEventEnvelope): Promise<ArtifactEventEmitResult> | ArtifactEventEmitResult;
  bindArtifactSession(binding: ArtifactSessionBinding): Promise<ArtifactBindResult> | ArtifactBindResult;
}

export function isAnnotationEventKind(kind: ArtifactEventKind): kind is AnnotationEventKind {
  return ANNOTATION_KINDS.has(kind);
}

export function artifactEventFamily(kind: ArtifactEventKind): ArtifactEventFamily {
  return isAnnotationEventKind(kind) ? 'annotation' : 'a2ui';
}

/**
 * Resolve delivery priority.
 * - Explicit `priority` input wins (validated to the two known values).
 * - Annotations default to `coalesce`; an explicit batch submit escalates to
 *   `immediate`.
 * - A2UI interactions default to `immediate`.
 */
export function resolveArtifactEventPriority(
  kind: ArtifactEventKind,
  options: { batchSubmit?: boolean; explicit?: unknown } = {},
): ArtifactEventPriority {
  const explicit = options.explicit;
  if (explicit !== undefined && explicit !== null) {
    const value = String(explicit).trim().toLowerCase();
    if (!PRIORITIES.has(value)) {
      throw new ArtifactEventValidationError(
        `priority must be one of: ${[...PRIORITIES].join(', ')}`,
        422,
        'invalid_priority',
      );
    }
    return value as ArtifactEventPriority;
  }
  if (isAnnotationEventKind(kind)) {
    return options.batchSubmit ? 'immediate' : 'coalesce';
  }
  return 'immediate';
}

/**
 * Validate and normalize one raw event input into a standard envelope.
 * Accepts both camelCase and snake_case field names.
 */
export function normalizeArtifactEvent(input: unknown): ArtifactEventEnvelope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ArtifactEventValidationError('event must be a JSON object', 400, 'invalid_event_body');
  }
  const raw = input as Record<string, unknown>;

  const kindText = pickString(raw, 'kind', 'type', 'event');
  if (!kindText) {
    throw new ArtifactEventValidationError('event kind is required', 400, 'missing_kind');
  }
  const kind = kindText.trim().toLowerCase();
  if (!A2UI_KINDS.has(kind) && !ANNOTATION_KINDS.has(kind)) {
    throw new ArtifactEventValidationError(
      `unknown artifact event kind: ${kindText}`,
      422,
      'unknown_kind',
      { allowed: [...A2UI_KINDS, ...ANNOTATION_KINDS] },
    );
  }
  const eventKind = kind as ArtifactEventKind;
  const family = artifactEventFamily(eventKind);

  const artifactId = requireTrimmedString(raw, 'artifactId', 'artifact_id');
  const sessionKey = pickString(raw, 'sessionKey', 'session_key');
  const topic = pickString(raw, 'topic');
  const actorUserId = pickString(raw, 'actorUserId', 'actor_user_id', 'actor', 'userId', 'user_id');
  const clientEventId = pickString(
    raw,
    'clientEventId',
    'client_event_id',
    'eventId',
    'event_id',
    'idempotencyKey',
    'idempotency_key',
  );
  const dedupKeyInput = pickString(raw, 'dedupKey', 'dedup_key');
  const occurredAt = normalizeOccurredAt(pickString(raw, 'occurredAt', 'occurred_at', 'timestamp'));

  let payload: A2uiEventPayload | AnnotationEventPayload;
  let batchSubmit = false;
  if (family === 'a2ui') {
    payload = normalizeA2uiPayload(eventKind as A2uiEventKind, raw);
  } else {
    const normalized = normalizeAnnotationPayload(eventKind as AnnotationEventKind, raw);
    payload = normalized;
    batchSubmit = normalized.batchSubmit;
  }

  const priority = resolveArtifactEventPriority(eventKind, {
    batchSubmit,
    explicit: raw.priority,
  });

  const eventId = `aev_${randomUUID()}`;
  const dedupKey = dedupKeyInput || deriveDedupKey(eventKind, artifactId, payload, clientEventId);

  return {
    schema: ARTIFACT_EVENT_SCHEMA,
    eventId,
    ...(clientEventId ? { clientEventId } : {}),
    kind: eventKind,
    family,
    priority,
    artifactId,
    dedupKey,
    sessionKey,
    topic,
    actorUserId,
    occurredAt,
    payload,
  };
}

function normalizeA2uiPayload(kind: A2uiEventKind, raw: Record<string, unknown>): A2uiEventPayload {
  const componentId = requireTrimmedString(raw, 'componentId', 'component_id');
  switch (kind) {
    case 'a2ui_action': {
      const actionName = requireTrimmedString(raw, 'actionName', 'action_name', 'action');
      const params = optionalJsonObject(raw, 'params', 'arguments');
      return { componentId, actionName, params };
    }
    case 'a2ui_form_submit': {
      const formData = optionalJsonObject(raw, 'formData', 'form_data', 'data', 'values');
      if (!formData) {
        throw new ArtifactEventValidationError(
          'a2ui_form_submit requires a formData object',
          422,
          'missing_form_data',
        );
      }
      const actionName = pickString(raw, 'actionName', 'action_name', 'action') || 'submit';
      return { componentId, actionName, formData };
    }
    case 'a2ui_state_change': {
      const state = optionalJsonObject(raw, 'state', 'newState', 'new_state');
      if (!state) {
        throw new ArtifactEventValidationError(
          'a2ui_state_change requires a state object',
          422,
          'missing_state',
        );
      }
      const previousState = optionalJsonObject(raw, 'previousState', 'previous_state', 'oldState', 'old_state');
      return { componentId, state, previousState };
    }
  }
}

function normalizeAnnotationPayload(
  kind: AnnotationEventKind,
  raw: Record<string, unknown>,
): AnnotationEventPayload {
  const annotationId = pickString(raw, 'annotationId', 'annotation_id', 'id') || `ann_${randomUUID()}`;
  const anchor = normalizeAnchor(raw);
  const quote = pickBoundedString(raw, MAX_COMMENT_LENGTH, 'quote', 'selectedText', 'selected_text');
  const comment = pickBoundedString(raw, MAX_COMMENT_LENGTH, 'comment', 'body', 'text');
  const batchSubmit = pickBoolean(raw, 'batchSubmit', 'batch_submit', 'submit', 'submitted') ?? false;

  switch (kind) {
    case 'annotation_create':
      if (!anchor && !quote) {
        throw new ArtifactEventValidationError(
          'annotation_create requires an anchor (selection/region/component) or a quote',
          422,
          'missing_anchor',
        );
      }
      if (!comment) {
        throw new ArtifactEventValidationError(
          'annotation_create requires a comment',
          422,
          'missing_comment',
        );
      }
      break;
    case 'annotation_update':
      if (!comment && !anchor && !quote) {
        throw new ArtifactEventValidationError(
          'annotation_update requires at least one of comment, anchor, or quote',
          422,
          'empty_update',
        );
      }
      break;
    case 'annotation_resolve':
    case 'annotation_dismiss':
      if (!pickString(raw, 'annotationId', 'annotation_id', 'id')) {
        throw new ArtifactEventValidationError(
          `${kind} requires annotationId`,
          422,
          'missing_annotation_id',
        );
      }
      break;
  }

  return { annotationId, anchor, quote, comment, batchSubmit };
}

function normalizeAnchor(raw: Record<string, unknown>): AnnotationAnchor | undefined {
  const anchorInput = firstPresent(raw, 'anchor', 'selection', 'region');
  if (anchorInput !== undefined && anchorInput !== null) {
    if (typeof anchorInput !== 'object' || Array.isArray(anchorInput)) {
      throw new ArtifactEventValidationError('anchor must be an object', 422, 'invalid_anchor');
    }
    const anchor = anchorInput as Record<string, unknown>;
    const type = String(anchor.type ?? anchor.kind ?? '').trim().toLowerCase();
    if (type === 'text' || anchor.exact !== undefined || anchor.start !== undefined || anchor.end !== undefined) {
      const exact = String(anchor.exact ?? anchor.text ?? '').trim();
      if (!exact) {
        throw new ArtifactEventValidationError('text anchor requires exact text', 422, 'invalid_anchor');
      }
      return {
        type: 'text',
        exact,
        prefix: optionalAnchorString(anchor, 'prefix'),
        suffix: optionalAnchorString(anchor, 'suffix'),
        start: optionalAnchorNumber(anchor, 'start'),
        end: optionalAnchorNumber(anchor, 'end'),
      };
    }
    if (type === 'region' || anchor.x !== undefined || anchor.width !== undefined) {
      const numbers = ['x', 'y', 'width', 'height'].map(key => requiredAnchorNumber(anchor, key));
      const page = optionalAnchorNumber(anchor, 'page');
      return { type: 'region', x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3], ...(page !== undefined ? { page } : {}) };
    }
    if (type === 'component' || anchor.componentId !== undefined || anchor.component_id !== undefined) {
      const componentId = String(anchor.componentId ?? anchor.component_id ?? '').trim();
      if (!componentId) {
        throw new ArtifactEventValidationError('component anchor requires componentId', 422, 'invalid_anchor');
      }
      return { type: 'component', componentId, selector: optionalAnchorString(anchor, 'selector') };
    }
    throw new ArtifactEventValidationError(
      'anchor must be a text, region, or component anchor',
      422,
      'invalid_anchor',
    );
  }

  // Convenience form: a componentId on the event itself anchors the annotation.
  const componentId = pickString(raw, 'componentId', 'component_id');
  if (componentId) {
    return { type: 'component', componentId };
  }
  return undefined;
}

function deriveDedupKey(
  kind: ArtifactEventKind,
  artifactId: string,
  payload: A2uiEventPayload | AnnotationEventPayload,
  clientEventId?: string,
): string {
  if (isAnnotationEventKind(kind)) {
    const annotation = payload as AnnotationEventPayload;
    return `ann:${artifactId}:${annotation.annotationId}:${kind}`;
  }
  const a2ui = payload as A2uiActionPayload & A2uiFormSubmitPayload & A2uiStateChangePayload;
  const base = {
    kind,
    componentId: a2ui.componentId,
    actionName: a2ui.actionName,
    params: a2ui.params,
    formData: a2ui.formData,
    state: a2ui.state,
  };
  const hash = createHash('sha256').update(stableStringify(base)).digest('hex').slice(0, 16);
  const suffix = clientEventId ? `:${clientEventId}` : '';
  return `a2ui:${artifactId}:${a2ui.componentId}:${hash}${suffix}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function normalizeOccurredAt(value: string | undefined): string {
  if (!value) return new Date().toISOString();
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    throw new ArtifactEventValidationError('occurredAt must be a valid timestamp', 422, 'invalid_timestamp');
  }
  return new Date(time).toISOString();
}

function firstPresent(raw: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (raw[key] !== undefined && raw[key] !== null) return raw[key];
  }
  return undefined;
}

function pickString(raw: Record<string, unknown>, ...keys: string[]): string | undefined {
  const value = firstPresent(raw, ...keys);
  if (value === undefined) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ArtifactEventValidationError(`${keys[0]} must be a string`, 422, 'invalid_field', { field: keys[0] });
  }
  const text = String(value).trim();
  if (!text) return undefined;
  if (text.length > MAX_STRING_FIELD_LENGTH) {
    throw new ArtifactEventValidationError(
      `${keys[0]} exceeds ${MAX_STRING_FIELD_LENGTH} characters`,
      422,
      'field_too_long',
      { field: keys[0] },
    );
  }
  return text;
}

function pickBoundedString(raw: Record<string, unknown>, max: number, ...keys: string[]): string | undefined {
  const value = firstPresent(raw, ...keys);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ArtifactEventValidationError(`${keys[0]} must be a string`, 422, 'invalid_field', { field: keys[0] });
  }
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > max) {
    throw new ArtifactEventValidationError(
      `${keys[0]} exceeds ${max} characters`,
      422,
      'field_too_long',
      { field: keys[0] },
    );
  }
  return text;
}

function pickBoolean(raw: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  const value = firstPresent(raw, ...keys);
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(text)) return true;
    if (['false', '0', 'no', 'off'].includes(text)) return false;
  }
  throw new ArtifactEventValidationError(`${keys[0]} must be a boolean`, 422, 'invalid_field', { field: keys[0] });
}

function requireTrimmedString(raw: Record<string, unknown>, ...keys: string[]): string {
  const value = pickString(raw, ...keys);
  if (!value) {
    throw new ArtifactEventValidationError(`${keys[0]} is required`, 422, 'missing_field', { field: keys[0] });
  }
  return value;
}

function optionalJsonObject(raw: Record<string, unknown>, ...keys: string[]): Record<string, unknown> | undefined {
  const value = firstPresent(raw, ...keys);
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ArtifactEventValidationError(`${keys[0]} must be an object`, 422, 'invalid_field', { field: keys[0] });
  }
  assertJsonDepth(value, keys[0]);
  return value as Record<string, unknown>;
}

function assertJsonDepth(value: unknown, field: string, depth = 0): void {
  if (depth > MAX_JSON_DEPTH) {
    throw new ArtifactEventValidationError(
      `${field} exceeds maximum nesting depth of ${MAX_JSON_DEPTH}`,
      422,
      'field_too_deep',
      { field },
    );
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      assertJsonDepth(entry, field, depth + 1);
    }
  }
}

function optionalAnchorString(anchor: Record<string, unknown>, key: string): string | undefined {
  const value = anchor[key];
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function optionalAnchorNumber(anchor: Record<string, unknown>, key: string): number | undefined {
  const value = anchor[key];
  if (value === undefined || value === null) return undefined;
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new ArtifactEventValidationError(`anchor.${key} must be a number`, 422, 'invalid_anchor');
  }
  return num;
}

function requiredAnchorNumber(anchor: Record<string, unknown>, key: string): number {
  const value = optionalAnchorNumber(anchor, key);
  if (value === undefined) {
    throw new ArtifactEventValidationError(`region anchor requires ${key}`, 422, 'invalid_anchor');
  }
  return value;
}
