import {
  PetEvent,
  PetEventInput,
  PetEventType,
  PetLevelRule,
  PetProfile,
  PetSkillStats,
  PetState,
  PetStoreData,
} from './pet-types';

export const PET_EVENT_RETENTION_DAYS = 30;
export const PET_EVENT_MAX_ITEMS = 1000;

export const PET_LEVEL_RULES: PetLevelRule[] = [
  { level: 1, min_xp: 0, title: '新手伙伴' },
  { level: 2, min_xp: 50, title: '任务助手' },
  { level: 3, min_xp: 150, title: '熟练助手' },
  { level: 4, min_xp: 350, title: '工作搭档' },
  { level: 5, min_xp: 700, title: '专业执行者' },
];

const XP_RULES: Record<PetEventType, number> = {
  skill_started: 0,
  skill_succeeded: 3,
  skill_failed: 0,
  task_completed: 10,
  message_completed: 1,
  level_up: 0,
};

const METADATA_ALLOWLIST = new Set([
  'surface',
  'tool_call_id',
  'error_code',
  'retryable',
]);

export function createDefaultProfile(userId = 'local', agentId = 'catsco'): PetProfile {
  const now = new Date().toISOString();
  return {
    user_id: userId,
    agent_id: agentId,
    total_xp: 0,
    level: 1,
    title: '新手伙伴',
    current_state: 'idle',
    current_bubble_message: '正在等待下一项任务。',
    last_event_id: '',
    last_event_type: '',
    last_skill_name: '',
    last_active_at: now,
    updated_at: now,
  };
}

