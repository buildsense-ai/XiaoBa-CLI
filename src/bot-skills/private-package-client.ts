import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { CatsCoAuthSnapshot } from '../catscompany/local-config';
import type { BotSkillRef } from '../bot-definition/types';
import { writeSkillHubInstallMarker } from '../skillhub/install-marker';
import { loadSkillHubConfig } from '../skillhub/config';
import {
  computeBotSkillPackageHash,
  isPortablePackagePath,
  writeBotSkillLocalMarker,
} from './local-manifest';
import type {
  BotSkillPackage,
  BotSkillPackageFile,
  LocalBotSkillManifestEntry,
  SkillHubPackageRef,
} from './types';

const PRIVATE_PACKAGE_SCHEMA = 'catsco.private-skill-package.v1';
const PRIVATE_PACKAGE_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_SINGLE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export interface BotPrivateSkillClientOptions {
  auth: CatsCoAuthSnapshot;
  botId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class BotPrivateSkillClient {
  private readonly auth: CatsCoAuthSnapshot;
  private readonly botId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BotPrivateSkillClientOptions) {
    this.auth = options.auth;
    this.botId = String(options.botId || '').trim();
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(this.botId)) {
      throw new Error('A valid CatsCo Bot ID is required for private Skill sync.');
    }
    const authBotId = String(options.auth.botUid || '').trim();
    if (authBotId && authBotId !== this.botId) {
      throw new Error('CatsCo Bot auth identity does not match the Skill workspace.');
    }
    this.baseUrl = loadSkillHubConfig({ baseUrl: options.baseUrl }).baseUrl;
    assertPrivateSkillBaseUrl(this.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async upsert(entry: LocalBotSkillManifestEntry): Promise<BotSkillPackage> {
    const response = await this.request('PUT', '/api/bot/private-skill-packages', {
      localSkillId: entry.localSkillId,
      name: entry.name,
      contentHash: entry.contentHash,
      ...(entry.origin ? { origin: entry.origin } : {}),
      files: entry.files,
    });
    const reference = parsePackageReference(response?.reference);
    if (
      String(response?.localSkillId || '') !== entry.localSkillId
      || String(response?.name || '') !== entry.name
      || String(response?.contentHash || '') !== entry.contentHash
    ) {
      throw new Error('SkillHub returned mismatched private Skill metadata.');
    }
    return {
      schema: PRIVATE_PACKAGE_SCHEMA,
      source: 'private',
      reference,
      localSkillId: entry.localSkillId,
      name: entry.name,
      contentHash: entry.contentHash,
      createdAt: String(response?.createdAt || ''),
      ...(response?.origin ? { origin: parsePackageReference(response.origin) } : {}),
      files: entry.files,
    };
  }

  async download(reference: BotSkillRef): Promise<BotSkillPackage> {
    const expected = parsePackageReference(reference);
    const skillId = encodeReferencePath(expected.skillId);
    const version = encodeURIComponent(expected.version);
    const response = await this.request(
      'GET',
      `/api/bot/skill-packages/${skillId}/versions/${version}`,
    );
    const packageValue = validateDownloadedPackage(response, expected);
    if (packageValue.contentHash !== reference.contentHash) {
      throw new Error('SkillHub package does not match the BotDefinition contentHash.');
    }
    return packageValue;
  }

  async materialize(
    packageValue: BotSkillPackage,
    skillsRoot: string,
    preferredInstallName?: string,
  ): Promise<string> {
    let installName = preferredInstallName === undefined
      ? safeSkillDirectoryName(packageValue.name)
      : normalizePreferredInstallName(preferredInstallName);
    let target = safeJoin(skillsRoot, installName);
    if (fs.existsSync(target) && !preferredInstallName) {
      installName = `${installName.slice(0, 60)}-${packageValue.localSkillId.slice(-12)}`;
      target = safeJoin(skillsRoot, installName);
    }
    if (fs.existsSync(target)) {
      throw new Error(`Duplicate Skill install directory in cloud workspace: ${installName}`);
    }
    fs.mkdirSync(target, { recursive: true });
    for (const file of packageValue.files) {
      const destination = safeJoin(target, file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, Buffer.from(file.contentBase64, 'base64'));
    }
    writeBotSkillLocalMarker(target, {
      schema: 'xiaoba.bot-skill-local.v1',
      localSkillId: packageValue.localSkillId,
      reference: {
        source: 'skillhub',
        ...packageValue.reference,
        contentHash: packageValue.contentHash,
      },
      origin: packageValue.origin ?? packageValue.reference,
    });
    if (packageValue.source === 'public') {
      writeSkillHubInstallMarker(target, {
        source: 'skillhub',
        skillId: packageValue.reference.skillId,
        name: packageValue.name,
        installName,
        version: packageValue.reference.version,
        packageChecksumSha256: packageValue.contentHash,
        signature: {
          algorithm: 'ed25519',
          keyId: 'restored-via-skillhub',
          signature: '',
        },
        packageUrl: '',
        installedAt: packageValue.createdAt || new Date().toISOString(),
      });
    }
    return target;
  }

  private async request(method: string, apiPath: string, body?: unknown): Promise<any> {
    const apiKey = String(this.auth.apiKey || '').trim();
    if (!apiKey) throw new Error('CatsCo Bot API key is required for private Skill sync.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PRIVATE_PACKAGE_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${apiPath}`, {
        method,
        headers: {
          Authorization: `ApiKey ${apiKey}`,
          'X-CatsCo-Bot-Id': this.botId,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal,
      });
      const text = await readTextLimited(response, controller);
      let data: any = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }
      }
      if (!response.ok) {
        const error = new Error(String(
          data?.error?.message
          || data?.message
          || data?.error
          || `SkillHub private package request failed: ${response.status}`,
        ));
        (error as any).status = response.status;
        (error as any).code = data?.error?.code || data?.code;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function validateDownloadedPackage(value: unknown, expected: SkillHubPackageRef): BotSkillPackage {
  const input = value as Partial<BotSkillPackage>;
  const reference = parsePackageReference(input?.reference);
  if (
    (input?.schema !== undefined && input.schema !== PRIVATE_PACKAGE_SCHEMA)
    || reference.skillId !== expected.skillId
    || reference.version !== expected.version
    || !/^[A-Za-z0-9._:-]{1,160}$/.test(String(input.localSkillId || ''))
    || !String(input.name || '').trim()
    || String(input.name).length > 256
    || !Array.isArray(input.files)
    || input.files.length === 0
    || input.files.length > MAX_FILES
  ) {
    throw new Error('SkillHub returned an invalid private Skill package.');
  }
  const files = input.files.map(validatePackageFile)
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const seenPaths = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    const pathKey = file.path.toLocaleLowerCase('en-US');
    if (seenPaths.has(pathKey)) {
      throw new Error(`SkillHub package contains a duplicate file path: ${file.path}`);
    }
    seenPaths.add(pathKey);
    totalBytes += file.size;
  }
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error('SkillHub package is too large.');
  if (!files.some(file => file.path === 'SKILL.md')) {
    throw new Error('SkillHub package is missing SKILL.md.');
  }
  const contentHash = computeBotSkillPackageHash(files);
  if (contentHash !== input.contentHash) {
    throw new Error('SkillHub package content hash does not match.');
  }
  return {
    schema: PRIVATE_PACKAGE_SCHEMA,
    source: input.schema === undefined ? 'public' : 'private',
    reference,
    localSkillId: String(input.localSkillId),
    name: String(input.name).trim(),
    contentHash,
    createdAt: String(input.createdAt || ''),
    ...(input.origin ? { origin: parsePackageReference(input.origin) } : {}),
    files,
  };
}

function validatePackageFile(value: BotSkillPackageFile): BotSkillPackageFile {
  const filePath = String(value?.path || '').replace(/\\/g, '/');
  const size = Number(value?.size);
  const fileHash = String(value?.sha256 || '');
  if (
    !isPortablePackagePath(filePath)
    || !Number.isInteger(size)
    || size < 0
    || size > MAX_SINGLE_FILE_BYTES
    || !/^[a-f0-9]{64}$/.test(fileHash)
    || typeof value?.contentBase64 !== 'string'
  ) {
    throw new Error('SkillHub package contains an invalid file.');
  }
  const bytes = Buffer.from(value.contentBase64, 'base64');
  if (
    bytes.toString('base64') !== value.contentBase64
    || bytes.length !== size
    || sha256(bytes) !== fileHash
  ) {
    throw new Error(`SkillHub package file integrity failed: ${filePath}`);
  }
  return { path: filePath, size, sha256: fileHash, contentBase64: value.contentBase64 };
}

function parsePackageReference(value: unknown): SkillHubPackageRef {
  const raw = value as Partial<SkillHubPackageRef> | undefined;
  const skillId = String(raw?.skillId || '').trim();
  const version = String(raw?.version || '').trim();
  if (
    !skillId
    || !version
    || skillId.split('/').some(part => !part || part === '.' || part === '..')
    || version === '.'
    || version === '..'
  ) {
    throw new Error('SkillHub returned an invalid Skill reference.');
  }
  return { skillId, version };
}

function encodeReferencePath(skillId: string): string {
  return String(skillId || '').split('/').map(encodeURIComponent).join('/');
}

function safeSkillDirectoryName(value: string): string {
  const direct = String(value || '').trim();
  if (
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(direct)
    && isPortablePackagePath(direct)
  ) {
    return direct;
  }
  const normalized = direct.toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (normalized && isPortablePackagePath(normalized)) return normalized;
  return `skill-${crypto.createHash('sha256').update(direct).digest('hex').slice(0, 16)}`;
}

function normalizePreferredInstallName(value: string): string {
  const input = String(value || '');
  const normalized = input.replace(/\\/g, '/').normalize('NFC');
  if (normalized !== normalized.trim() || !isPortablePackagePath(normalized)) {
    throw new Error(`Cloud Skill has an unsafe install directory: ${input}`);
  }
  return normalized;
}

function safeJoin(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Skill package path escaped its target: ${relative}`);
  }
  return target;
}

function sha256(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertPrivateSkillBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('SkillHub private sync base URL is invalid.');
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('SkillHub private sync requires HTTPS.');
  }
}

async function readTextLimited(response: Response, controller: AbortController): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    controller.abort();
    throw new Error('SkillHub response is too large.');
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
      throw new Error('SkillHub response is too large.');
    }
    chunks.push(Buffer.from(next.value));
  }
  return Buffer.concat(chunks, total).toString('utf8');
}
