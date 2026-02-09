import * as path from 'path';

const DANGEROUS_TOOL_ALLOW_ENV = 'GAUZ_TOOL_ALLOW';
const BASH_ALLOW_DANGEROUS_ENV = 'GAUZ_BASH_ALLOW_DANGEROUS';
const FS_ALLOW_OUTSIDE_ENV = 'GAUZ_FS_ALLOW_OUTSIDE';
const FS_ALLOW_DOTENV_ENV = 'GAUZ_FS_ALLOW_DOTENV';

const DEFAULT_DANGEROUS_TOOLS = new Set([
  'execute_bash',
  'write_file',
  'edit_file',
  'create_skill',
  'self_evolution'
]);

const DANGEROUS_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-rf\s+\/(\s|$)/i, reason: '检测到可能破坏系统的 rm -rf /' },
  { pattern: /\bdel\s+\/s\s+\/q\s+[a-z]:\\/i, reason: '检测到可能清空磁盘的 del /s /q' },
  { pattern: /\bformat(\.exe)?\s+[a-z]:/i, reason: '检测到磁盘格式化命令' },
  { pattern: /\bmkfs(\.\w+)?\b/i, reason: '检测到文件系统格式化命令' },
  { pattern: /\bdiskpart\b/i, reason: '检测到磁盘分区工具' },
  { pattern: /\bshutdown\b/i, reason: '检测到关机/重启命令' },
  { pattern: /\breboot\b/i, reason: '检测到重启命令' },
  { pattern: /\bpoweroff\b/i, reason: '检测到关机命令' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\};\s*:/, reason: '检测到 Fork Bomb' }
];

function parseAllowedTools(): Set<string> {
  const raw = (process.env[DANGEROUS_TOOL_ALLOW_ENV] || '').trim();
  if (!raw) return new Set();
  const parts = raw.split(',').map(p => p.trim()).filter(Boolean);
  return new Set(parts);
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
    reason: `工具 "${toolName}" 默认被阻断。设置 ${DANGEROUS_TOOL_ALLOW_ENV} 以显式允许，例如: ${DANGEROUS_TOOL_ALLOW_ENV}=execute_bash,write_file`
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

export function isPathAllowed(targetPath: string, workingDirectory: string): { allowed: boolean; reason?: string } {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedCwd = path.resolve(workingDirectory);
  const relative = path.relative(resolvedCwd, resolvedTarget);

  const isOutside = relative.startsWith('..') || path.isAbsolute(relative);
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
