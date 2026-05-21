import { redactReviewText } from './catsco-review-redaction';

export interface ReviewPage {
  limit: number;
  offset: number;
  count: number;
  has_more?: boolean;
  next_offset?: number | null;
}

export interface ReviewSummary {
  uploaded_from?: string | null;
  uploaded_to?: string | null;
  upload_count: number;
  parsed_upload_count: number;
  failed_upload_count: number;
  session_count: number;
  turn_count: number;
  ai_call_count: number;
  tool_call_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ReviewFailure {
  failure_type: string;
  entry_id?: string | null;
  session_record_id?: string | null;
  upload_id: string;
  timestamp?: string | null;
  level?: string | null;
  event_category: string;
  message?: string | null;
}

export interface ReviewTargetFilters {
  userId?: string;
  deviceId?: string;
  deviceName?: string;
  userKey?: string;
  deviceKey?: string;
  sessionId?: string;
  sessionKey?: string;
  sessionType?: string;
  orgKey?: string;
  orgType?: string;
  userRole?: string;
  deviceRole?: string;
  channelType?: string;
  workspaceKey?: string;
}

export interface ReviewContextFields {
  session_record_id?: string | null;
  user_key?: string | null;
  device_key?: string | null;
  session_key?: string | null;
  session_type?: string | null;
  org_key?: string | null;
  org_type?: string | null;
  user_role?: string | null;
  device_role?: string | null;
  channel_type?: string | null;
  workspace_key?: string | null;
}

export interface ReviewSession {
  session_record_id: string;
  upload_id: string;
  user_key: string;
  device_key: string;
  session_key: string;
  session_type: string;
  org_key?: string | null;
  org_type?: string | null;
  user_role?: string | null;
  device_role?: string | null;
  channel_type?: string | null;
  workspace_key?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  entry_count: number;
  runtime_count: number;
  turn_count: number;
  ai_call_count: number;
  tool_call_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  summary_status: string;
  created_at: string;
}

export interface ReviewEntry {
  entry_id: string;
  line_no: number;
  entry_type: string;
  timestamp?: string | null;
  level?: string | null;
  turn_no?: number | null;
  message?: string | null;
  event_category: string;
  tool_name?: string | null;
  duration_ms?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
}

export interface ReviewTurn extends ReviewContextFields {
  turn_record_id: string;
  turn_no: number;
  timestamp?: string | null;
  user_text?: string | null;
  assistant_text?: string | null;
  tool_calls_json?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
}

export interface ReviewData {
  summary: ReviewSummary;
  failures: ReviewFailure[];
  sessions: ReviewSession[];
  sessionEntries: Record<string, ReviewEntry[]>;
  sessionTurns: Record<string, ReviewTurn[]>;
}

export interface CatscoReviewAgentClientOptions {
  timeoutMs?: number;
  maxRetries?: number;
  maxResponseBytes?: number;
}

export class CatscoReviewAgentClient {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxResponseBytes: number;

  constructor(
    private readonly apiBaseUrl: string,
    private readonly reviewToken: string,
    options: CatscoReviewAgentClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.maxRetries = options.maxRetries ?? 2;
    this.maxResponseBytes = options.maxResponseBytes ?? 5 * 1024 * 1024;
  }

  async health(): Promise<{ status: string; review_api: string }> {
    return this.get('/catsco/review/health');
  }

  async summary(uploadedFrom?: string, uploadedTo?: string, filters: ReviewTargetFilters = {}): Promise<ReviewSummary> {
    return this.get('/catsco/review/summary', {
      uploaded_from: uploadedFrom,
      uploaded_to: uploadedTo,
      ...reviewFilterParams(filters),
    });
  }

  async failures(
    limit: number,
    uploadedFrom?: string,
    offset: number = 0,
    uploadedTo?: string,
    filters: ReviewTargetFilters = {},
  ): Promise<{ page: ReviewPage; failures: ReviewFailure[] }> {
    return this.get('/catsco/review/failures', {
      limit,
      offset,
      uploaded_from: uploadedFrom,
      uploaded_to: uploadedTo,
      ...reviewFilterParams(filters),
    });
  }

  async sessions(
    limit: number,
    uploadedFrom?: string,
    offset: number = 0,
    uploadedTo?: string,
    filters: ReviewTargetFilters = {},
  ): Promise<{ page: ReviewPage; sessions: ReviewSession[] }> {
    return this.get('/catsco/review/sessions', {
      limit,
      offset,
      uploaded_from: uploadedFrom,
      uploaded_to: uploadedTo,
      ...reviewFilterParams(filters),
    });
  }

