import * as path from 'path';

const DANGEROUS_TOOL_ALLOW_ENV = 'GAUZ_TOOL_ALLOW';
const BASH_ALLOW_DANGEROUS_ENV = 'GAUZ_BASH_ALLOW_DANGEROUS';
const FS_ALLOW_OUTSIDE_ENV = 'GAUZ_FS_ALLOW_OUTSIDE';
const FS_ALLOW_OUTSIDE_READ_ENV = 'GAUZ_FS_ALLOW_OUTSIDE_READ';
const FS_ALLOW_DOTENV_ENV = 'GAUZ_FS_ALLOW_DOTENV';

/**
 * Dangerous tools that require explicit allowlist configuration to run.
 * By default, these tools are BLOCKED unless explicitly allowed via environment variable.
 */
const DANGEROUS_TOOLS = new Set([
  'execute_shell',
  'execute_bash',
  'write_file',
  'edit_file',
  'self_evolution'
]);

/**
 * Safe tools that don't require special configuration.
 * These tools are always allowed.
 */
const SAFE_TOOLS = new Set([
  'read_file',
  'glob',
  'grep',
  'ask_parent',
  'send_text',
  'send_file',
  'update_plan',
  'wait_subagents',
  'stop_subagent',
  'spawn_subagent',
  'record_decision',
  'resolve_common_directory',
  'share_skillhub_skill',
  'get_available_skills',
  'use_skill',
  'check_subagent',
  'resume_subagent',
  'device_rpc'
]);

const DANGEROUS_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-rf\s+\/(\s|$)/i, reason: '检测到可能破坏系统的 rm -rf /' },
  { pattern: /\bdel\s+\/s\s+\/q\s+[a-z]:\\/i, reason: '检测到可能清空磁盘的 del /s /q' },
  { pattern: /\bformat(\.exe)?\s+[a-z]:/i, reason: '检测到磁盘格式化命令' },
  { pattern: /\bmkfs(\.\w+)?\b/i, reason: '检测到文件系统格式化命令' },
  { pattern: /\bdiskpart\b/i, reason: '检测到磁盘分区工具' },
  { pattern: /\bdd\s+.+\bof=\/dev\//i, reason: '检测到可能直接写入块设备的 dd 命令' },
  { pattern: /\bshutdown\b/i, reason: '检测到关机/重启命令' },
  { pattern: /\breboot\b/i, reason: '检测到重启命令' },
  { pattern: /\bpoweroff\b/i, reason: '检测到关机命令' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\};\s*:/, reason: '检测到 Fork Bomb' }
];

const CONFIRMABLE_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-(?:[^\s-]*r[^\s-]*f|[^\s-]*f[^\s-]*r)\s+(?!\/(?:\s|$))/i, reason: '检测到递归强制删除命令' },
  { pattern: /\bRemove-Item\b(?=[\s\S]*-(?:Recurse|r)\b)(?=[\s\S]*-(?:Force|f)\b)/i, reason: '检测到 PowerShell 递归强制删除命令' },
  { pattern: /\brmdir\s+\/s\s+\/q\b/i, reason: '检测到 Windows 递归删除目录命令' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: '检测到会丢弃工作区改动的 git reset --hard' },
  { pattern: /\bgit\s+clean\s+-(?:[a-z]*f[a-z]*d|[a-z]*d[a-z]*f)/i, reason: '检测到会删除未跟踪文件的 git clean' },
  { pattern: /\bgit\s+(?:checkout|switch)\s+-(?:[a-z]*f|force)\b/i, reason: '检测到强制切换分支/工作区命令' },
  { pattern: /\bgit\s+push\b[\s\S]*--force(?:-with-lease)?\b/i, reason: '检测到强制推送命令' },
  { pattern: /\bgit\s+branch\s+-D\b/i, reason: '检测到强制删除分支命令' },
  { pattern: /\bnpm\s+publish\b/i, reason: '检测到发布 npm 包命令' },
  { pattern: /\bpip\s+install\b[\s\S]*(?:--force-reinstall|--upgrade)\b/i, reason: '检测到会改动 Python 环境的 pip 安装命令' },
];

