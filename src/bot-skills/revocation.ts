import * as fs from 'fs';
import * as path from 'path';
import { FileBotDefinitionRepository } from '../bot-definition/repository';
import type { BotDefinition, BotSkillRef } from '../bot-definition/types';
import { canonicalizeBotSkillRefs } from './canonical';
import { requireSafeDirectory, requireSafeRuntimeDataDirectory } from './safe-directory';
import { PathResolver } from '../utils/path-resolver';

const REVOCATION_SCHEMA = 'xiaoba.bot-skill-revocations.v1';

interface RevocationState {
  schema: typeof REVOCATION_SCHEMA;
  botId: string;
  references: BotSkillRef[];
}

/**
 * Reads the latest locally accepted BotDefinition for a CatsCo Runtime.
 * `undefined` means the Runtime has no usable local authority yet; callers
 * should preserve the legacy behavior in that case.
 */
export function readActiveBotDefinition(agentId: string): BotDefinition | undefined {
  const normalizedAgentId = String(agentId || '').trim();
  if (!normalizedAgentId) return undefined;
  try {
    const repository = new FileBotDefinitionRepository({
      runtimeRoot: PathResolver.getRuntimeDataRoot(),
    });
    const candidates = [normalizedAgentId];
    // CatsCo envelopes identify bots as `usr<botId>`, while BotDefinition is
    // keyed by the canonical bot id. Keep this mapping intentionally narrow.
    const prefixed = /^usr([A-Za-z0-9_.-]+)$/i.exec(normalizedAgentId);
    if (prefixed?.[1]) candidates.push(prefixed[1]);
    for (const candidate of candidates) {
      const definition = repository.readCache(candidate) ?? repository.readCanonical(candidate);
      if (definition) return definition;
    }
  } catch {
    // A missing/corrupt local Definition must not change legacy Skill behavior.
  }
  return undefined;
}

/**
 * Returns true only when the current BotDefinition explicitly contains this
 * exact installed package. Undefined means revocation cannot be established
 * (legacy Definition or unavailable cache), so existing behavior is retained.
 */
export function isBotSkillReferenceActive(
  agentId: string,
  reference: BotSkillRef,
): boolean | undefined {
  let pending: BotSkillRef[] | undefined;
  try {
    pending = readPendingBotSkillRevocations(agentId);
  } catch {
    // A malformed or unavailable revocation record must not crash an
    // otherwise valid Skill turn; the authoritative Definition check below
    // remains the fallback.
  }
  if (pending?.some(candidate => sameReference(candidate, reference))) return false;
  const definition = readActiveBotDefinition(agentId);
  if (!definition || definition.skills === undefined) return undefined;
  return definition.skills.some(candidate => (
    candidate.source === reference.source
    && candidate.skillId === reference.skillId
    && candidate.version === reference.version
    && candidate.contentHash === reference.contentHash
  ));
}

/**
 * Records an owner-requested uninstall before returning the delete RPC. This
 * durable local deny-list closes the interval while the CAS update to CatsCo
 * is pending or unavailable, and survives a Runtime restart.
 */
export function recordPendingBotSkillRevocation(
  agentId: string,
  reference: BotSkillRef,
  runtimeRoot = PathResolver.getRuntimeDataRoot(),
): void {
  const botId = canonicalBotId(agentId);
  if (!botId) throw new Error('A canonical Bot ID is required to revoke a Skill.');
  const [canonical] = canonicalizeBotSkillRefs([reference]);
  const filePath = revocationStatePath(runtimeRoot, botId, true);
  if (!filePath || !canonical) throw new Error('Bot Skill revocation state could not be prepared.');
  const current = readRevocationState(filePath, botId)?.references ?? [];
  const references = canonicalizeBotSkillRefs([...current, canonical]);
  writeRevocationState(filePath, { schema: REVOCATION_SCHEMA, botId, references });
}

