import * as fs from 'fs';
import * as path from 'path';
import { getAutoDevApiKey, getAutoDevServerUrl } from './autodev-config';

export interface AutoDevIngestLogResponse {
  log_id: string;
  session_type: string;
  session_id: string;
  log_date: string;
  size_bytes: number;
}

export class AutoDevLogClient {
  constructor(
    private readonly baseUrl: string = getAutoDevServerUrl(),
    private readonly apiKey: string = getAutoDevApiKey(),
  ) {}

  isConfigured(): boolean {
    return !!this.baseUrl;
  }

  async ingestLog(input: {
    filePath: string;
    sessionType: string;
    sessionId: string;
    logDate: string;
  }): Promise<AutoDevIngestLogResponse> {
    const form = new FormData();
    form.append('session_type', input.sessionType);
    form.append('session_id', input.sessionId);
    form.append('log_date', input.logDate);

    const fileBuffer = fs.readFileSync(input.filePath);
    const fileName = path.basename(input.filePath);
    form.append('file', new Blob([fileBuffer], { type: 'application/x-ndjson' }), fileName);

    const response = await fetch(this.buildUrl('/api/logs/ingest'), {
      method: 'POST',
      headers: this.buildHeaders(),
      body: form,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AutoDev ingest failed (${response.status}): ${errorText}`);
    }

    return response.json() as Promise<AutoDevIngestLogResponse>;
  }

  private buildUrl(requestPath: string): string {
    if (!this.baseUrl) {
      throw new Error('AUTODEV_SERVER_URL is not configured');
    }
    return `${this.baseUrl}${requestPath.startsWith('/') ? requestPath : `/${requestPath}`}`;
  }

  private buildHeaders(): Record<string, string> {
    return this.apiKey
      ? { 'x-autodev-key': this.apiKey }
      : {};
  }
}
