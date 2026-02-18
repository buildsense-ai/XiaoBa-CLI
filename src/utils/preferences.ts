/**
 * 用户偏好管理
 *
 * 偏好文件路径：~/.xiaoba/preferences.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── 类型定义 ─────────────────────────────────────────

export interface UserPreferences {
  /** AI 的名字，默认"小八" */
  agent_name: string;
  /** 对用户的称呼，默认"主人" */
  user_name: string;
  /** 是否已完成初始化 */
  initialized: boolean;
  /** 偏好创建时间 */
  created_at: string;
  /** 最后更新时间 */
  updated_at: string;
}

// ─── 默认值 ───────────────────────────────────────────

const DEFAULT_PREFERENCES: UserPreferences = {
  agent_name: '小八',
  user_name: '主人',
  initialized: false,
  created_at: new Date().toISOString().slice(0, 10),
  updated_at: new Date().toISOString().slice(0, 10),
};

// ─── 路径工具 ─────────────────────────────────────────

function getXiaoBaDir(): string {
  const homeDir = os.homedir();
  const xiaoBaDir = path.join(homeDir, '.xiaoba');
  return xiaoBaDir;
}

function getPreferencesPath(): string {
  return path.join(getXiaoBaDir(), 'preferences.json');
}

// ─── 公开 API ────────────────────────────────────────

/**
 * 确保偏好目录存在
 */
export function ensurePreferencesDir(): void {
  const dir = getXiaoBaDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 加载用户偏好
 * - 如果文件不存在，返回默认偏好（initialized=false）
 * - 如果文件存在但损坏，返回默认偏好并记录警告
 */
export function loadPreferences(): UserPreferences {
  const prefPath = getPreferencesPath();

  if (!fs.existsSync(prefPath)) {
    // 文件不存在，返回默认偏好（触发初始化流程）
    return { ...DEFAULT_PREFERENCES };
  }

  try {
    const content = fs.readFileSync(prefPath, 'utf-8');
    const parsed = JSON.parse(content);

    // 合并默认值（处理新增字段的情况）
    return {
      ...DEFAULT_PREFERENCES,
      ...parsed,
    };
  } catch (err) {
    // 文件损坏，返回默认偏好
    console.warn('[Preferences] 偏好文件损坏，使用默认值:', err);
    return { ...DEFAULT_PREFERENCES };
  }
}

/**
 * 保存用户偏好
 */
export function savePreferences(prefs: UserPreferences): void {
  ensurePreferencesDir();
  const prefPath = getPreferencesPath();

  const toSave: UserPreferences = {
    ...prefs,
    updated_at: new Date().toISOString().slice(0, 10),
  };

  // 如果是首次初始化，设置 created_at
  if (!prefs.created_at) {
    toSave.created_at = toSave.updated_at;
  }

  fs.writeFileSync(prefPath, JSON.stringify(toSave, null, 2), 'utf-8');
}

/**
 * 更新部分偏好
 */
export function updatePreferences(updates: Partial<UserPreferences>): UserPreferences {
  const current = loadPreferences();
  const updated = { ...current, ...updates };
  savePreferences(updated);
  return updated;
}

/**
 * 标记初始化完成
 */
export function markInitialized(agentName?: string, userName?: string): UserPreferences {
  const current = loadPreferences();
  const updated: UserPreferences = {
    ...current,
    initialized: true,
  };
  if (agentName) updated.agent_name = agentName;
  if (userName) updated.user_name = userName;
  savePreferences(updated);
  return updated;
}

/**
 * 获取偏好文件路径（供 AI 写入用）
 */
export function getPreferencesFilePath(): string {
  return getPreferencesPath();
}
