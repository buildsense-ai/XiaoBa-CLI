import { Message } from '../types';
import {
  Skill,
  SkillActivationSignal,
  SkillInvocationContext,
  SkillToolPolicy,
} from '../types/skill';
import { SkillExecutor } from './skill-executor';

/**
 * 基于 skill 定义与调用上下文生成统一激活信号
 */
export function buildSkillActivationSignal(
  skill: Skill,
  context: SkillInvocationContext,
): SkillActivationSignal {
  const signal: SkillActivationSignal = {
    __type__: 'skill_activation',
    skillName: skill.metadata.name,
    prompt: SkillExecutor.execute(skill, context),
  };

  if (typeof skill.metadata.maxTurns === 'number' && Number.isFinite(skill.metadata.maxTurns)) {
    signal.maxTurns = skill.metadata.maxTurns;
  }

  const normalizedPolicy = normalizeSkillToolPolicy(skill.metadata.toolPolicy);
  if (normalizedPolicy) {
    signal.toolPolicy = normalizedPolicy;
  }

  return signal;
}

/**
 * 解析并校验 skill 激活信号
 */
export function parseSkillActivationSignal(content: string): SkillActivationSignal | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed?.__type__ !== 'skill_activation') {
      return null;
    }
    if (typeof parsed.skillName !== 'string' || !parsed.skillName.trim()) {
      return null;
    }
    if (typeof parsed.prompt !== 'string') {
      return null;
    }

    const signal: SkillActivationSignal = {
      __type__: 'skill_activation',
      skillName: parsed.skillName.trim(),
      prompt: parsed.prompt,
    };

    if (typeof parsed.maxTurns === 'number' && Number.isFinite(parsed.maxTurns)) {
      signal.maxTurns = parsed.maxTurns;
    }

    const normalizedPolicy = normalizeSkillToolPolicy(parsed.toolPolicy);
    if (normalizedPolicy) {
      signal.toolPolicy = normalizedPolicy;
    }

    return signal;
  } catch {
    return null;
  }
}

/**
 * 生成统一的 system prompt 载荷
 */
export function buildSkillSystemPrompt(activation: SkillActivationSignal): string {
  return `[skill:${activation.skillName}]\n${activation.prompt}`;
}

/**
 * 在消息中 upsert skill system prompt（同名 skill 保留最新注入）
 */
export function upsertSkillSystemMessage(
  messages: Message[],
  activation: SkillActivationSignal,
): Message {
  const marker = `[skill:${activation.skillName}]`;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'system' && msg.content?.startsWith(marker)) {
      messages.splice(i, 1);
    }
  }

  const systemMsg: Message = {
    role: 'system',
    content: buildSkillSystemPrompt(activation),
  };
  messages.push(systemMsg);
  return systemMsg;
}

function normalizeSkillToolPolicy(policy: unknown): SkillToolPolicy | undefined {
  if (!policy || typeof policy !== 'object') {
    return undefined;
  }

  const allowedRaw = (policy as SkillToolPolicy).allowedTools;
  const disallowedRaw = (policy as SkillToolPolicy).disallowedTools;

  const allowedTools = Array.isArray(allowedRaw)
    ? Array.from(new Set(allowedRaw.map(name => String(name).trim()).filter(Boolean)))
    : [];
  const disallowedTools = Array.isArray(disallowedRaw)
    ? Array.from(new Set(disallowedRaw.map(name => String(name).trim()).filter(Boolean)))
    : [];

  if (allowedTools.length === 0 && disallowedTools.length === 0) {
    return undefined;
  }

  const normalized: SkillToolPolicy = {};
  if (allowedTools.length > 0) {
    normalized.allowedTools = allowedTools;
  }
  if (disallowedTools.length > 0) {
    normalized.disallowedTools = disallowedTools;
  }
  return normalized;
}
