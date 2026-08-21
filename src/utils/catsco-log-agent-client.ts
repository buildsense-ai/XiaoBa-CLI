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
  upload_url: string;
  issued_at: string;
  expires_at?: string;
  upload_protocol?: number;
  append_url?: string;
  skill_token_id?: string;
  skill_token?: string;
  skill_token_expires_at?: string;
  skills_url?: string;
}

export interface CatscoSkill {
  id: string;
  handle: string;
  revision: number;
  routing_name?: string;
  description?: string;
  content_sha256: string;
  updated_at?: string;
  content?: string;
}

export interface CatscoSkillsResponse {
  schema_version: number;
  content_trust: string;
  catalog_revision: number;
  skills: CatscoSkill[];
  next_cursor?: string;
  truncated?: boolean;
  incomplete?: boolean;
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
    content?: Uint8Array;
    fileName?: string;
  }): Promise<CatscoUploadResponse> {
    const form = new FormData();
    form.append('log_date', input.logDate);

    const fileBuffer = input.content || fs.readFileSync(input.filePath);
    form.append(
      'file',
      new Blob([fileBuffer], { type: 'application/x-ndjson' }),
      input.fileName || path.basename(input.filePath),
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
    token: string;
    logDate: string;
    content: Uint8Array;
    fileName: string;
    expectedOffset: number;
    expectedRevision: string;
    requestId: string;
    appendUrl?: string;
  }): Promise<CatscoAppendResponse> {
    const form = new FormData();
    form.append('log_date', input.logDate);
    form.append(
      'file',
      new Blob([input.content], { type: 'application/x-ndjson' }),
      input.fileName,
    );

    const response = await fetch(this.buildUrl(input.appendUrl || '/catsco/logs/append'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.token}`,
        'X-CatsLog-Expected-Offset': String(input.expectedOffset),
        'X-CatsLog-Expected-Revision': input.expectedRevision,
        'X-CatsLog-Request-ID': input.requestId,
      },
      body: form,
    });

    return this.parseJsonResponse<CatscoAppendResponse>(response, 'CatsLog append failed');
  }

  // Skills use a separate device-bound capability. This is intentionally not
  // the upload token and never falls back to the CatsCompany user bearer.
  async readSkills(input: { skillToken: string; includeContent?: boolean; limit?: number; skillsUrl?: string }): Promise<CatscoSkillsResponse> {
    const query = new URLSearchParams();
    if (input.includeContent) query.set('include_content', 'true');
    if (input.limit) query.set('limit', String(input.limit));
    const suffix = query.size ? `?${query.toString()}` : '';
    const response = await fetch(this.buildUrl((input.skillsUrl || '/catsco/agent/skills') + suffix), {
      headers: { Authorization: `Bearer ${input.skillToken}` },
    });
    return this.parseJsonResponse<CatscoSkillsResponse>(response, 'CatsLog Skills read failed');
  }

  async reportSkillOutcome(input: { skillToken: string; handle: string; revision: number; outcome: 'succeeded' | 'failed' | 'corrected'; skillsUrl?: string }): Promise<void> {
    const base = input.skillsUrl || '/catsco/agent/skills';
    const response = await fetch(this.buildUrl(`${base.replace(/\/$/, '')}/${encodeURIComponent(input.handle)}/outcomes`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.skillToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: input.revision, outcome: input.outcome }),
    });
    await this.parseJsonResponse<Record<string, never>>(response, 'CatsLog Skill outcome failed');
  }

  private buildUrl(requestPath: string): string {
    if (!this.apiBaseUrl) {
      throw new Error('CATSCO_LOG_API_BASE_URL is not configured');
    }
    return `${this.apiBaseUrl}${requestPath.startsWith('/') ? requestPath : `/${requestPath}`}`;
  }

  private async parseJsonResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
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
      const error = new Error(detail ? `${fallbackMessage}: ${detail}` : `${fallbackMessage}: HTTP ${response.status}`);
      (error as any).status = response.status;
      (error as any).payload = data;
      throw error;
    }

    return data as T;
  }
}
