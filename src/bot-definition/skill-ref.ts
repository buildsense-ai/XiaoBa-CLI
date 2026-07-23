import type { BotSkillRef } from './types';

const MAX_SKILL_ID_BYTES = 512;
const MAX_SKILL_VERSION_BYTES = 256;
const MAX_SKILL_ID_SEGMENTS = 32;

export function normalizeBotSkillRef(ref: BotSkillRef): BotSkillRef {
  const skillId = normalizeSkillId(ref?.skillId);
  const version = normalizeSkillVersion(ref?.version);
  return { skillId, version };
}

export function isValidBotSkillRef(ref: unknown): ref is BotSkillRef {
  try {
    normalizeBotSkillRef(ref as BotSkillRef);
    return true;
  } catch {
    return false;
  }
}

export function isPrivateBotSkillRef(ref: BotSkillRef): boolean {
  return normalizeBotSkillRef(ref).skillId.startsWith('private:');
}

function normalizeSkillId(value: unknown): string {
  const skillId = text(value, 'skillId', MAX_SKILL_ID_BYTES);
  const segments = skillId.split('/');
  if (
    /[\u0000-\u001f\u007f\\?#]/u.test(skillId)
    || skillId.startsWith('/')
    || skillId.endsWith('/')
    || segments.length > MAX_SKILL_ID_SEGMENTS
    || segments.some(segment => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('BotDefinition Skill skillId is not a safe portable identifier');
  }
  return skillId;
}

function normalizeSkillVersion(value: unknown): string {
  const version = text(value, 'version', MAX_SKILL_VERSION_BYTES);
  if (
    /[\u0000-\u001f\u007f/\\?#]/u.test(version)
    || version === '.'
    || version === '..'
  ) {
    throw new Error('BotDefinition Skill version is not a safe portable identifier');
  }
  return version;
}

function text(value: unknown, field: string, maxBytes: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error('BotDefinition Skill references require non-empty skillId and version');
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    throw new Error(`BotDefinition Skill ${field} is too long`);
  }
  return normalized;
}