/** Removes only revocations that the latest accepted Cloud set no longer has. */
export function reconcilePendingBotSkillRevocations(
  botIdValue: string,
  activeReferences: readonly BotSkillRef[],
  runtimeRoot = PathResolver.getRuntimeDataRoot(),
): void {
  const botId = canonicalBotId(botIdValue);
  if (!botId) return;
  const filePath = revocationStatePath(runtimeRoot, botId, false);
  if (!filePath || !fs.existsSync(filePath)) return;
  const current = readRevocationState(filePath, botId);
  if (!current) return; // Preserve invalid evidence; never delete it as cleanup.
  const stillPending = current.references.filter(reference => (
    activeReferences.some(active => sameReference(active, reference))
  ));
  if (stillPending.length === current.references.length) return;
  if (stillPending.length === 0) {
    fs.rmSync(filePath, { force: false });
    return;
  }
  writeRevocationState(filePath, { ...current, references: stillPending });
}

/** Rolls back a just-recorded revocation when the protected workspace move fails. */
export function clearPendingBotSkillRevocation(
  agentId: string,
  reference: BotSkillRef,
  runtimeRoot = PathResolver.getRuntimeDataRoot(),
): void {
  const botId = canonicalBotId(agentId);
  if (!botId) return;
  const filePath = revocationStatePath(runtimeRoot, botId, false);
  if (!filePath || !fs.existsSync(filePath)) return;
  const current = readRevocationState(filePath, botId);
  if (!current) return;
  const remaining = current.references.filter(candidate => !sameReference(candidate, reference));
  if (remaining.length === current.references.length) return;
  if (remaining.length === 0) fs.rmSync(filePath, { force: false });
  else writeRevocationState(filePath, { ...current, references: remaining });
}

/** Returns the pending owner revocations for a Bot; malformed evidence is ignored and preserved. */
export function readPendingBotSkillRevocations(
  agentId: string,
  runtimeRoot = PathResolver.getRuntimeDataRoot(),
): BotSkillRef[] | undefined {
  const botId = canonicalBotId(agentId);
  if (!botId) return undefined;
  const filePath = revocationStatePath(runtimeRoot, botId, false);
  if (!filePath || !fs.existsSync(filePath)) return undefined;
  return readRevocationState(filePath, botId)?.references;
}

function canonicalBotId(value: string): string | undefined {
  const normalized = String(value || '').trim();
  const prefixed = /^usr([A-Za-z0-9_.-]+)$/i.exec(normalized);
  const botId = prefixed?.[1] ?? normalized;
  return /^[A-Za-z0-9_.-]{1,160}$/.test(botId) ? botId : undefined;
}

function revocationStatePath(runtimeRoot: string, botId: string, create: boolean): string | undefined {
  const resolvedRoot = path.resolve(runtimeRoot);
  const dataRoot = create
    ? requireSafeRuntimeDataDirectory(resolvedRoot, 'Bot Skill revocation state')
    : path.join(resolvedRoot, 'data');
  if (!create && !fs.existsSync(dataRoot)) return undefined;
  if (!create) {
    const runtime = requireSafeDirectory(resolvedRoot, 'Runtime root');
    if (path.resolve(runtime) !== resolvedRoot) throw new Error('Runtime root is not canonical.');
    if (fs.lstatSync(dataRoot).isSymbolicLink()) {
      // Shared release data is supported; resolve it only after the Runtime root is verified.
      fs.realpathSync(dataRoot);
    } else requireSafeDirectory(dataRoot, 'Runtime data directory');
  }
  let current = dataRoot;
  for (const segment of ['bot-skills', 'revocations']) {
    const child = path.join(current, segment);
    if (!fs.existsSync(child)) {
      if (!create) return undefined;
      try { fs.mkdirSync(child, { recursive: false }); } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    current = requireSafeDirectory(child, 'Bot Skill revocation directory');
  }
  return path.join(current, `${botId}.json`);
}

function readRevocationState(filePath: string, botId: string): RevocationState | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<RevocationState>;
    if (parsed.schema !== REVOCATION_SCHEMA || parsed.botId !== botId || !Array.isArray(parsed.references)) {
      return undefined;
    }
    return {
      schema: REVOCATION_SCHEMA,
      botId,
      references: canonicalizeBotSkillRefs(parsed.references),
    };
  } catch {
    return undefined;
  }
}

function writeRevocationState(filePath: string, state: RevocationState): void {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function sameReference(left: BotSkillRef, right: BotSkillRef): boolean {
  return left.source === right.source
    && left.skillId === right.skillId
    && left.version === right.version
    && left.contentHash === right.contentHash;
}
