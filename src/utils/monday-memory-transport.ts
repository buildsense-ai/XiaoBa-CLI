const PRIMARY_ENDPOINT = 'https://memory.catsco.cn:18443';
const FALLBACK_ENDPOINT = 'https://memory.catsco.cc:18443';
const PRIMARY_RECHECK_MS = 15 * 60 * 1000;

export interface MemoryUploadDestination {
  endpoint: string;
  fallbackEndpoints?: readonly string[];
}

export function memoryUploadEndpoint(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw Error('invalid Monday memory URL');
  }
  return url.origin;
}

export function memoryUploadDestination(env: NodeJS.ProcessEnv): MemoryUploadDestination {
  const endpoint = memoryUploadEndpoint(env.XIAOBA_MEMORY_UPLOAD_URL || PRIMARY_ENDPOINT);
  const fallback = env.XIAOBA_MEMORY_UPLOAD_FALLBACK_URL || (!env.XIAOBA_MEMORY_UPLOAD_URL ? FALLBACK_ENDPOINT : undefined);
  return { endpoint, fallbackEndpoints: fallback ? [memoryUploadEndpoint(fallback)] : [] };
}

class MemoryHttpError extends Error {
  constructor(readonly status: number) { super('Monday HTTP ' + status); }
}

function retryable(error: unknown): boolean {
  return error instanceof MemoryHttpError ? [502, 503, 504].includes(error.status) :
    error instanceof TypeError || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name));
}

export class MondayMemoryTransport {
  private readonly endpoints: string[];
  private activeEndpoint: string;
  private primaryRecheckAt = 0;
  private dataset = '';

  constructor(destination: MemoryUploadDestination) {
    this.endpoints = [...new Set([destination.endpoint, ...destination.fallbackEndpoints ?? []].map(memoryUploadEndpoint))];
    this.activeEndpoint = this.endpoints[0];
  }

  private async json(endpoint: string, route: string, body?: string): Promise<unknown> {
    const response = await fetch(endpoint + route, {
      ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body }),
      redirect: 'error',
      signal: AbortSignal.timeout(body === undefined ? 10000 : 60000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new MemoryHttpError(response.status);
    }
    return response.json();
  }

  private async readDataset(endpoint: string, expected: string): Promise<string> {
    const value = await this.json(endpoint, '/v1/bot-ingest/config');
    if (!value || typeof value !== 'object' || !('dataset_id' in value) ||
      typeof value.dataset_id !== 'string' || !value.dataset_id.length || value.dataset_id.length > 256) {
      throw Error('invalid Monday dataset');
    }
    if (expected && value.dataset_id !== expected) {
      throw Error('Monday dataset changed; archive uploader state before a full rebuild');
    }
    return value.dataset_id;
  }

  private async available<T>(operation: (endpoint: string) => Promise<T>): Promise<T> {
    const first = Date.now() >= this.primaryRecheckAt ? this.endpoints[0] : this.activeEndpoint;
    const candidates = [...new Set([first, ...this.endpoints])];
    for (let i = 0; i < candidates.length; i++) {
      const endpoint = candidates[i];
      try {
        const result = await operation(endpoint);
        if (endpoint !== this.activeEndpoint || endpoint === this.endpoints[0] || candidates.slice(0, i).includes(this.endpoints[0])) {
          this.primaryRecheckAt = endpoint === this.endpoints[0] ? 0 : Date.now() + PRIMARY_RECHECK_MS;
        }
        this.activeEndpoint = endpoint;
        return result;
      } catch (error) {
        if (!retryable(error) || i === candidates.length - 1) throw error;
      }
    }
    throw Error('no Monday upload endpoint');
  }

  async connect(expectedDataset: string): Promise<string> {
    this.dataset = await this.available(endpoint => this.readDataset(endpoint, expectedDataset));
    return this.dataset;
  }

  async post(route: string, body: string): Promise<unknown> {
    if (!this.dataset) throw Error('Monday transport has not verified its dataset');
    return this.available(async endpoint => {
      if (endpoint !== this.activeEndpoint) await this.readDataset(endpoint, this.dataset);
      return this.json(endpoint, route, body);
    });
  }
}
