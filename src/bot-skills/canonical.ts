import type { BotSkillReference } from '../bot-definition/types';
import type {
  BotLocalSkillSnapshot,
  BotSkillSyncBase,
  BotSkillSyncBaseEntry,
} from './types';

export function normalizeBotSkillReferences(
  references: readonly BotSkillReference[],
): BotSkillReference[] {
  const normalized = references.map(reference => ({
    skillId: String(reference.skillId || '').trim(),
    version: String(reference.version || '').trim(),
  }));
  const seen = new Set<string>();
  for (const reference of normalized) {
    if (
      !validCloudText(reference.skillId, 240)
      || !validCloudText(reference.version, 120)
    ) {
      throw new Error('Bot Skill reference is missing skillId or version.');
    }
    if (seen.has(reference.skillId)) throw new Error(`Duplicate Bot Skill reference: ${reference.skillId}`);
    seen.add(reference.skillId);
  }
  return normalized.sort(compareReferences);
}

export function botSkillReferencesEqual(
  left: readonly BotSkillReference[],
  right: readonly BotSkillReference[],
): boolean {
  const a = normalizeBotSkillReferences(left);
  const b = normalizeBotSkillReferences(right);
  return a.length === b.length && a.every((item, index) => (
    item.skillId === b[index].skillId && item.version === b[index].version
  ));
}

export function normalizeBotSkillSyncBaseEntries(
  entries: readonly BotSkillSyncBaseEntry[],
): BotSkillSyncBaseEntry[] {
  if (!Array.isArray(entries) || entries.length > 256) {
    throw new Error('Bot Skill sync base contains too many entries.');
  }
  const normalized = entries.map(entry => ({
    localSkillId: String(entry.localSkillId || '').trim(),
    localContentHash: String(entry.localContentHash || '').trim(),
    cloudSkillId: String(entry.cloudSkillId || '').trim(),
    cloudVersion: String(entry.cloudVersion || '').trim(),
  }));
  const localIds = new Set<string>();
  const cloudRefs = new Set<string>();
  for (const entry of normalized) {
    if (
      !/^[a-zA-Z0-9_.:-]{1,160}$/.test(entry.localSkillId)
      || !/^[a-f0-9]{64}$/.test(entry.localContentHash)
      || !validCloudText(entry.cloudSkillId, 240)
      || !validCloudText(entry.cloudVersion, 120)
    ) {
      throw new Error('Bot Skill sync base entry is incomplete.');
    }
    if (localIds.has(entry.localSkillId)) {
      throw new Error(`Duplicate localSkillId in Bot Skill sync base: ${entry.localSkillId}`);
    }
    const cloudKey = `${entry.cloudSkillId}\0${entry.cloudVersion}`;
    if (cloudRefs.has(cloudKey)) {
      throw new Error(`Duplicate cloud Skill reference in Bot Skill sync base: ${entry.cloudSkillId}@${entry.cloudVersion}`);
    }
    localIds.add(entry.localSkillId);
    cloudRefs.add(cloudKey);
  }
  return normalized.sort((a, b) => a.localSkillId.localeCompare(b.localSkillId));
}

function validCloudText(value: string, maxLength: number): boolean {
  return Boolean(value) && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}

export function localSnapshotMatchesBase(
  local: readonly BotLocalSkillSnapshot[],
  base: Pick<BotSkillSyncBase, 'entries'>,
): boolean {
  const entries = normalizeBotSkillSyncBaseEntries(base.entries);
  const normalizedLocal = [...local].sort((a, b) => a.localSkillId.localeCompare(b.localSkillId));
  return normalizedLocal.length === entries.length && normalizedLocal.every((skill, index) => (
    skill.localSkillId === entries[index].localSkillId
    && skill.contentHash === entries[index].localContentHash
  ));
}

export function cloudSnapshotMatchesBase(
  cloud: readonly BotSkillReference[],
  base: Pick<BotSkillSyncBase, 'entries'>,
): boolean {
  return botSkillReferencesEqual(
    cloud,
    base.entries.map(entry => ({
      skillId: entry.cloudSkillId,
      version: entry.cloudVersion,
    })),
  );
}

export function cloudReferencesFromBase(
  base: Pick<BotSkillSyncBase, 'entries'>,
): BotSkillReference[] {
  return normalizeBotSkillReferences(base.entries.map(entry => ({
    skillId: entry.cloudSkillId,
    version: entry.cloudVersion,
  })));
}

function compareReferences(left: BotSkillReference, right: BotSkillReference): number {
  return left.skillId.localeCompare(right.skillId) || left.version.localeCompare(right.version);
}
