import { Tool } from './tool';

/**
 * Agent 类型
 */
export type AgentType =
  | 'general-purpose'  // 通用智能体
  | 'explore'          // 代码库探索智能体
  | 'plan'             // 规划制定智能体
  | 'bash'             // 命令执行专家智能体
  | 'code-reviewer';   // 代码审查智能体

/**
 * Agent 状态
 */
export type AgentStatus =
  | 'idle'       // 空闲
  | 'running'    // 运行中
  | 'completed'  // 已完成
  | 'failed'     // 失败
  | 'stopped';   // 已停止

/**
 * Agent 配置
 */
export interface AgentConfig {
  type: AgentType;
  description: string;
  prompt: string;
  model?: 'sonnet' | 'opus' | 'haiku';
  maxTurns?: number;
  runInBackground?: boolean;
  availableTools?: string[];  // 可用工具名称列表
}

/**
 * Agent 执行上下文
 */
export interface AgentContext {
  workingDirectory: string;
  conversationHistory: any[];
  parentAgentId?: string;
  tools: Tool[];
}

/**
 * Agent 执行结果
 */
export interface AgentResult {
  agentId: string;
  status: AgentStatus;
  output: string;
  error?: string;
  executionTime?: number;
}

/**
 * Agent 接口
 */
export interface Agent {
  id: string;
  type: AgentType;
  status: AgentStatus;
  config: AgentConfig;

  /**
   * 执行 Agent 任务
   */
  execute(context: AgentContext): Promise<AgentResult>;

  /**
   * 停止 Agent 执行
   */
  stop(): Promise<void>;

  /**
   * 获取 Agent 输出
   */
  getOutput(): string;
}
