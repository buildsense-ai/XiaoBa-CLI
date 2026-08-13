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

export interface BotRuntimeSkillInventory {
  schema: typeof BOT_RUNTIME_SKILL_INVENTORY_SCHEMA;
  botId: string;
  observedAt: string;
  runtimeInstanceId?: string;
  reportSequence?: number;
  skills: BotRuntimeSkillInventoryEntry[];
  truncated?: boolean;
}

export interface ReportBotRuntimeSkillInventoryOptions {
  botId: string;
  auth: Pick<CatsCoAuthSnapshot, 'apiKey' | 'httpBaseUrl'>;
  skills: readonly Skill[];
  inventory?: BotRuntimeSkillInventory;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

export function createBotRuntimeSkillInventory(
  botId: string,
  skills: readonly Skill[],
  now: () => Date = () => new Date(),
): BotRuntimeSkillInventory {
  const skillsRoot = path.resolve(PathResolver.getSkillsPath());
  const allEntries = skills.map((skill) => createRuntimeSkillInventoryEntry(skill, skillsRoot))
    .sort((left, right) => left.name.localeCompare(right.name));
  const entries = allEntries.slice(0, MAX_RUNTIME_SKILL_INVENTORY_ENTRIES);
  return {
    schema: BOT_RUNTIME_SKILL_INVENTORY_SCHEMA,
    botId: String(botId || '').trim(),
    observedAt: now().toISOString(),
    skills: entries,
    ...(allEntries.length > entries.length ? { truncated: true } : {}),
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INVENTORY_REQUEST_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl ?? fetch)(`${httpBaseUrl}/api/bot/skills/inventory`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `ApiKey ${apiKey}`,
      },
      body: JSON.stringify(inventory),
      signal: controller.signal,
    });
    // Older CatsCo deployments intentionally remain compatible until their
    // server is upgraded. Other failures are caller-observable for logging.
    if ([404, 405, 501].includes(response.status)) return false;
    if (!response.ok) {
      throw new Error(`CatsCo runtime Skill inventory request failed: ${response.status}`);
    }
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

function createRuntimeSkillInventoryEntry(skill: Skill, skillsRoot: string): BotRuntimeSkillInventoryEntry {
  const skillFile = path.resolve(skill.filePath);
  const relativePath = relativePathInside(skillsRoot, skillFile);
  const skillDir = path.dirname(skillFile);
  const marker = readSkillHubInstallMarker(skillDir);
  const contentHash = fileSHA256(skillFile);
  const skillHubReference = marker
    && isValidSkillHubReference(marker.skillId, marker.version)
    && /^[a-f0-9]{64}$/.test(String(marker.packageChecksumSha256 || '').toLowerCase())
    ? {
        skillId: marker.skillId,
        version: marker.version,
        packageChecksumSha256: marker.packageChecksumSha256.toLowerCase(),
      }
    : undefined;
  return {
    name: String(skill.metadata.name || '').trim(),
    description: String(skill.metadata.description || '').trim(),
    relativePath,
    userInvocable: skill.metadata.userInvocable !== false,
    ...(contentHash ? { fileHash: contentHash } : {}),
    ...(skillHubReference ? { skillHub: skillHubReference } : {}),
  };
}

function isValidSkillHubReference(skillId: string, version: string): boolean {
  const normalizedID = String(skillId || '').trim();
  const normalizedVersion = String(version || '').trim();
  return Boolean(
    normalizedID
    && normalizedVersion
    && !normalizedID.split('/').some(part => !part || part === '.' || part === '..')
    && !normalizedID.includes('\\')
    && normalizedVersion !== '.'
    && normalizedVersion !== '..'
    && !/[\u0000-\u001f\u007f]/.test(normalizedID)
    && !/[\u0000-\u001f\u007f]/.test(normalizedVersion),
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

function fileSHA256(filePath: string): string | undefined {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return undefined;
  }
}
