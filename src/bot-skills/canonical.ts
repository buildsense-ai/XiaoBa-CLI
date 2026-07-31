import type { BotSkillRef } from '../bot-definition/types';

export const MAX_BOT_SKILL_REFS = 256;
export const MAX_BOT_SKILL_ID_BYTES = 240;
export const MAX_BOT_SKILL_VERSION_BYTES = 120;

export function canonicalizeBotSkillRefs(input: readonly BotSkillRef[]): BotSkillRef[] {
  if (!Array.isArray(input)) throw new Error('BotDefinition.skills must be an array');
  if (input.length > MAX_BOT_SKILL_REFS) throw new Error('BotDefinition has too many skills');
  const seen = new Set<string>();
  const skills = input.map(item => {
    const source = String(item?.source || '').trim().toLowerCase();
    const skillId = String(item?.skillId || '').trim();
    const version = String(item?.version || '').trim();
    const contentHash = String(item?.contentHash || '').trim();
    if (source !== 'skillhub') {
      throw new Error('BotDefinition contains an invalid skill source');
    }
    if (!isValidReferencePart(skillId, MAX_BOT_SKILL_ID_BYTES)) {
      throw new Error('BotDefinition contains an invalid skillId');
    }
    if (!isValidReferencePart(version, MAX_BOT_SKILL_VERSION_BYTES)) {
      throw new Error('BotDefinition contains an invalid skill version');
    }
    if (!hasSafeReferenceSegments(skillId) || version === '.' || version === '..') {
      throw new Error('BotDefinition contains an unsafe Skill reference');
    }
    if (!/^[a-f0-9]{64}$/.test(contentHash)) {
      throw new Error('BotDefinition contains an invalid Skill contentHash');
    }
    if (seen.has(skillId)) throw new Error(`BotDefinition contains duplicate skillId: ${skillId}`);
    seen.add(skillId);
    return { source: 'skillhub' as const, skillId, version, contentHash };
  });
  return skills.sort((left, right) => Buffer.compare(
    Buffer.from(left.skillId, 'utf8'),
    Buffer.from(right.skillId, 'utf8'),
  ));
}

export function isValidBotSkillRefs(input: unknown): input is BotSkillRef[] {
  try {
    canonicalizeBotSkillRefs(input as BotSkillRef[]);
    return true;
  } catch {
    return false;
  }
}

export function botSkillRefsEqual(
  left: readonly BotSkillRef[] | undefined,
  right: readonly BotSkillRef[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  const canonicalLeft = canonicalizeBotSkillRefs(left);
  const canonicalRight = canonicalizeBotSkillRefs(right);
  return JSON.stringify(canonicalLeft) === JSON.stringify(canonicalRight);
}

function isValidReferencePart(value: string, maxBytes: number): boolean {
  if (!value || Buffer.byteLength(value, 'utf-8') > maxBytes) return false;
  return !Array.from(value).some(char => {
    const code = char.codePointAt(0) ?? 0;
    return (
      code <= 0x1f
      || (code >= 0x7f && code <= 0x9f)
      || (char.length === 1 && code >= 0xd800 && code <= 0xdfff)
    );
  });
}

function hasSafeReferenceSegments(value: string): boolean {
  return !value.split('/').some(part => !part || part === '.' || part === '..');
}
