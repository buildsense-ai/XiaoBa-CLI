import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';

// ─── 类型定义 ───────────────────────────────────────────

/** 单次工具调用摘要 */
export interface ToolCallSummary {
    name: string;
    argsSummary: string;
    resultSummary: string;
}

/** 单轮对话的日志记录 */
export interface TurnLogEntry {
    /** 第几轮对话（从 1 开始） */
    turnIndex: number;
    /** ISO 时间戳 */
    timestamp: string;
    /** 用户输入摘要 */
    userMessage: string;
    /** 最终 assistant 回复摘要 */
    assistantReply: string;
    /** 本轮工具调用列表 */
    toolCalls: ToolCallSummary[];
    /** 本轮产出文件路径 */
    outputFiles: string[];
}

// ─── 常量 ───────────────────────────────────────────────

const TURN_LOGS_DIR = path.resolve(process.cwd(), 'data', 'turn-logs');
const MAX_TURNS_KEPT = 50;

// ─── 工具函数 ───────────────────────────────────────────

function ensureDir(): void {
    if (!fs.existsSync(TURN_LOGS_DIR)) {
        fs.mkdirSync(TURN_LOGS_DIR, { recursive: true });
    }
}

function keyToFilename(sessionKey: string): string {
    return sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_') + '.turn-log.jsonl';
}

function filePath(sessionKey: string): string {
    return path.join(TURN_LOGS_DIR, keyToFilename(sessionKey));
}

// ─── 公开 API ───────────────────────────────────────────

/**
 * 保存一轮对话的工具过程日志。
 * 追加到 JSONL 文件末尾，超过 MAX_TURNS_KEPT 时自动截断旧记录。
 */
export function saveTurnLog(sessionKey: string, entry: TurnLogEntry): void {
    try {
        ensureDir();
        const fp = filePath(sessionKey);
        fs.appendFileSync(fp, JSON.stringify(entry) + '\n', 'utf-8');

        // 惰性清理：每 10 轮检查一次是否超量
        if (entry.turnIndex % 10 === 0) {
            pruneLogFile(fp);
        }
    } catch (err: any) {
        Logger.warning(`[TurnLogStore] 保存失败 [${sessionKey}]: ${err.message}`);
    }
}

/**
 * 查询历史操作日志。
 *
 * @param sessionKey 会话标识
 * @param turnsBack  回溯几轮（默认 5）
 * @param query      可选关键词过滤（匹配 userMessage / 工具名 / 文件路径）
 * @returns 匹配的日志条目（按时间正序）
 */
export function queryTurnLogs(
    sessionKey: string,
    turnsBack: number = 5,
    query?: string,
): TurnLogEntry[] {
    try {
        const fp = filePath(sessionKey);
        if (!fs.existsSync(fp)) return [];

        const content = fs.readFileSync(fp, 'utf-8').trim();
        if (!content) return [];

        const lines = content.split('\n');
        // 取最近 turnsBack 条
        const recentLines = lines.slice(-turnsBack);

        const entries: TurnLogEntry[] = [];
        for (const line of recentLines) {
            try {
                const entry = JSON.parse(line) as TurnLogEntry;
                if (query) {
                    const q = query.toLowerCase();
                    const matchesUser = entry.userMessage.toLowerCase().includes(q);
                    const matchesTool = entry.toolCalls.some(
                        tc => tc.name.toLowerCase().includes(q) || tc.argsSummary.toLowerCase().includes(q),
                    );
                    const matchesFile = entry.outputFiles.some(f => f.toLowerCase().includes(q));
                    const matchesReply = entry.assistantReply.toLowerCase().includes(q);
                    if (!matchesUser && !matchesTool && !matchesFile && !matchesReply) {
                        continue;
                    }
                }
                entries.push(entry);
            } catch {
                // 跳过损坏的行
            }
        }

        return entries;
    } catch (err: any) {
        Logger.warning(`[TurnLogStore] 查询失败 [${sessionKey}]: ${err.message}`);
        return [];
    }
}

/**
 * 获取当前日志中最后一轮的 turnIndex（用于递增计数）
 */
export function getLastTurnIndex(sessionKey: string): number {
    try {
        const fp = filePath(sessionKey);
        if (!fs.existsSync(fp)) return 0;

        const content = fs.readFileSync(fp, 'utf-8').trim();
        if (!content) return 0;

        const lines = content.split('\n');
        const lastLine = lines[lines.length - 1];
        const entry = JSON.parse(lastLine) as TurnLogEntry;
        return entry.turnIndex;
    } catch {
        return 0;
    }
}

// ─── 私有函数 ───────────────────────────────────────────

/** 截断日志文件，只保留最近 MAX_TURNS_KEPT 条 */
function pruneLogFile(fp: string): void {
    try {
        const content = fs.readFileSync(fp, 'utf-8').trim();
        if (!content) return;

        const lines = content.split('\n');
        if (lines.length <= MAX_TURNS_KEPT) return;

        const kept = lines.slice(-MAX_TURNS_KEPT);
        fs.writeFileSync(fp, kept.join('\n') + '\n', 'utf-8');
        Logger.info(`[TurnLogStore] 已清理旧日志，保留最近 ${MAX_TURNS_KEPT} 轮`);
    } catch (err: any) {
        Logger.warning(`[TurnLogStore] 清理失败: ${err.message}`);
    }
}
