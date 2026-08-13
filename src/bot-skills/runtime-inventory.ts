import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CatsCoAuthSnapshot } from '../catscompany/local-config';
import type { Skill } from '../types/skill';
import { PathResolver } from '../utils/path-resolver';
import { readSkillHubInstallMarker } from '../skillhub/install-marker';

export const BOT_RUNTIME_SKILL_INVENTORY_SCHEMA = 'xiaoba.bot-runtime-skills.v1';
const INVENTORY_REQUEST_TIMEOUT_MS = 10_000;
const MAX_RUNTIME_SKILL_INVENTORY_ENTRIES = 256;
/** Keep headroom below CatsCo's request limit for proxies and future fields. */
export const MAX_RUNTIME_SKILL_INVENTORY_BYTES = 120 << 10;
const MAX_RUNTIME_SKILL_FILE_HASH_BYTES = 4 << 20;
const MAX_RUNTIME_SKILL_NAME_BYTES = 240;
const MAX_RUNTIME_SKILL_DESCRIPTION_BYTES = 4 << 10;
const MAX_RUNTIME_SKILL_PATH_BYTES = 512;
const MAX_RUNTIME_SKILL_ID_BYTES = 240;
const MAX_RUNTIME_SKILL_VERSION_BYTES = 120;
const MAX_RUNTIME_SKILL_RUNTIME_INSTANCE_ID_BYTES = 128;

export interface BotRuntimeSkillInventoryEntry {
  name: string;
  description: string;
  relativePath: string;
  userInvocable: boolean;
  /** SHA-256 of this loaded SKILL.md file, not the SkillHub package checksum. */
  fileHash?: string;
  skillHub?: {
    skillId: string;
    version: string;
    /** SHA-256 of the installed SkillHub package. */
    packageChecksumSha256?: string;
  };
}

interface LegacyBotRuntimeSkillInventory {
  schema: typeof BOT_RUNTIME_SKILL_INVENTORY_SCHEMA;
  botId: string;
  observedAt: string;
  skills: Array<{
    name: string;
    description: string;
    relativePath: string;
    userInvocable: boolean;
    contentHash?: string;
    skillHub?: {
      skillId: string;
      version: string;
      contentHash?: string;
    };
  }>;
  truncated?: boolean;
}

export interface BotRuntimeSkillInventory {
  schema: typeof BOT_RUNTIME_SKILL_INVENTORY_SCHEMA;
  botId: string;
  observedAt: string;
  runtimeInstanceId?: string;
  reportSequence?: number;
  skills: BotRuntimeSkillInventoryEntry[];
  truncated?: boolean;
}

export interface BotRuntimeSkillInventoryRuntimeMetadata {
  runtimeInstanceId?: string;
  reportSequence?: number;
}

