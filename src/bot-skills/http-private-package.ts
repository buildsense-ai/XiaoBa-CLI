import * as crypto from 'crypto';
import { normalizeBotSkillReferences } from './canonical';
import type {
  BotPrivateSkillPackageClient,
  BotPrivateSkillUpsertInput,
  BotPrivateSkillVersion,
  BotSkillDownloadedPackage,
} from './private-package';
import {
  compareBotSkillSourcePath,
  computeBotSkillFilesContentHash,
} from './source-snapshot';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 30 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_SINGLE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export interface HttpBotPrivateSkillPackageClientOptions {
  baseUrl: string;
  botId: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  allowInsecureHttp?: boolean;
}

export class HttpBotPrivateSkillPackageClient implements BotPrivateSkillPackageClient {
  private readonly baseUrl: string;
  private readonly botId: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpBotPrivateSkillPackageClientOptions) {
    this.baseUrl = String(options.baseUrl || '').trim().replace(/\/+$/, '');
    this.botId = String(options.botId || '').trim();
    this.apiKey = String(options.apiKey || '').trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!this.baseUrl || !this.botId || !this.apiKey) {
      throw packageError('Bot private Skill package credentials are incomplete.', 'BOT_SKILL_PACKAGE_AUTH_INCOMPLETE');
    }
    assertTrustedBaseUrl(this.baseUrl, options.allowInsecureHttp === true);
  }

  async upsert(input: BotPrivateSkillUpsertInput): Promise<BotPrivateSkillVersion> {
    const payload = {
      localSkillId: input.localSkillId,
      name: input.name,
      contentHash: input.snapshot.contentHash,
      ...(input.origin ? { origin: input.origin } : {}),
      files: input.snapshot.files.map(file => ({
        path: file.path,
        size: file.size,
        sha256: file.sha256,
        contentBase64: file.bytes.toString('base64'),
      })),
    };
    const value = await this.request(
      'PUT',
      '/api/bot/private-skill-packages',
      payload,
    );
    return parseVersion(value, {
      localSkillId: input.localSkillId,
      name: input.name,
      contentHash: input.snapshot.contentHash,
      origin: input.origin,
    });
  }

  async download(reference: { skillId: string; version: string }): Promise<BotSkillDownloadedPackage> {
    normalizeBotSkillReferences([reference]);
    const value = await this.request(
      'GET',
      `/api/bot/skill-packages/${encodeURIComponent(reference.skillId)}/versions/${encodeURIComponent(reference.version)}`,
    );
    const raw = unwrapPackage(value);
    const version = parseVersion(raw);
    if (
      version.reference.skillId !== reference.skillId
      || version.reference.version !== reference.version
    ) {
      throw packageError('Downloaded Skill package reference mismatch.', 'BOT_SKILL_PACKAGE_REFERENCE_MISMATCH');
    }
    const rawFiles = raw?.files;
    if (!Array.isArray(rawFiles) || rawFiles.length === 0 || rawFiles.length > MAX_FILES) {
      throw packageError('Downloaded Skill package file list is invalid.', 'BOT_SKILL_PACKAGE_FILES_INVALID');
    }
    let totalBytes = 0;
    const seen = new Set<string>();
    const files = rawFiles.map((raw: any) => {
      const filePath = safePackagePath(raw?.path);
      const portablePath = filePath.toLocaleLowerCase('en-US');
      if (seen.has(portablePath)) {
        throw packageError('Downloaded Skill package contains duplicate files.', 'BOT_SKILL_PACKAGE_FILES_INVALID');
      }
      seen.add(portablePath);
      const declaredSize = Number(raw?.size);
      const declaredHash = String(raw?.sha256 || '').trim();
      const encoded = typeof raw?.contentBase64 === 'string' ? raw.contentBase64 : undefined;
      if (
        !Number.isInteger(declaredSize)
        || declaredSize < 0
        || declaredSize > MAX_SINGLE_FILE_BYTES
        || !/^[a-f0-9]{64}$/.test(declaredHash)
        || encoded === undefined
        || encoded.length > Math.ceil(MAX_SINGLE_FILE_BYTES / 3) * 4 + 8
      ) {
        throw packageError('Downloaded Skill package file metadata is invalid.', 'BOT_SKILL_PACKAGE_FILES_INVALID');
      }
      const bytes = decodeBase64Exact(encoded, declaredSize);
      totalBytes += bytes.length;
      if (
        bytes.length !== declaredSize
        || totalBytes > MAX_TOTAL_BYTES
        || sha256(bytes) !== declaredHash
      ) {
        throw packageError('Downloaded Skill package bytes failed verification.', 'BOT_SKILL_PACKAGE_HASH_MISMATCH');
      }
      return { path: filePath, size: bytes.length, sha256: declaredHash, bytes };
    }).sort((a, b) => compareBotSkillSourcePath(a.path, b.path));
    if (!files.some(file => file.path === 'SKILL.md')) {
      throw packageError('Downloaded Skill package is missing SKILL.md.', 'BOT_SKILL_PACKAGE_ENTRY_MISSING');
    }
    if (computeBotSkillFilesContentHash(files) !== version.contentHash) {
      throw packageError('Downloaded Skill package content hash mismatch.', 'BOT_SKILL_PACKAGE_HASH_MISMATCH');
    }
    return { ...version, files };
  }

  private async request(method: string, apiPath: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${apiPath}`, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `ApiKey ${this.apiKey}`,
          'X-CatsCo-Bot-Id': this.botId,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal,
      });
      const text = await readResponseTextLimited(response, controller);
      if (!response.ok) {
        throw packageError(
          `Bot private Skill package request failed: HTTP ${response.status}`,
          safeServerErrorCode(text) || `BOT_SKILL_PACKAGE_HTTP_${response.status}`,
          response.status,
        );
      }
      try {
        return JSON.parse(text);
      } catch {
        throw packageError('Bot private Skill package response is invalid.', 'BOT_SKILL_PACKAGE_RESPONSE_INVALID');
      }
    } catch (error: any) {
      if (error?.name === 'BotPrivateSkillPackageError') throw error;
      throw packageError(
        error?.name === 'AbortError'
          ? 'Bot private Skill package request timed out.'
          : 'Bot private Skill package request failed.',
        error?.name === 'AbortError' ? 'BOT_SKILL_PACKAGE_TIMEOUT' : 'BOT_SKILL_PACKAGE_NETWORK_ERROR',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseVersion(
  value: unknown,
  expected?: {
    localSkillId: string;
    name: string;
    contentHash: string;
    origin?: { skillId: string; version: string };
  },
): BotPrivateSkillVersion {
  const raw = unwrapPackage(value);
  const reference = raw?.reference;
  normalizeBotSkillReferences([reference]);
  const localSkillId = String(raw?.localSkillId || '').trim();
  const name = String(raw?.name || '').trim();
  const contentHash = String(raw?.contentHash || '').trim();
  const createdAt = String(raw?.createdAt || '').trim();
  if (
    !/^[a-zA-Z0-9._:-]{1,160}$/.test(localSkillId)
    || !name
    || name.length > 256
    || !/^[a-f0-9]{64}$/.test(contentHash)
    || !Number.isFinite(Date.parse(createdAt))
    || (expected && localSkillId !== expected.localSkillId)
    || (expected && name !== expected.name)
    || (expected && contentHash !== expected.contentHash)
  ) {
    throw packageError('Bot private Skill package response mismatch.', 'BOT_SKILL_PACKAGE_RESPONSE_MISMATCH');
  }
  const origin = raw?.origin;
  if (origin !== undefined) normalizeBotSkillReferences([origin]);
  if (
    expected
    && (
      Boolean(origin) !== Boolean(expected.origin)
      || (
        origin
        && expected.origin
        && (
          origin.skillId !== expected.origin.skillId
          || origin.version !== expected.origin.version
        )
      )
    )
  ) {
    throw packageError('Bot private Skill package origin mismatch.', 'BOT_SKILL_PACKAGE_RESPONSE_MISMATCH');
  }
  return {
    reference,
    localSkillId,
    name,
    contentHash,
    createdAt,
    ...(origin ? { origin } : {}),
  };
}

function unwrapPackage(value: unknown): any {
  return (value as any)?.package ?? value as any;
}

async function readResponseTextLimited(response: Response, controller: AbortController): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    controller.abort();
    throw packageError('Bot private Skill package response is too large.', 'BOT_SKILL_PACKAGE_RESPONSE_TOO_LARGE');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      controller.abort();
      throw packageError('Bot private Skill package response is too large.', 'BOT_SKILL_PACKAGE_RESPONSE_TOO_LARGE');
    }
    chunks.push(Buffer.from(next.value));
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function safePackagePath(value: unknown): string {
  const filePath = String(value || '').replace(/\\/g, '/');
  if (
    !filePath
    || filePath.includes('\0')
    || filePath.startsWith('/')
    || /^[a-zA-Z]:/.test(filePath)
    || filePath.split('/').some(part => (
      part === ''
      || part === '.'
      || part === '..'
      || !portableWindowsSegment(part)
    ))
  ) {
    throw packageError('Downloaded Skill package path is unsafe.', 'BOT_SKILL_PACKAGE_PATH_UNSAFE');
  }
  return filePath;
}

function portableWindowsSegment(value: string): boolean {
  if (!value || /[<>:"|?*]/.test(value) || /[. ]$/.test(value)) return false;
  const stem = value.split('.')[0].toUpperCase();
  return !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem);
}

function decodeBase64Exact(value: string, declaredSize: number): Buffer {
  if (
    (value.length === 0 && declaredSize !== 0)
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
    || value.length % 4 !== 0
  ) {
    throw packageError('Downloaded Skill package encoding is invalid.', 'BOT_SKILL_PACKAGE_FILES_INVALID');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw packageError('Downloaded Skill package encoding is invalid.', 'BOT_SKILL_PACKAGE_FILES_INVALID');
  }
  return bytes;
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function safeServerErrorCode(text: string): string | undefined {
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
    throw packageError('SkillHub base URL is invalid.', 'BOT_SKILL_PACKAGE_BASE_URL_INVALID');
  }
  if (url.protocol === 'https:') return;
  if (
    allowInsecureHttp
    && url.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  ) {
    return;
  }
  throw packageError('SkillHub requires a trusted HTTPS endpoint.', 'BOT_SKILL_PACKAGE_BASE_URL_UNTRUSTED');
}

function packageError(message: string, code: string, status?: number): Error {
  const error: any = new Error(message);
  error.name = 'BotPrivateSkillPackageError';
  error.code = code;
  if (status !== undefined) error.status = status;
  return error;
}
