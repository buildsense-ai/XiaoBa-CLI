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
  return { allowed: true };
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
  return { allowed: true };
}

export function isPathAllowed(targetPath: string, workingDirectory: string): { allowed: boolean; reason?: string } {
  return { allowed: true };
}