export interface ReportBotRuntimeSkillInventoryOptions {
  botId: string;
  auth: Pick<CatsCoAuthSnapshot, 'apiKey' | 'httpBaseUrl'>;
  skills: readonly Skill[];
  inventory?: BotRuntimeSkillInventory;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

export async function createBotRuntimeSkillInventory(
  botId: string,
  skills: readonly Skill[],
  now: () => Date = () => new Date(),
  runtime: BotRuntimeSkillInventoryRuntimeMetadata = {},
): Promise<BotRuntimeSkillInventory> {
  const skillsRoot = path.resolve(PathResolver.getSkillsPath());
  const runtimeInstanceId = String(runtime.runtimeInstanceId || '').trim();
  const reportSequence = Number(runtime.reportSequence || 0);
  const validRuntimeInstanceId = validRuntimeText(
    runtimeInstanceId,
    MAX_RUNTIME_SKILL_RUNTIME_INSTANCE_ID_BYTES,
    false,
  );
  const sortedSkills = [...skills].sort((left, right) => (
    String(left.metadata.name || '').trim().localeCompare(String(right.metadata.name || '').trim())
  ));
  const allEntries: Array<{ entry: BotRuntimeSkillInventoryEntry; degraded: boolean }> = [];
  for (const skill of sortedSkills.slice(0, MAX_RUNTIME_SKILL_INVENTORY_ENTRIES)) {
    const entry = await createRuntimeSkillInventoryEntry(skill, skillsRoot);
    if (entry) allEntries.push(entry);
  }
  allEntries.sort((left, right) => left.entry.name.localeCompare(right.entry.name));

  const base: Omit<BotRuntimeSkillInventory, 'skills' | 'truncated'> = {
    schema: BOT_RUNTIME_SKILL_INVENTORY_SCHEMA,
    botId: String(botId || '').trim(),
    observedAt: now().toISOString(),
    ...(validRuntimeInstanceId
      ? { runtimeInstanceId }
      : {}),
    ...(Number.isSafeInteger(reportSequence) && reportSequence > 0 && validRuntimeInstanceId
      ? { reportSequence }
      : {}),
  };
  const entries: BotRuntimeSkillInventoryEntry[] = [];
  let truncated = sortedSkills.length > MAX_RUNTIME_SKILL_INVENTORY_ENTRIES
    || allEntries.length !== Math.min(sortedSkills.length, MAX_RUNTIME_SKILL_INVENTORY_ENTRIES);
  for (const { entry: candidate, degraded } of allEntries.slice(0, MAX_RUNTIME_SKILL_INVENTORY_ENTRIES)) {
    const fitted = fitRuntimeSkillInventoryEntry(base, entries, candidate);
    if (!fitted) {
      truncated = true;
      continue;
    }
    if (degraded || JSON.stringify(fitted) !== JSON.stringify(candidate)) truncated = true;
    entries.push(fitted);
  }

  // The fitting loop reserves the truncation marker. Keep this defensive
  // guard in case the envelope changes later.
  while (serializedInventoryBytes({ ...base, skills: entries, ...(truncated ? { truncated: true } : {}) }) > MAX_RUNTIME_SKILL_INVENTORY_BYTES) {
    if (entries.length === 0) break;
    entries.pop();
    truncated = true;
  }
  return {
    ...base,
    skills: entries,
    ...(truncated ? { truncated: true } : {}),
  };
}

export async function reportBotRuntimeSkillInventory(
  options: ReportBotRuntimeSkillInventoryOptions,
): Promise<boolean> {
  const botId = String(options.botId || '').trim();
  const apiKey = String(options.auth.apiKey || '').trim();
  const httpBaseUrl = String(options.auth.httpBaseUrl || '').trim().replace(/\/+$/, '');
  if (!botId || !apiKey || !httpBaseUrl) return false;

  const inventory = options.inventory ?? createBotRuntimeSkillInventory(botId, options.skills, options.now);
  const resolvedInventory = await inventory;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INVENTORY_REQUEST_TIMEOUT_MS);
  try {
    const send = (body: unknown) => (options.fetchImpl ?? fetch)(`${httpBaseUrl}/api/bot/skills/inventory`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `ApiKey ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let response = await send(resolvedInventory);
    // Older CatsCo deployments intentionally remain compatible until their
    // server is upgraded. Other failures are caller-observable for logging.
    if ([404, 405, 501].includes(response.status)) return false;
    if (response.status === 400 || response.status === 422) {
      // The first v1 server used contentHash and did not know the runtime
      // instance/sequence fields. Retry once with that exact legacy shape.
      response = await send(toLegacyRuntimeSkillInventory(resolvedInventory));
      if ([404, 405, 501].includes(response.status)) return false;
    }
    if (!response.ok) {
      throw new Error(`CatsCo runtime Skill inventory request failed: ${response.status}`);
    }
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

async function createRuntimeSkillInventoryEntry(
  skill: Skill,
  skillsRoot: string,
): Promise<{ entry: BotRuntimeSkillInventoryEntry; degraded: boolean } | undefined> {
  const skillFile = path.resolve(skill.filePath);
  const relativePath = relativePathInside(skillsRoot, skillFile);
  const name = String(skill.metadata.name || '').trim();
  if (!validRuntimeText(name, MAX_RUNTIME_SKILL_NAME_BYTES, false)
    || !validRuntimeRelativePath(relativePath)) return undefined;
  const skillDir = path.dirname(skillFile);
  const marker = readSkillHubInstallMarker(skillDir);
  const fileHash = await fileSHA256(skillFile);
  const skillHubID = String(marker?.skillId || '').trim();
  const skillHubVersion = String(marker?.version || '').trim();
  const packageChecksumSha256 = String(marker?.packageChecksumSha256 || '').trim().toLowerCase();
  const skillHubReference = marker
    && isValidSkillHubReference(skillHubID, skillHubVersion)
    && /^[a-f0-9]{64}$/.test(packageChecksumSha256)
    ? {
        skillId: skillHubID,
        version: skillHubVersion,
        packageChecksumSha256,
      }
    : undefined;
  const originalDescription = sanitizeRuntimeDescription(String(skill.metadata.description || '').trim());
  const description = truncateUtf8(originalDescription, MAX_RUNTIME_SKILL_DESCRIPTION_BYTES);
  return { entry: {
    name,
    description,
    relativePath,
    userInvocable: skill.metadata.userInvocable !== false,
    ...(fileHash.value ? { fileHash: fileHash.value } : {}),
    ...(skillHubReference ? { skillHub: skillHubReference } : {}),
  }, degraded: description !== originalDescription || Boolean(fileHash.exceededLimit) };
}

function isValidSkillHubReference(skillId: string, version: string): boolean {
  const normalizedID = String(skillId || '').trim();
  const normalizedVersion = String(version || '').trim();
  return Boolean(
    normalizedID
    && normalizedVersion
    && !normalizedID.split('/').some(part => !part || part === '.' || part === '..')
    && Buffer.byteLength(normalizedID, 'utf8') <= MAX_RUNTIME_SKILL_ID_BYTES
    && Buffer.byteLength(normalizedVersion, 'utf8') <= MAX_RUNTIME_SKILL_VERSION_BYTES
    && !normalizedID.includes('\\')
    && !normalizedVersion.includes('/')
    && !normalizedVersion.includes('\\')
    && normalizedVersion !== '.'
    && normalizedVersion !== '..'
    && !/\p{Cc}/u.test(normalizedID)
    && !/\p{Cc}/u.test(normalizedVersion),
  );
}

function relativePathInside(root: string, candidate: string): string {
  const relative = path.relative(root, candidate).replace(/\\/g, '/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) {
    // A skill created by a local generated-capability registry may not sit in
    // the active Skills root. Never leak that absolute runtime location.
    return `external/${path.basename(candidate)}`;
  }
  return relative;
}

function validRuntimeText(value: string, maxBytes: number, allowEmpty: boolean): boolean {
  return (allowEmpty || value.length > 0)
    && Buffer.byteLength(value, 'utf8') <= maxBytes
    && !/\p{Cc}/u.test(value);
}

function sanitizeRuntimeDescription(value: string): string {
  return value.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
}

function validRuntimeRelativePath(value: string): boolean {
  if (!validRuntimeText(value, MAX_RUNTIME_SKILL_PATH_BYTES, false)
    || value.startsWith('/')
    || value.includes('\\')
    || path.posix.isAbsolute(value)
    || /^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((part) => part && part !== '.' && part !== '..');
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let length = 0;
  let result = '';
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (length + characterBytes > maxBytes) break;
    result += character;
    length += characterBytes;
  }
  return result;
}

function serializedInventoryBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function fitRuntimeSkillInventoryEntry(
  base: Omit<BotRuntimeSkillInventory, 'skills' | 'truncated'>,
  existing: BotRuntimeSkillInventoryEntry[],
  candidate: BotRuntimeSkillInventoryEntry,
): BotRuntimeSkillInventoryEntry | undefined {
  const variants = [
    candidate,
    withoutPackageChecksum(candidate),
    withoutFileHash(candidate),
    withoutFileHash(withoutPackageChecksum(candidate)),
  ];
  for (const variant of variants) {
    if (serializedInventoryBytes({ ...base, skills: [...existing, variant], truncated: true }) <= MAX_RUNTIME_SKILL_INVENTORY_BYTES) {
      return variant;
    }
  }
  for (const variant of variants) {
    const descriptionBytes = Buffer.byteLength(variant.description, 'utf8');
    let low = 0;
    let high = descriptionBytes;
    let best: BotRuntimeSkillInventoryEntry | undefined;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const fitted = { ...variant, description: truncateUtf8(variant.description, middle) };
      if (serializedInventoryBytes({ ...base, skills: [...existing, fitted], truncated: true }) <= MAX_RUNTIME_SKILL_INVENTORY_BYTES) {
        best = fitted;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (best) return best;
  }
  return undefined;
}

function withoutPackageChecksum(entry: BotRuntimeSkillInventoryEntry): BotRuntimeSkillInventoryEntry {
  if (!entry.skillHub?.packageChecksumSha256) return entry;
  const { packageChecksumSha256: _checksum, ...skillHub } = entry.skillHub;
  return { ...entry, skillHub };
}

function withoutFileHash(entry: BotRuntimeSkillInventoryEntry): BotRuntimeSkillInventoryEntry {
  if (!entry.fileHash) return entry;
  const { fileHash: _fileHash, ...rest } = entry;
  return rest;
}

function toLegacyRuntimeSkillInventory(inventory: BotRuntimeSkillInventory): LegacyBotRuntimeSkillInventory {
  return {
    schema: inventory.schema,
    botId: inventory.botId,
    observedAt: inventory.observedAt,
    skills: inventory.skills.map((entry) => ({
      name: entry.name,
      description: entry.description,
      relativePath: entry.relativePath,
      userInvocable: entry.userInvocable,
      ...(entry.fileHash ? { contentHash: entry.fileHash } : {}),
      ...(entry.skillHub ? {
        skillHub: {
          skillId: entry.skillHub.skillId,
          version: entry.skillHub.version,
          ...(entry.skillHub.packageChecksumSha256
            ? { contentHash: entry.skillHub.packageChecksumSha256 }
            : {}),
        },
      } : {}),
    })),
    ...(inventory.truncated ? { truncated: true } : {}),
  };
}

async function fileSHA256(filePath: string): Promise<{ value?: string; exceededLimit?: boolean }> {
  let stream: fs.ReadStream | undefined;
  let bytesRead = 0;
  try {
    const hash = crypto.createHash('sha256');
    stream = fs.createReadStream(filePath);
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      bytesRead += buffer.length;
      if (bytesRead > MAX_RUNTIME_SKILL_FILE_HASH_BYTES) {
        stream.destroy();
        return { exceededLimit: true };
      }
      hash.update(buffer);
    }
    return { value: hash.digest('hex') };
  } catch {
    stream?.destroy();
    return {};
  }
}
