import * as path from 'path';

const DANGEROUS_TOOL_ALLOW_ENV = 'GAUZ_TOOL_ALLOW';
const BASH_ALLOW_DANGEROUS_ENV = 'GAUZ_BASH_ALLOW_DANGEROUS';
const FS_ALLOW_OUTSIDE_ENV = 'GAUZ_FS_ALLOW_OUTSIDE';
const FS_ALLOW_OUTSIDE_READ_ENV = 'GAUZ_FS_ALLOW_OUTSIDE_READ';
const FS_ALLOW_DOTENV_ENV = 'GAUZ_FS_ALLOW_DOTENV';

const DEFAULT_DANGEROUS_TOOLS = new Set([
  'execute_shell',
  'execute_bash',
  'write_file',
  'edit_file',

  'self_evolution'
]);

// 尽力而为的危险命令检测，非沙箱替代方案。仅作为最后一道防线拦截明显危险操作。
const DANGEROUS_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-rf\s+\/(\s|$)/i, reason: '检测到可能破坏系统的 rm -rf /' },
  { pattern: /\bdel\s+\/s\s+\/q\s+[a-z]:\\/i, reason: '检测到可能清空磁盘的 del /s /q' },
  { pattern: /\bformat(\.exe)?\s+[a-z]:/i, reason: '检测到磁盘格式化命令' },
  { pattern: /\bmkfs(\.\w+)?\b/i, reason: '检测到文件系统格式化命令' },
  { pattern: /\bdiskpart\b/i, reason: '检测到磁盘分区工具' },
  { pattern: /\bshutdown\b/i, reason: '检测到关机/重启命令' },
  { pattern: /\breboot\b/i, reason: '检测到重启命令' },
  { pattern: /\bpoweroff\b/i, reason: '检测到关机命令' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\};\s*:/, reason: '检测到 Fork Bomb' },
  { pattern: /\brm\s+-rf\s+\/\*/i, reason: '检测到 rm -rf /* 危险命令' },
  { pattern: /\bcurl\b.*\|\s*\bbash\b/i, reason: '检测到 curl|bash 远程代码执行' },
  { pattern: /\bwget\b.*\|\s*\bsh\b/i, reason: '检测到 wget|sh 远程代码执行' },
  { pattern: /\bchmod\s+777\b/i, reason: '检测到 chmod 777 不安全权限设置' },
  { pattern: /\bdd\b.*\bof\s*=\s*\/dev\//i, reason: '检测到 dd of=/dev/ 危险写入' },
  { pattern: /\beval\s+/i, reason: '检测到 eval 命令' },
  { pattern: /`[^`]+`/, reason: '检测到反引号命令替换' },
  { pattern: /\bsource\s+/i, reason: '检测到 source 命令' },
  { pattern: /--no-preserve-root/i, reason: '检测到 --no-preserve-root 危险标志' },
];

function parseAllowedTools(): Set<string> {
  const raw = (process.env[DANGEROUS_TOOL_ALLOW_ENV] || '').trim();
  if (!raw) return new Set();
  const parts = raw.split(',').map(p => p.trim()).filter(Boolean);
  const allowed = new Set(parts);

  // execute_shell 和 execute_bash 视为等价，避免迁移期配置失效
  if (allowed.has('execute_bash')) {
    allowed.add('execute_shell');
  }
  if (allowed.has('execute_shell')) {
    allowed.add('execute_bash');
  }
  return allowed;
}

export function isToolAllowed(toolName: string): { allowed: boolean; reason?: string } {
  if (!DEFAULT_DANGEROUS_TOOLS.has(toolName)) {
    return { allowed: true };
  }

  const allowed = parseAllowedTools();
  if (allowed.has('*') || allowed.has('all') || allowed.has(toolName)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `工具 "${toolName}" 默认被阻断。设置 ${DANGEROUS_TOOL_ALLOW_ENV} 以显式允许，例如: ${DANGEROUS_TOOL_ALLOW_ENV}=execute_shell,write_file`
  };
}

export function isBashCommandAllowed(command: string): { allowed: boolean; reason?: string } {
  if (process.env[BASH_ALLOW_DANGEROUS_ENV] === 'true') {
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

  return { allowed: true };
}

function isOutsideWorkingDirectory(targetPath: string, workingDirectory: string): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedCwd = path.resolve(workingDirectory);

  if (resolvedTarget === resolvedCwd) {
    return false;
  }

  const normalizedTarget = resolvedTarget.toLowerCase();
  const normalizedCwd = resolvedCwd.toLowerCase();
  const cwdWithSep = normalizedCwd.endsWith(path.sep) ? normalizedCwd : normalizedCwd + path.sep;
  return !normalizedTarget.startsWith(cwdWithSep);
}

export function isReadPathAllowed(targetPath: string, workingDirectory: string): { allowed: boolean; reason?: string } {
  const isOutside = isOutsideWorkingDirectory(targetPath, workingDirectory);
  if (isOutside && process.env[FS_ALLOW_OUTSIDE_READ_ENV] !== 'true') {
    return {
      allowed: false,
      reason: `读取路径超出工作目录。设置 ${FS_ALLOW_OUTSIDE_READ_ENV}=true 可解除限制`
    };
  }
  return { allowed: true };
}

export function isPathAllowed(targetPath: string, workingDirectory: string): { allowed: boolean; reason?: string } {
  const resolvedTarget = path.resolve(targetPath);
  const isOutside = isOutsideWorkingDirectory(targetPath, workingDirectory);
  if (isOutside && process.env[FS_ALLOW_OUTSIDE_ENV] !== 'true') {
    return {
      allowed: false,
      reason: `写入路径超出工作目录。设置 ${FS_ALLOW_OUTSIDE_ENV}=true 可解除限制`
    };
  }

  if (path.basename(resolvedTarget).toLowerCase() === '.env' && process.env[FS_ALLOW_DOTENV_ENV] !== 'true') {
    return {
      allowed: false,
      reason: `禁止直接修改 .env。设置 ${FS_ALLOW_DOTENV_ENV}=true 可解除限制`
    };
  }

  return { allowed: true };
}
