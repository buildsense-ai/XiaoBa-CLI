import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';

/**
 * 本地会话摘要存储（追加式）
 *
 * 每次会话过期时将摘要追加到数组中，新会话加载最近 N 条。
 * 每条记录带日期和对应的 log 文件路径，方便回溯细节。
 */

const STORE_DIR = path.resolve(process.cwd(), 'data', 'session-summaries');
const MAX_SUMMARY_COUNT = 30;       // 最多保留条数
const MAX_SUMMARY_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天过期
const MAX_LOAD_COUNT = 5;           // 每次加载最近 N 条

interface SummaryEntry {
  summary: string;
  savedAt: string;
  logFile?: string;
}

interface SummaryFile {
  key: string;
  entries: SummaryEntry[];
  masterSummary?: string;
}

function ensureDir(): void {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
}

function keyToFilename(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
}

function readFile(key: string): SummaryFile {
  const filePath = path.join(STORE_DIR, keyToFilename(key));
  if (!fs.existsSync(filePath)) return { key, entries: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    // 兼容旧格式（单条记录）
    if (raw.summary && !raw.entries) {
      return { key, entries: [{ summary: raw.summary, savedAt: raw.savedAt }] };
    }
    return raw as SummaryFile;
  } catch {
    return { key, entries: [] };
  }
}

function writeFile(data: SummaryFile): void {
  ensureDir();
  const filePath = path.join(STORE_DIR, keyToFilename(data.key));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/** 清理过期和超量的条目 */
function pruneEntries(entries: SummaryEntry[]): SummaryEntry[] {
  const now = Date.now();
  const fresh = entries.filter(e => now - new Date(e.savedAt).getTime() < MAX_SUMMARY_AGE_MS);
  return fresh.slice(-MAX_SUMMARY_COUNT);
}

/**
 * 追加一条会话摘要
 */
export function saveSessionSummary(key: string, summary: string, logFile?: string): boolean {
  try {
    const data = readFile(key);
    data.entries.push({ summary, savedAt: new Date().toISOString(), logFile });
    data.entries = pruneEntries(data.entries);
    writeFile(data);
    Logger.info(`会话摘要已追加到本地 (共${data.entries.length}条): ${key}`);
    return true;
  } catch (err) {
    Logger.error(`保存本地会话摘要失败: ${err}`);
    return false;
  }
}

/**
 * 加载会话摘要：优先返回主摘要，无主摘要时回退到最近一条
 */
export function loadSessionSummary(key: string): string | null {
  try {
    const data = readFile(key);
    if (data.masterSummary) {
      Logger.info(`已加载主摘要: ${key}`);
      return data.masterSummary;
    }
    if (data.entries.length === 0) return null;
    const last = data.entries[data.entries.length - 1];
    Logger.info(`无主摘要，回退到最近一条: ${key}`);
    return last.summary;
  } catch (err) {
    Logger.error(`加载本地会话摘要失败: ${err}`);
    return null;
  }
}

/**
 * 获取当前主摘要
 */
export function getMasterSummary(key: string): string | null {
  try {
    const data = readFile(key);
    return data.masterSummary ?? null;
  } catch {
    return null;
  }
}

/**
 * 更新主摘要（滚动压缩后的合并摘要）
 */
export function updateMasterSummary(key: string, masterSummary: string): boolean {
  try {
    const data = readFile(key);
    data.masterSummary = masterSummary;
    writeFile(data);
    Logger.info(`主摘要已更新: ${key}`);
    return true;
  } catch (err) {
    Logger.error(`更新主摘要失败: ${err}`);
    return false;
  }
}

/**
 * 不再需要 removeSessionSummary —— 保留为空操作以兼容调用方
 */
export function removeSessionSummary(_key: string): void {
  // 追加模式下不删除，加载后保留记录
}
