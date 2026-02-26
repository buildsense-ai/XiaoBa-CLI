/**
 * 统一的工具名别名映射表
 * Claude Code 工具名 → XiaoBa 内部注册名
 */
export const TOOL_NAME_ALIASES: Record<string, string> = {
  // Claude Code → XiaoBa 映射
  Bash: 'execute_bash',
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  Glob: 'glob',
  Grep: 'grep',
  TodoWrite: 'todo_write',
  Task: 'task',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',
  // 旧工具名 → 新工具名（平台通用化重命名）
  feishu_reply: 'reply',
  feishu_send_file: 'send_file',
};

export function normalizeToolName(name: string): string {
  return TOOL_NAME_ALIASES[name] ?? name;
}
