import * as fs from 'fs';
import * as path from 'path';

export interface CatscoBootstrapInput {
  deviceId: string;
  deviceName?: string;
  platform?: string;
  hostname?: string;
  agentVersion?: string;
  catscoUserToken: string;
}
export interface CatscoBootstrapResponse {
  user_id: string;
  external_provider: string;
  external_user_id: string;
  device_id: string;
  token_id: string;
  token: string;
  skill_token_id?: string;
  skill_token?: string;
  skill_token_expires_at?: string;
  skills_url?: string;
  upload_url: string;
  upload_protocol?: number;
  append_url?: string;
  issued_at: string;
  expires_at?: string;
}

export interface CatscoUploadResponse {
  upload_id?: string;
  record_id?: string;
  sha256?: string;
  parse_status?: string;
  status?: string;
}

export interface CatscoAppendResponse {
  upload_id?: string;
  sha256?: string;
  status?: string;
  accepted_offset: number;
  revision: string;
}

export interface CatscoSkillReadResponse {
  content_trust?: 'untrusted_runtime_skill';
  skills?: unknown[];
  next_cursor?: string;
  truncated?: boolean;
  incomplete?: boolean;
}

export class CatscoAppendConflictError extends Error {
  readonly status = 409;

  constructor(
    readonly acceptedOffset: number,
    readonly revision: string,
  ) {
    super('CatsLog append conflict');
    this.name = 'CatscoAppendConflictError';
  }
}

export class CatscoLogAgentClient {
  constructor(private readonly apiBaseUrl: string) {}

  async bootstrap(input: CatscoBootstrapInput): Promise<CatscoBootstrapResponse> {
    const response = await fetch(this.buildUrl('/catsco/agent/bootstrap'), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${input.catscoUserToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        device_id: input.deviceId,
        device_name: input.deviceName,
        platform: input.platform,
        hostname: input.hostname,
        agent_version: input.agentVersion,
      }),
    });

    return this.parseJsonResponse<CatscoBootstrapResponse>(response, 'CatsLog bootstrap failed');
  }

  async uploadLog(input: {
    filePath: string;
    token: string;
    logDate: string;
  }): Promise<CatscoUploadResponse> {
    const form = new FormData();
    form.append('log_date', input.logDate);

    const fileBuffer = fs.readFileSync(input.filePath);
    form.append(
      'file',
      new Blob([fileBuffer], { type: 'application/x-ndjson' }),
      path.basename(input.filePath),
    );

    const response = await fetch(this.buildUrl('/catsco/logs/upload'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.token}`,
      },
      body: form,
    });

    return this.parseJsonResponse<CatscoUploadResponse>(response, 'CatsLog upload failed');
  }

  async appendLog(input: {
    filePath: string;
    token: string;
    logDate: string;
    appendUrl: string;
    expectedOffset: number;
    expectedRevision: string;
    requestId: string;
    content: Buffer;
  }): Promise<CatscoAppendResponse> {
    const form = new FormData();
    form.append('log_date', input.logDate);
    form.append(
      'file',
      new Blob([input.content], { type: 'application/x-ndjson' }),
      path.basename(input.filePath),
    );
    const response = await fetch(this.buildUrl(input.appendUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.token}`,
        'X-CatsLog-Expected-Offset': String(input.expectedOffset),
        'X-CatsLog-Expected-Revision': input.expectedRevision,
        'X-CatsLog-Request-ID': input.requestId,
      },
      body: form,
    });
    const data = await this.responseBody(response);
    if (response.status === 409 && Number.isSafeInteger(data?.accepted_offset) && typeof data?.revision === 'string') {
      throw new CatscoAppendConflictError(data.accepted_offset, data.revision);
    }
    if (!response.ok) {
      throw this.responseError(response.status, data, 'CatsLog append failed');
    }
    if (!Number.isSafeInteger(data?.accepted_offset) || typeof data?.revision !== 'string') {
      throw new Error('CatsLog append failed: invalid response');
    }
    return data as CatscoAppendResponse;
  }

  async readSkills(input: {
    token: string;
    skillsUrl: string;
    handle?: string;
    search?: string;
    includeContent?: boolean;
    includeTrace?: 'none' | 'summary' | 'full';
    limit?: number;
    cursor?: string;
  }): Promise<CatscoSkillReadResponse> {
    const params = new URLSearchParams();
    if (input.handle) params.set('handle', input.handle);
    if (input.search) params.set('search', input.search);
    if (input.includeContent) params.set('include_content', 'true');
    if (input.includeTrace) params.set('include_trace', input.includeTrace);
    if (input.limit !== undefined) params.set('limit', String(input.limit));
    if (input.cursor) params.set('cursor', input.cursor);
    const response = await fetch(`${this.buildUrl(input.skillsUrl)}${params.size ? `?${params}` : ''}`, {
      headers: { Authorization: `Bearer ${input.token}` },
    });
    return this.parseJsonResponse<CatscoSkillReadResponse>(response, 'CatsLog Skill read failed');
  }

  private buildUrl(requestPath: string): string {
    if (!this.apiBaseUrl) {
      throw new Error('CATSCO_LOG_API_BASE_URL is not configured');
    }
    const normalizedPath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
    if (!/^\/[A-Za-z0-9._~\/-]*$/.test(normalizedPath) || normalizedPath.startsWith('//')) {
      throw new Error('CatsLog returned an unsafe endpoint path');
    }
    return `${this.apiBaseUrl}${normalizedPath}`;
  }

  private async parseJsonResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
    const data = await this.responseBody(response);
    if (!response.ok) {
      throw this.responseError(response.status, data, fallbackMessage);
    }
    return data as T;
  }

  private async responseBody(response: Response): Promise<any> {
    const text = await response.text();
    let data: any = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }

    return data;
  }

  private responseError(status: number, data: any, fallbackMessage: string): Error {
    const detail = data?.detail || data?.error || data?.message || data?.raw;
    const error = new Error(detail ? `${fallbackMessage}: ${detail}` : `${fallbackMessage}: HTTP ${status}`);
    (error as any).status = status;
    return error;
  }
}
