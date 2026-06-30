import type { DeviceGrantOperation } from '../types/session-identity';
import type { ToolExecutionContext, ToolExecutionResult, ToolRiskLevel } from '../types/tool';
import { isCatsCoAgentLocalBodyContext, isCatsCoLocalOwnerSelfContext, resolveToolGatewayAccess } from './tool-gateway';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface LocalToolRiskDecision {
  requiresConfirmation: boolean;
  risk: ToolRiskLevel;
  reason: string;
}

const LOW_RISK_TOOLS = new Set([
  'resolve_common_directory',
  'common_directory',
  'update_plan',
  'record_decision',
  'check_subagent',
  'stop_subagent',
  'resume_subagent',
  'ask_parent',
  'send_text',
  'skill',
  'memory_search',
  'memory_read_turn',
  'memory_neighbors',
  'finish_memory_search',
  'finish_prompt_mode_routing',
]);

const CONFIRM_TOOLS = new Set([
  'write_file',
  'edit_file',
  'execute_shell',
  'send_file',
  'spawn_subagent',
  'share_skillhub_skill',
]);

const REMOTE_DEVICE_FILE_TOOL_OPERATIONS: Record<string, DeviceGrantOperation> = {
  read_file: 'read_file',
  glob: 'glob',
  grep: 'grep',
  write_file: 'write_file',
  edit_file: 'edit_file',
};

