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
 * 加载最近 N 条摘要，拼接为字符串
 */
export function loadSessionSummary(key: string): string | null {
  try {
    const data = readFile(key);
    if (data.entries.length === 0) return null;

    const recent = data.entries.slice(-MAX_LOAD_COUNT);
    const parts = recent.map((e, i) => {
      const header = `[会话 ${i + 1}/${recent.length} - ${e.savedAt}]${e.logFile ? ` (log: ${e.logFile})` : ''}`;
      return `${header}\n${e.summary}`;
    });

    Logger.info(`已加载 ${recent.length}/${data.entries.length} 条历史摘要: ${key}`);
    return parts.join('\n\n---\n\n');
  } catch (err) {
    Logger.error(`加载本地会话摘要失败: ${err}`);
    return null;
  }
}

/**
 * 不再需要 removeSessionSummary —— 保留为空操作以兼容调用方
 */
export function removeSessionSummary(_key: string): void {
  // 追加模式下不删除，加载后保留记录
}