  async reviewTurns(
    limit: number,
    uploadedFrom?: string,
    offset: number = 0,
    uploadedTo?: string,
    filters: ReviewTargetFilters = {},
  ): Promise<{ page: ReviewPage; turns: ReviewTurn[] }> {
    return this.get('/catsco/review/turns', {
      limit,
      offset,
      uploaded_from: uploadedFrom,
      uploaded_to: uploadedTo,
      ...reviewFilterParams(filters),
    });
  }

  async entries(
    sessionRecordId: string,
    limit: number,
    offset: number = 0,
  ): Promise<{ page: ReviewPage; entries: ReviewEntry[] }> {
    return this.get(`/catsco/review/sessions/${encodeURIComponent(sessionRecordId)}/entries`, { limit, offset });
  }

  async turns(
    sessionRecordId: string,
    limit: number,
    offset: number = 0,
  ): Promise<{ page: ReviewPage; turns: ReviewTurn[] }> {
    return this.get(`/catsco/review/sessions/${encodeURIComponent(sessionRecordId)}/turns`, { limit, offset });
  }

  private async get<T>(requestPath: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.apiBaseUrl) {
      throw new Error('CATSCO_REVIEW_API_BASE_URL is not configured');
    }
    if (!this.reviewToken) {
      throw new Error('CATSCO_REVIEW_TOKEN is not configured');
    }

    const url = new URL(`${this.apiBaseUrl}${requestPath.startsWith('/') ? requestPath : `/${requestPath}`}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    const { response, text } = await this.fetchTextWithRetry(url);
    let data: any = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        if (response.ok) {
          throw new Error('CatsCo Review API returned invalid JSON');
        }
        data = { raw: text };
      }
    }

    if (!response.ok) {
      const detail = data?.detail || data?.error || data?.message || data?.raw;
      throw new Error(detail
        ? `CatsCo Review API failed: ${redactReviewText(detail, 500)}`
        : `CatsCo Review API failed: HTTP ${response.status}`);
    }

    return stripReviewRawIdentifierFields(data) as T;
  }

  private async fetchTextWithRetry(url: URL): Promise<{ response: Response; text: string }> {
    let lastError: any;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.reviewToken}`,
          },
        });

        const contentLength = Number(response.headers.get('content-length') || 0);
        if (contentLength > this.maxResponseBytes) {
          clearTimeout(timer);
          throw new Error(`CatsCo Review API response is too large: ${contentLength} bytes`);
        }

        const text = await response.text();
        clearTimeout(timer);
        if (text.length > this.maxResponseBytes) {
          throw new Error(`CatsCo Review API response is too large: ${text.length} bytes`);
        }
        if (!isRetryableStatus(response.status) || attempt >= this.maxRetries) {
          return { response, text };
        }
        await sleep(retryDelayMs(response, attempt));
      } catch (error: any) {
        clearTimeout(timer);
        if (String(error?.message || '').includes('response is too large')) {
          throw error;
        }
        lastError = error?.name === 'AbortError'
          ? new Error(`CatsCo Review API timed out after ${this.timeoutMs}ms`)
          : error;
        if (attempt >= this.maxRetries) {
          throw lastError;
        }
        await sleep(250 * (attempt + 1));
      }
    }

    throw lastError || new Error('CatsCo Review API request failed');
  }
}

const REVIEW_RAW_IDENTIFIER_FIELDS = new Set([
  'user_id',
  'device_id',
  'device_name',
  'session_id',
  'userId',
  'deviceId',
  'deviceName',
  'sessionId',
]);

function stripReviewRawIdentifierFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripReviewRawIdentifierFields);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const stripped: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (REVIEW_RAW_IDENTIFIER_FIELDS.has(key)) continue;
    stripped[key] = stripReviewRawIdentifierFields(child);
  }
  return stripped;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 10000);
    }
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      return Math.min(Math.max(dateMs - Date.now(), 0), 10000);
    }
  }
  return 500 * (attempt + 1);
}

function reviewFilterParams(filters: ReviewTargetFilters): Record<string, unknown> {
  return {
    user_id: filters.userId,
    device_id: filters.deviceId,
    device_name: filters.deviceName,
    user_key: filters.userKey,
    device_key: filters.deviceKey,
    session_id: filters.sessionId,
    session_key: filters.sessionKey,
    session_type: filters.sessionType,
    org_key: filters.orgKey,
    org_type: filters.orgType,
    user_role: filters.userRole,
    device_role: filters.deviceRole,
    channel_type: filters.channelType,
    workspace_key: filters.workspaceKey,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