export interface SafetyCheckOptions {
  confirmed?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Parse the GAUZ_TOOL_ALLOW environment variable to get the set of allowed dangerous tools.
 */
function parseAllowedTools(): Set<string> {
  const raw = (process.env[DANGEROUS_TOOL_ALLOW_ENV] || '').trim();
  if (!raw) return new Set();
  const parts = raw.split(',').map(p => p.trim()).filter(Boolean);
  const allowed = new Set(parts);

  // execute_shell and execute_bash are equivalent, avoid migration config failure
  if (allowed.has('execute_bash')) {
    allowed.add('execute_shell');
  }
  if (allowed.has('execute_shell')) {
    allowed.add('execute_bash');
  }
  return allowed;
}

/**
 * Check if a tool is allowed to execute.
 * 
 * Safe tools are always allowed.
 * Dangerous tools are blocked by default unless explicitly allowed via GAUZ_TOOL_ALLOW environment variable.
 * 
 * @param toolName - The name of the tool to check
 * @returns Object with allowed boolean and optional reason string
 */
export function isToolAllowed(toolName: string): { allowed: boolean; reason?: string } {
  const normalizedToolName = toolName.toLowerCase().trim();
  
  // Safe tools are always allowed
  if (SAFE_TOOLS.has(normalizedToolName)) {
    return { allowed: true };
  }
  
  // Check if it's a dangerous tool
  if (DANGEROUS_TOOLS.has(normalizedToolName)) {
    const allowedTools = parseAllowedTools();
    if (!allowedTools.has(normalizedToolName)) {
      return {
        allowed: false,
        reason: `工具 "${toolName}" 被分类为危险工具，需要通过设置 ${DANGEROUS_TOOL_ALLOW_ENV}=${toolName} 来显式允许执行`
      };
    }
    return { allowed: true };
  }
  
  // Unknown tools: allow by default but log warning (backward compatibility)
  // This prevents breaking existing functionality while we identify additional dangerous tools
  return { allowed: true };
}

export function isBashCommandAllowed(
  command: string,
  options: SafetyCheckOptions = {},
): { allowed: boolean; reason?: string } {
  const env = options.env ?? process.env;
  if (env[BASH_ALLOW_DANGEROUS_ENV] === 'true') {
    return { allowed: true };
  }

  for (const rule of DANGEROUS_BASH_PATTERNS) {
    if (rule.pattern.test(command)) {
      return {
        allowed: false,
        reason: `${rule.reason}。如需强制执行，请设置 ${BASH_ALLOW_DANGEROUS_ENV}=true`
      };
    }
  }

  for (const rule of CONFIRMABLE_BASH_PATTERNS) {
    if (rule.pattern.test(command) && !options.confirmed) {
      return {
        allowed: false,
        reason: `${rule.reason}。请先确认用户明确要求该危险操作，再用 confirm_dangerous=true 重试；如需强制绕过全部 shell 安全检查，请设置 ${BASH_ALLOW_DANGEROUS_ENV}=true`
      };
    }
  }

  return { allowed: true };
}

/**
 * Check if a path is outside the working directory (path traversal check).
 * This handles symbolic links and normalizes paths properly.
 */
function isOutsideWorkingDirectory(targetPath: string, workingDirectory: string): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedCwd = path.resolve(workingDirectory);

  // Same directory is always allowed
  if (resolvedTarget === resolvedCwd) {
    return false;
  }

  const normalizedTarget = resolvedTarget.toLowerCase();
  const normalizedCwd = resolvedCwd.toLowerCase();
  const cwdWithSep = normalizedCwd.endsWith(path.sep) ? normalizedCwd : normalizedCwd + path.sep;
  return !normalizedTarget.startsWith(cwdWithSep);
}

/**
 * Check if a path is allowed for READ operations.
 * 
 * By default, read operations are restricted to the working directory.
 * Set GAUZ_FS_ALLOW_OUTSIDE_READ=true to allow reading from anywhere.
 * 
 * @param targetPath - The path to check
 * @param workingDirectory - The allowed working directory
 * @returns Object with allowed boolean and optional reason string
 */
export function isReadPathAllowed(targetPath: string, workingDirectory: string): { allowed: boolean; reason?: string } {
  // Check if outside read is allowed via environment variable
  if (process.env[FS_ALLOW_OUTSIDE_READ_ENV] === 'true') {
    return { allowed: true };
  }
  
  if (isOutsideWorkingDirectory(targetPath, workingDirectory)) {
    return {
      allowed: false,
      reason: `路径 "${targetPath}" 超出工作目录 "${workingDirectory}" 范围。读取外部路径需要设置 ${FS_ALLOW_OUTSIDE_READ_ENV}=true`
    };
  }
  
  return { allowed: true };
}

/**
 * Check if a path is allowed for WRITE operations.
 * 
 * By default, write operations are restricted to the working directory.
 * Set GAUZ_FS_ALLOW_OUTSIDE=true to allow writing to anywhere.
 * 
 * Additionally, .env files are protected and require FS_ALLOW_DOTENV=true to modify.
 * 
 * @param targetPath - The path to check
 * @param workingDirectory - The allowed working directory
 * @returns Object with allowed boolean and optional reason string
 */
export function isPathAllowed(targetPath: string, workingDirectory: string): { allowed: boolean; reason?: string } {
  // First check for dotenv protection (this is independent of outside working directory check)
  if (process.env[FS_ALLOW_DOTENV_ENV] !== 'true' && isDotEnvPath(targetPath)) {
    return {
      allowed: false,
      reason: `检测到写入敏感环境文件 ${path.basename(targetPath)}。如确需修改，请设置 ${FS_ALLOW_DOTENV_ENV}=true`
    };
  }
  
  // Then check if outside working directory is allowed
  if (process.env[FS_ALLOW_OUTSIDE_ENV] !== 'true' && isOutsideWorkingDirectory(targetPath, workingDirectory)) {
    return {
      allowed: false,
      reason: `路径 "${targetPath}" 超出工作目录 "${workingDirectory}" 范围。写入外部路径需要设置 ${FS_ALLOW_OUTSIDE_ENV}=true`
    };
  }
  
  return { allowed: true };
}

/**
 * Check if a path is a .env file or related configuration.
 */
function isDotEnvPath(targetPath: string): boolean {
  return /^\.env(?:\.|$)/i.test(path.basename(targetPath));
}