export function normalizePetEvent(input: PetEventInput, now = new Date()): PetEvent {
  const createdAt = input.created_at || now.toISOString();
  const expireAt = new Date(new Date(createdAt).getTime() + PET_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const eventType = input.event_type;
  const skillName = sanitizeText(input.skill_name || '', 80);
  return {
    id: createEventId(eventType, now),
    user_id: sanitizeText(input.user_id || 'local', 80),
    agent_id: sanitizeText(input.agent_id || 'catsco', 80),
    session_id: sanitizeText(input.session_id || '', 160),
    task_id: sanitizeText(input.task_id || '', 160),
    event_type: eventType,
    skill_name: skillName,
    status: sanitizeText(input.status || defaultStatus(eventType), 40),
    message: sanitizeText(input.message || defaultMessage(eventType, skillName), 180),
    xp_delta: XP_RULES[eventType] || 0,
    metadata: sanitizeMetadata(input.metadata || {}),
    created_at: createdAt,
    expire_at: expireAt,
  };
}

export function applyPetEvent(data: PetStoreData, event: PetEvent): PetEvent[] {
  const profile = data.profile || createDefaultProfile(event.user_id, event.agent_id);
  const previousLevel = profile.level || 1;
  const xpDelta = Math.max(0, Number(event.xp_delta || 0));

  if (xpDelta > 0) {
    profile.total_xp = Math.max(0, Number(profile.total_xp || 0)) + xpDelta;
  }

  const levelInfo = getLevelInfo(profile.total_xp);
  profile.level = levelInfo.level;
  profile.title = levelInfo.title;
  profile.current_state = stateForEvent(event.event_type);
  profile.current_bubble_message = event.message;
  profile.last_event_id = event.id;
  profile.last_event_type = event.event_type;
  profile.last_skill_name = event.skill_name || '';
  profile.last_active_at = event.created_at;
  profile.updated_at = event.created_at;
  data.profile = profile;

  updateSkillStats(data, event);

  if (profile.level > previousLevel) {
    const levelUp = normalizePetEvent({
      user_id: event.user_id,
      agent_id: event.agent_id,
      session_id: event.session_id,
      task_id: event.task_id,
      event_type: 'level_up',
      status: 'success',
      message: `升级到 LV.${profile.level}：${profile.title}`,
      metadata: { surface: event.metadata.surface },
    }, new Date(new Date(event.created_at).getTime() + 1));
    profile.current_state = 'level_up';
    profile.current_bubble_message = levelUp.message;
    profile.last_event_id = levelUp.id;
    profile.last_event_type = levelUp.event_type;
    profile.last_skill_name = '';
    profile.updated_at = levelUp.created_at;
    return [event, levelUp];
  }

  return [event];
}

export function cleanupPetEvents(events: PetEvent[], now = new Date()): PetEvent[] {
  const live = events
    .filter(event => {
      const expireTime = Date.parse(event.expire_at || '');
      return Number.isFinite(expireTime) && expireTime > now.getTime();
    })
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return live.slice(0, PET_EVENT_MAX_ITEMS);
}

export function getLevelInfo(totalXp: number): PetLevelRule {
  const xp = Math.max(0, Number(totalXp || 0));
  let current = PET_LEVEL_RULES[0];
  for (const rule of PET_LEVEL_RULES) {
    if (xp >= rule.min_xp) current = rule;
  }
  return current;
}

export function getNextLevelInfo(totalXp: number): PetLevelRule | null {
  const current = getLevelInfo(totalXp);
  return PET_LEVEL_RULES.find(rule => rule.level > current.level) || null;
}

export function currentLevelXp(totalXp: number): number {
  const current = getLevelInfo(totalXp);
  return Math.max(0, Number(totalXp || 0) - current.min_xp);
}

export function nextLevelRequiredXp(totalXp: number): number | null {
  const current = getLevelInfo(totalXp);
  const next = getNextLevelInfo(totalXp);
  return next ? next.min_xp - current.min_xp : null;
}

export function skillLevelForXp(totalXp: number): number {
  const xp = Math.max(0, Number(totalXp || 0));
  if (xp >= 120) return 5;
  if (xp >= 60) return 4;
  if (xp >= 24) return 3;
  if (xp >= 6) return 2;
  return 1;
}

function updateSkillStats(data: PetStoreData, event: PetEvent): void {
  if (!event.skill_name || !event.event_type.startsWith('skill_')) return;
  const stats = data.skill_stats || [];
  let item = stats.find(row => row.skill_name === event.skill_name && row.user_id === event.user_id && row.agent_id === event.agent_id);
  if (!item) {
    item = {
      user_id: event.user_id,
      agent_id: event.agent_id,
      skill_name: event.skill_name,
      call_count: 0,
      success_count: 0,
      fail_count: 0,
      total_xp: 0,
      skill_level: 1,
      last_used_at: event.created_at,
      updated_at: event.created_at,
    };
    stats.push(item);
  }

  if (event.event_type === 'skill_started') item.call_count += 1;
  if (event.event_type === 'skill_succeeded') item.success_count += 1;
  if (event.event_type === 'skill_failed') item.fail_count += 1;
  item.total_xp += Math.max(0, Number(event.xp_delta || 0));
  item.skill_level = skillLevelForXp(item.total_xp);
  item.last_used_at = event.created_at;
  item.updated_at = event.created_at;
  data.skill_stats = stats;
}

function stateForEvent(eventType: PetEventType): PetState {
  if (eventType === 'skill_started') return 'working';
  if (eventType === 'skill_failed') return 'error';
  if (eventType === 'level_up') return 'level_up';
  if (eventType === 'skill_succeeded' || eventType === 'task_completed' || eventType === 'message_completed') return 'success';
  return 'idle';
}

function defaultStatus(eventType: PetEventType): string {
  if (eventType === 'skill_failed') return 'failed';
  if (eventType === 'skill_started') return 'running';
  return 'success';
}

function defaultMessage(eventType: PetEventType, skillName: string): string {
  if (eventType === 'skill_started') return skillName ? `正在调用「${skillName}」skill` : '正在调用 skill';
  if (eventType === 'skill_succeeded') return skillName ? `「${skillName}」skill 已完成` : 'skill 已完成';
  if (eventType === 'skill_failed') return skillName ? `「${skillName}」skill 出错了，点我查看` : 'skill 出错了，点我查看';
  if (eventType === 'task_completed') return `任务完成，获得 ${XP_RULES.task_completed} XP`;
  if (eventType === 'message_completed') return `消息完成，获得 ${XP_RULES.message_completed} XP`;
  if (eventType === 'level_up') return '升级了';
  return '正在等待下一项任务。';
}

function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!METADATA_ALLOWLIST.has(key)) continue;
    if (typeof value === 'string') clean[key] = sanitizeText(value, 120);
    else if (typeof value === 'number' || typeof value === 'boolean') clean[key] = value;
  }
  return clean;
}

function sanitizeText(value: string, maxLength: number): string {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function createEventId(eventType: PetEventType, now: Date): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${now.getTime().toString(36)}-${eventType}-${rand}`;
}
