/** Directory metadata only: a locator never proves an archived execution exists. */
export interface CatscoSessionNameQuery { sessionId: string; sessionType?: 'catscompany' }
export interface CatscoSessionNameSearchQuery { name: string; match?: 'exact' | 'contains'; limit?: number }
export interface CatscoSessionName {
  schema_version: 1;
  content_trust: 'untrusted_session_metadata';
  session_id: string;
  session_type: 'catscompany';
  topic_id: string;
  name: string;
  name_status: 'named' | 'unnamed';
  name_redacted?: boolean;
  name_truncated?: boolean;
  viewer_uid: string;
  source: 'catscompany_conversation_directory';
  retrieved_at: string;
}
export interface CatscoSessionNameMatch extends CatscoSessionName {
  session_id_source: 'conversation_directory';
  archive_status: 'not_checked';
}
export interface CatscoSessionNameSearchResult {
  schema_version: 1;
  content_trust: 'untrusted_session_metadata';
  viewer_uid: string;
  source: 'catscompany_conversation_directory';
  retrieved_at: string;
  match: 'exact' | 'contains';
  limit: number;
  matches: CatscoSessionNameMatch[];
  truncated: boolean;
}
export class InvalidSessionLookupInput extends Error {
  constructor() { super('Invalid session lookup arguments'); }
}
function isText(value: unknown, max: number, empty = false): value is string {
  return typeof value === 'string' && (empty || Boolean(value.trim()))
    && Array.from(value).length <= max && !/[\ud800-\udfff]/u.test(value);
}
function selector(value: unknown, max: number): string {
  if (!isText(value, max) || /[\x00-\x1f\x7f-\x9f]/u.test(value)) throw new InvalidSessionLookupInput();
  return value.trim();
}
export function normalizeSessionNameQuery(query: CatscoSessionNameQuery): CatscoSessionNameQuery {
  const sessionId = selector(query.sessionId, 512);
  if (query.sessionType !== undefined && query.sessionType !== 'catscompany') throw new InvalidSessionLookupInput();
  return { sessionId, ...(query.sessionType ? { sessionType: query.sessionType } : {}) };
}
export function normalizeSessionNameSearchQuery(query: CatscoSessionNameSearchQuery): Required<CatscoSessionNameSearchQuery> {
  const name = selector(query.name, 240);
  const match = query.match ?? 'exact';
  const limit = query.limit ?? 20;
  if (!['exact', 'contains'].includes(match) || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new InvalidSessionLookupInput();
  return { name, match, limit };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid session metadata response');
  return value as Record<string, unknown>;
}
function envelope(value: Record<string, unknown>): void {
  if (value.schema_version !== 1 || value.content_trust !== 'untrusted_session_metadata'
    || value.source !== 'catscompany_conversation_directory' || !isText(value.viewer_uid, 256)
    || !isText(value.retrieved_at, 128) || !Number.isFinite(Date.parse(value.retrieved_at))) {
    throw new Error('Invalid session metadata response');
  }
}
/** Whitelist fields before metadata crosses the model boundary, including for embedders. */
export function decodeSessionName(input: unknown): CatscoSessionName {
  const value = record(input);
  envelope(value);
  if (!isText(value.session_id, 512) || value.session_type !== 'catscompany'
    || !isText(value.topic_id, 256) || !isText(value.name, 240, true)
    || !['named', 'unnamed'].includes(String(value.name_status))
    || (value.name_redacted !== undefined && typeof value.name_redacted !== 'boolean')
    || (value.name_truncated !== undefined && typeof value.name_truncated !== 'boolean')) {
    throw new Error('Invalid session metadata response');
  }
  return {
    schema_version: 1, content_trust: 'untrusted_session_metadata',
    session_id: value.session_id, session_type: 'catscompany', topic_id: value.topic_id,
    name: value.name, name_status: value.name_status as 'named' | 'unnamed',
    ...(typeof value.name_redacted === 'boolean' ? { name_redacted: value.name_redacted } : {}),
    ...(typeof value.name_truncated === 'boolean' ? { name_truncated: value.name_truncated } : {}),
    viewer_uid: value.viewer_uid as string, source: 'catscompany_conversation_directory', retrieved_at: value.retrieved_at as string,
  };
}
export function decodeSessionNameSearchResult(input: unknown, limit = 50): CatscoSessionNameSearchResult {
  const value = record(input);
  envelope(value);
  if (!Array.isArray(value.matches) || value.matches.length > 50 || !['exact', 'contains'].includes(String(value.match))
    || !Number.isInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 50 || typeof value.truncated !== 'boolean') {
    throw new Error('Invalid session metadata response');
  }
  const matches = value.matches.map(inputMatch => {
    const match = record(inputMatch);
    if (match.session_id_source !== 'conversation_directory' || match.archive_status !== 'not_checked'
      || match.viewer_uid !== value.viewer_uid || match.retrieved_at !== value.retrieved_at) throw new Error('Invalid session metadata response');
    return { ...decodeSessionName(match), session_id_source: 'conversation_directory' as const, archive_status: 'not_checked' as const };
  });
  const bound = Math.min(limit, Number(value.limit));
  return {
    schema_version: 1, content_trust: 'untrusted_session_metadata',
    viewer_uid: value.viewer_uid as string, source: 'catscompany_conversation_directory', retrieved_at: value.retrieved_at as string,
    match: value.match as 'exact' | 'contains', limit: bound,
    matches: matches.slice(0, bound), truncated: value.truncated || matches.length > bound,
  };
}
