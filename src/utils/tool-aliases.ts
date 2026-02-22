/**
 * 统一的工具名别名映射表
 * Claude Code 工具名 → XiaoBa 内部注册名
 */
export const TOOL_NAME_ALIASES: Record<string, string> = {
  // Shell 相关别名
  Bash: 'execute_shell',
  bash: 'execute_shell',
  Shell: 'execute_shell',
  shell: 'execute_shell',
  execute_bash: 'execute_shell',
  // Claude Code → XiaoBa 映射
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  Glob: 'glob',
  Grep: 'grep',
  TodoWrite: 'todo_write',
  Task: 'task',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',
};

export function normalizeToolName(name: string): string {
  return TOOL_NAME_ALIASES[name] ?? name;
}
