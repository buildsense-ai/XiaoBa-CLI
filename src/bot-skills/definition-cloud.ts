import type { CatsCoAuthSnapshot } from '../catscompany/local-config';
import type { BotDefinition, BotSkillReference } from '../bot-definition/types';
import { assertValidBotDefinition, isValidBotSkillReferences } from '../bot-definition/validation';
import { normalizeBotSkillReferences } from './canonical';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_DEFINITION_RESPONSE_BYTES = 1024 * 1024;

export interface BotDefinitionCloudSnapshot {
  definition: BotDefinition;
  etag: string;
}

export type BotDefinitionCloudReadResult =
  | { kind: 'missing' }
  | ({ kind: 'found' } & BotDefinitionCloudSnapshot);

export interface BotDefinitionCloudClient {
  read(): Promise<BotDefinitionCloudReadResult>;
  create(definition: BotDefinition): Promise<BotDefinitionCloudSnapshot>;
  patchSkills(skills: BotSkillReference[], ifMatch: string): Promise<BotDefinitionCloudSnapshot>;
}

export interface HttpBotDefinitionCloudClientOptions {
  botId: string;
  auth: CatsCoAuthSnapshot;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  allowInsecureHttp?: boolean;
}

export class BotDefinitionCloudError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'BotDefinitionCloudError';
  }
}

export class HttpBotDefinitionCloudClient implements BotDefinitionCloudClient {
  private readonly botId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpBotDefinitionCloudClientOptions) {
    this.botId = String(options.botId || '').trim();
    this.apiKey = String(options.auth.apiKey || '').trim();
    this.baseUrl = String(options.auth.httpBaseUrl || '').trim().replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!this.botId || !this.apiKey || !this.baseUrl) {
      throw new BotDefinitionCloudError(
        'CatsCo Bot Definition credentials are incomplete.',
        'BOT_DEFINITION_AUTH_INCOMPLETE',
      );
    }
    assertTrustedBaseUrl(this.baseUrl, options.allowInsecureHttp === true);
  }

  async read(): Promise<BotDefinitionCloudReadResult> {
    const response = await this.request('GET');
    if (response.status === 404) return { kind: 'missing' };
    return { kind: 'found', ...await this.snapshotFrom(response) };
  }

  async create(definition: BotDefinition): Promise<BotDefinitionCloudSnapshot> {
    assertValidBotDefinition(definition, this.botId);
    const response = await this.request('PUT', {
      skills: normalizeBotSkillReferences(definition.skills ?? []),
    }, {
      'If-None-Match': '*',
    });
    return this.snapshotFrom(response);
  }

  async patchSkills(
    skills: BotSkillReference[],
    ifMatch: string,
  ): Promise<BotDefinitionCloudSnapshot> {
    const normalized = normalizeBotSkillReferences(skills);
    if (!isValidBotSkillReferences(normalized)) {
      throw new BotDefinitionCloudError('Bot Skill references are invalid.', 'BOT_DEFINITION_SKILLS_INVALID');
    }
    const etag = String(ifMatch || '').trim();
    if (!etag) {
      throw new BotDefinitionCloudError('If-Match is required.', 'BOT_DEFINITION_ETAG_REQUIRED', 428);
    }
    const response = await this.request('PATCH', { skills: normalized }, {
      'If-Match': etag,
    });
    return this.snapshotFrom(response);
  }

  private async request(
    method: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<BufferedCloudResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/bot/definition`, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `ApiKey ${this.apiKey}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal,
      });
      const text = response.status === 404
        ? ''
        : await readResponseTextLimited(response, controller, MAX_DEFINITION_RESPONSE_BYTES);
      if (!response.ok && response.status !== 404) {
        const errorCode = safeServerErrorCode(text);
        throw new BotDefinitionCloudError(
          `CatsCo Bot Definition request failed: HTTP ${response.status}`,
          errorCode || `BOT_DEFINITION_HTTP_${response.status}`,
          response.status,
        );
      }
      return { status: response.status, headers: response.headers, text };
    } catch (error: any) {
      if (error instanceof BotDefinitionCloudError) throw error;
      const code = error?.name === 'AbortError'
        ? 'BOT_DEFINITION_TIMEOUT'
        : 'BOT_DEFINITION_NETWORK_ERROR';
      throw new BotDefinitionCloudError(
        code === 'BOT_DEFINITION_TIMEOUT'
          ? 'CatsCo Bot Definition request timed out.'
          : 'CatsCo Bot Definition request failed.',
        code,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async snapshotFrom(response: BufferedCloudResponse): Promise<BotDefinitionCloudSnapshot> {
    if (response.status < 200 || response.status >= 300) {
      throw new BotDefinitionCloudError(
        `CatsCo Bot Definition request failed: HTTP ${response.status}`,
        `BOT_DEFINITION_HTTP_${response.status}`,
        response.status,
      );
    }
    const etag = String(response.headers.get('etag') || '').trim();
    if (!etag || etag.startsWith('W/')) {
      throw new BotDefinitionCloudError(
        'CatsCo Bot Definition response is missing a strong ETag.',
        'BOT_DEFINITION_ETAG_INVALID',
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(response.text);
    } catch {
      throw new BotDefinitionCloudError(
        'CatsCo Bot Definition response is not valid JSON.',
        'BOT_DEFINITION_RESPONSE_INVALID',
      );
    }
    const definition = (payload as any)?.definition ?? payload;
    try {
      assertValidBotDefinition(definition, this.botId);
    } catch {
      throw new BotDefinitionCloudError(
        'CatsCo Bot Definition response is invalid.',
        'BOT_DEFINITION_RESPONSE_INVALID',
      );
    }
    return { definition, etag };
  }
}

interface BufferedCloudResponse {
  status: number;
  headers: Headers;
  text: string;
}

async function readResponseTextLimited(
  response: Response,
  controller: AbortController,
  maxBytes: number,
): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    controller.abort();
    throw new BotDefinitionCloudError(
      'CatsCo Bot Definition response is too large.',
      'BOT_DEFINITION_RESPONSE_TOO_LARGE',
    );
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      controller.abort();
      throw new BotDefinitionCloudError(
        'CatsCo Bot Definition response is too large.',
        'BOT_DEFINITION_RESPONSE_TOO_LARGE',
      );
    }
    chunks.push(next.value);
  }
  const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total);
  return bytes.toString('utf8');
}

function safeServerErrorCode(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    const code = String(parsed?.error?.code || parsed?.code || '').trim();
    return /^[A-Z0-9_.-]{1,120}$/i.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

function assertTrustedBaseUrl(baseUrl: string, allowInsecureHttp: boolean): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new BotDefinitionCloudError('CatsCo base URL is invalid.', 'BOT_DEFINITION_BASE_URL_INVALID');
  }
  if (url.protocol === 'https:') return;
  if (
    allowInsecureHttp
    && url.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  ) {
    return;
  }
  throw new BotDefinitionCloudError(
    'CatsCo Bot Definition requires a trusted HTTPS endpoint.',
    'BOT_DEFINITION_BASE_URL_UNTRUSTED',
  );
}