export async function confirmLocalToolExecution(
  toolName: string,
  args: unknown,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult | undefined> {
  const decision = classifyLocalToolRisk(toolName, args, context);
  if (!decision.requiresConfirmation) return undefined;

  const confirm = context.confirmToolExecution;
  if (!confirm && context.permissionProfile !== 'strict') {
    return undefined;
  }
  if (!confirm) {
    return {
      ok: false,
      errorCode: 'NEEDS_CONFIRMATION',
      retryable: true,
      message: [
        `工具 ${toolName} 需要用户确认后才能继续。`,
        `风险等级: ${decision.risk}`,
        decision.reason,
      ].filter(Boolean).join('\n'),
    };
  }

  const result = await confirm({
    toolName,
    args,
    risk: decision.risk,
    reason: decision.reason,
    surface: context.surface,
    workingDirectory: context.workingDirectory,
  });
  const approved = typeof result === 'boolean' ? result : result?.approved === true;
  if (approved) return undefined;

  const reason = typeof result === 'object' ? result.reason : '';
  return {
    ok: false,
    errorCode: 'PERMISSION_DENIED',
    retryable: false,
    message: reason || `用户未确认 ${toolName}，工具调用已取消。`,
  };
}

export function classifyLocalToolRisk(
  toolName: string,
  args: unknown,
  context: ToolExecutionContext,
): LocalToolRiskDecision {
  if (context.surface === 'catscompany') {
    return { requiresConfirmation: false, risk: 'low', reason: 'CatsCo lightweight execution routes do not require local confirmation.' };
  }

  if (LOW_RISK_TOOLS.has(toolName)) {
    return { requiresConfirmation: false, risk: 'low', reason: '只读或状态类工具。' };
  }

  if (isCatsCoLocalOwnerSelfContext(context) || isCatsCoAgentLocalBodyContext(context)) {
    return { requiresConfirmation: false, risk: 'low', reason: 'CatsCo 虚拟员工本机运行体允许直接执行本机工具。' };
  }

  const remoteFileOperation = REMOTE_DEVICE_FILE_TOOL_OPERATIONS[toolName];
  if (remoteFileOperation && isServerAuthorizedRemoteDeviceOperation(toolName, remoteFileOperation, context)) {
    return {
      requiresConfirmation: false,
      risk: 'low',
      reason: '服务端已选定远程设备并下发短期 device grant，普通文件工具不需要本机二次确认。',
    };
  }

  if (toolName === 'read_file' || toolName === 'glob' || toolName === 'grep') {
    const pathRisk = classifyReadTargetsRisk(readonlyToolTargets(toolName, args), context);
    if (pathRisk === 'low') {
      return { requiresConfirmation: false, risk: 'low', reason: '读取当前工作区内的普通路径。' };
    }
    if (pathRisk === 'high') {
      return { requiresConfirmation: true, risk: 'high', reason: '目标看起来是敏感文件、系统目录或密钥路径，需要用户确认。' };
    }
    return { requiresConfirmation: true, risk: 'medium', reason: '工具会读取或搜索当前工作区外的本机路径，需要用户确认。' };
  }

  if (toolName === 'execute_shell') {
    const command = stringField(args, 'command') || stringField(args, 'cmd') || stringField(args, 'script');
    if (isServerAuthorizedRemoteDeviceOperation(toolName, 'execute_shell', context)) {
      return {
        requiresConfirmation: false,
        risk: 'high',
        reason: '服务端已选定远程设备并下发 execute_shell device grant，命令由 Device RPC 直接转发。',
      };
    }
    if (looksDangerousShell(command)) {
      return { requiresConfirmation: true, risk: 'high', reason: '命令可能删除、覆盖、关闭系统或下载并执行脚本。' };
    }
    return { requiresConfirmation: true, risk: 'medium', reason: '命令会在本机执行，需要用户确认。' };
  }

  if (toolName === 'write_file' || toolName === 'edit_file') {
    const target = stringField(args, 'file_path') || stringField(args, 'path') || stringField(args, 'target');
    const pathRisk = classifyWritePathRisk(toolName, target, context);
    if (pathRisk === 'low') {
      return { requiresConfirmation: false, risk: 'low', reason: '在当前工作区内新建普通文件。' };
    }
    if (pathRisk === 'high') {
      return { requiresConfirmation: true, risk: 'high', reason: '目标看起来是环境变量、密钥、系统配置或工作区外路径。' };
    }
    return { requiresConfirmation: true, risk: 'medium', reason: '工具会修改本机文件，需要用户确认。' };
  }

  if (toolName === 'send_file') {
    return { requiresConfirmation: true, risk: 'medium', reason: '工具会把本地文件发送到当前会话，需要用户确认。' };
  }

  if (CONFIRM_TOOLS.has(toolName)) {
    return { requiresConfirmation: true, risk: 'medium', reason: '工具会启动额外执行流程或产生外部影响，需要用户确认。' };
  }

  return { requiresConfirmation: true, risk: 'medium', reason: '未知工具未声明风险等级，需要用户确认。' };
}

function isServerAuthorizedRemoteDeviceOperation(
  toolName: string,
  operation: DeviceGrantOperation,
  context: ToolExecutionContext,
): boolean {
  if (!context.deviceRpc) return false;
  const decision = resolveToolGatewayAccess(context, {
    toolName,
    operation,
  });
  return decision.ok && decision.mode === 'remote';
}

function stringField(value: unknown, key: string): string {
  if (!value || typeof value !== 'object') return '';
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'string' ? raw.trim() : '';
}

function looksSensitivePath(value: string): boolean {
  const text = value.replace(/\\/g, '/').toLowerCase();
  if (!text) return false;
  if (text.includes('/../') || text.startsWith('../') || text === '..') return true;
  return /(^|\/)(\.env|\.npmrc|\.pypirc|id_rsa|id_ed25519|known_hosts|authorized_keys)(\.|$|\/)/.test(text)
    || text.includes('/.ssh/')
    || text.includes('/windows/system32/')
    || text.includes('/etc/');
}

function readonlyToolTargets(toolName: string, args: unknown): string[] {
  if (toolName === 'read_file') {
    return [stringField(args, 'file_path') || stringField(args, 'path')].filter(Boolean);
  }
  if (toolName === 'glob') {
    return [
      stringField(args, 'path') || '.',
      stringField(args, 'pattern'),
    ].filter(Boolean);
  }
  if (toolName === 'grep') {
    return [
      stringField(args, 'path') || '.',
      stringField(args, 'glob'),
    ].filter(Boolean);
  }
  return [];
}

function classifyReadTargetsRisk(values: string[], context: ToolExecutionContext): ToolRiskLevel {
  const risks = (values.length > 0 ? values : ['.']).map(value => classifyReadPathRisk(value, context));
  if (risks.includes('high')) return 'high';
  if (risks.includes('medium')) return 'medium';
  return 'low';
}

function classifyReadPathRisk(value: string, context: ToolExecutionContext): ToolRiskLevel {
  const target = value.trim();
  if (/^catsco_attachment:[A-Za-z0-9._:-]+$/.test(target)) return 'low';
  if (looksSensitivePath(target)) return 'high';

  const workingDirectory = context.workingDirectory || process.cwd();
  const workspaceRoot = context.workspaceRoot || workingDirectory;
  const resolvedWorkingDirectory = path.resolve(workingDirectory);
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  if (!target || target === '.' || target === './' || target === '.\\') {
    return isWithin(resolvedWorkingDirectory, resolvedWorkspaceRoot) ? 'low' : 'medium';
  }
  const resolved = path.resolve(resolvedWorkingDirectory, target);
  if (looksSensitivePath(resolved)) return 'high';
  if (isWithin(resolved, resolvedWorkspaceRoot)) return 'low';
  return 'medium';
}

function classifyWritePathRisk(toolName: string, value: string, context: ToolExecutionContext): ToolRiskLevel {
  const target = value.trim();
  if (!target) return 'medium';
  if (looksSensitivePath(target)) return 'high';

  const workingDirectory = context.workingDirectory || process.cwd();
  const workspaceRoot = context.workspaceRoot || workingDirectory;
  const resolved = path.resolve(workingDirectory, target);
  if (looksSensitivePath(resolved)) return 'high';
  if (
    isCatsCoLocalOwnerSelfContext(context)
    && toolName === 'write_file'
    && !fs.existsSync(resolved)
    && isWithin(resolved, os.homedir())
  ) {
    return 'low';
  }
  if (!isWithin(resolved, workspaceRoot)) return 'high';
  if (toolName === 'write_file' && !fs.existsSync(resolved)) return 'low';
  return 'medium';
}

function isWithin(targetPath: string, parentPath: string): boolean {
  const target = path.resolve(targetPath);
  const parent = path.resolve(parentPath);
  if (target === parent) return true;
  const relative = path.relative(parent, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function looksDangerousShell(value: string): boolean {
  const text = value.toLowerCase();
  if (!text) return false;
  return /\brm\s+-rf\b/.test(text)
    || /\bremove-item\b[\s\S]*\b-recurse\b/.test(text)
    || /\bdel\s+\/[sq]\b/.test(text)
    || /\bformat\s+[a-z]:/.test(text)
    || /\bshutdown\b/.test(text)
    || /\breboot\b/.test(text)
    || /(curl|wget|irm|iwr)[\s\S]*(\||;\s*)(sh|bash|powershell|pwsh|cmd)\b/.test(text);
}
