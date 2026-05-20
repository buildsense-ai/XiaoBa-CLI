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

export interface ReviewSession {
  session_record_id: string;
  upload_id: string;
  user_key: string;
  device_key: string;
  session_key: string;
  session_type: string;
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

export interface ReviewTurn {
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

export class CatscoReviewAgentClient {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly reviewToken: string,
  ) {}

  async health(): Promise<{ status: string; review_api: string }> {
    return this.get('/catsco/review/health');
  }

  async summary(uploadedFrom?: string, uploadedTo?: string): Promise<ReviewSummary> {
    return this.get('/catsco/review/summary', { uploaded_from: uploadedFrom, uploaded_to: uploadedTo });
  }

  async failures(limit: number, uploadedFrom?: string): Promise<{ page: ReviewPage; failures: ReviewFailure[] }> {
    return this.get('/catsco/review/failures', { limit, uploaded_from: uploadedFrom });
  }

  async sessions(limit: number, uploadedFrom?: string): Promise<{ page: ReviewPage; sessions: ReviewSession[] }> {
    return this.get('/catsco/review/sessions', { limit, uploaded_from: uploadedFrom });
  }

  async entries(sessionRecordId: string, limit: number): Promise<{ page: ReviewPage; entries: ReviewEntry[] }> {
    return this.get(`/catsco/review/sessions/${encodeURIComponent(sessionRecordId)}/entries`, { limit });
  }

  async turns(sessionRecordId: string, limit: number): Promise<{ page: ReviewPage; turns: ReviewTurn[] }> {
    return this.get(`/catsco/review/sessions/${encodeURIComponent(sessionRecordId)}/turns`, { limit });
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

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.reviewToken}`,
      },
    });

    const text = await response.text();
    let data: any = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }

    if (!response.ok) {
      const detail = data?.detail || data?.error || data?.message || data?.raw;
      throw new Error(detail ? `CatsCo Review API failed: ${detail}` : `CatsCo Review API failed: HTTP ${response.status}`);
    }

    return data as T;
  }
}
