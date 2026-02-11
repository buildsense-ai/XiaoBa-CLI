import { ToolExecutionContext } from '../types/tool';
import {
  isBashCommandAllowed,
  isPathAllowed,
  isReadPathAllowed,
  isToolAllowed,
} from './safety';

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  errorCode?: string;
}

/**
 * ToolPolicyGateway 统一封装工具策略检查，后续可接入更细粒度 ACL。
 */
export class ToolPolicyGateway {
  static checkTool(toolName: string, _context: ToolExecutionContext): PolicyDecision {
    const decision = isToolAllowed(toolName);
    if (!decision.allowed) {
      return {
        allowed: false,
        reason: decision.reason,
        errorCode: 'TOOL_BLOCKED',
      };
    }
    return { allowed: true };
  }

  static checkBashCommand(command: string): PolicyDecision {
    const decision = isBashCommandAllowed(command);
    if (!decision.allowed) {
      return {
        allowed: false,
        reason: decision.reason,
        errorCode: 'BASH_BLOCKED',
      };
    }
    return { allowed: true };
  }

  static checkReadPath(targetPath: string, context: ToolExecutionContext): PolicyDecision {
    const decision = isReadPathAllowed(targetPath, context.workingDirectory);
    if (!decision.allowed) {
      return {
        allowed: false,
        reason: decision.reason,
        errorCode: 'READ_PATH_BLOCKED',
      };
    }
    return { allowed: true };
  }

  static checkWritePath(targetPath: string, context: ToolExecutionContext): PolicyDecision {
    const decision = isPathAllowed(targetPath, context.workingDirectory);
    if (!decision.allowed) {
      return {
        allowed: false,
        reason: decision.reason,
        errorCode: 'WRITE_PATH_BLOCKED',
      };
    }
    return { allowed: true };
  }
}

