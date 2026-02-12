import { Agent, AgentConfig, AgentContext, AgentResult, AgentType } from '../types/agent';
import { Logger } from '../utils/logger';
import { Tool } from '../types/tool';
import { randomUUID } from 'crypto';

/**
 * Agent 管理器
 * 负责创建、管理和协调多个 Agent
 */
export class AgentManager {
  private static instance: AgentManager;
  private agents: Map<string, Agent> = new Map();
  private ownerByAgentId: Map<string, string> = new Map();

  private constructor() {}

  /**
   * 获取单例实例
   */
  static getInstance(): AgentManager {
    if (!AgentManager.instance) {
      AgentManager.instance = new AgentManager();
    }
    return AgentManager.instance;
  }

  /**
   * 创建新的 Agent
   */
  async createAgent(config: AgentConfig, ownerSessionId: string = 'unknown'): Promise<string> {
    const agentId = `agent-${randomUUID()}`;

    // 根据类型创建对应的 Agent 实例
    const agent = await this.instantiateAgent(agentId, config);

    this.agents.set(agentId, agent);
    this.ownerByAgentId.set(agentId, ownerSessionId);
    Logger.info(`创建 Agent: ${agentId} (类型: ${config.type})`);

    return agentId;
  }

  /**
   * 执行 Agent
   */
  async executeAgent(
    agentId: string,
    context: AgentContext
  ): Promise<AgentResult> {
    const agent = this.agents.get(agentId);

    if (!agent) {
      throw new Error(`Agent ${agentId} 不存在`);
    }

    Logger.info(`执行 Agent: ${agentId}`);
    try {
      const result = await agent.execute(context);
      return result;
    } finally {
      // 执行完毕后自动清理，避免内存泄漏
      this.agents.delete(agentId);
      this.ownerByAgentId.delete(agentId);
      Logger.info(`Agent ${agentId} 已清理`);
    }
  }

  /**
   * 停止 Agent
   */
  async stopAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);

    if (!agent) {
      throw new Error(`Agent ${agentId} 不存在`);
    }

    await agent.stop();
    Logger.info(`停止 Agent: ${agentId}`);
  }

  /**
   * 获取 Agent 输出
   */
  getAgentOutput(agentId: string): string {
    const agent = this.agents.get(agentId);

    if (!agent) {
      throw new Error(`Agent ${agentId} 不存在`);
    }

    return agent.getOutput();
  }

  /**
   * 获取 Agent
   */
  getAgent(agentId: string): Agent | undefined {
    return this.agents.get(agentId);
  }

  /**
   * 按会话隔离查询 Agent（防止跨会话越权）
   */
  getAgentForOwner(agentId: string, ownerSessionId: string): Agent | undefined {
    const owner = this.ownerByAgentId.get(agentId);
    if (!owner || owner !== ownerSessionId) {
      return undefined;
    }
    return this.agents.get(agentId);
  }

  /**
   * 列出所有 Agent
   */
  listAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  /**
   * 删除 Agent
   */
  removeAgent(agentId: string): boolean {
    this.ownerByAgentId.delete(agentId);
    return this.agents.delete(agentId);
  }

  /**
   * 根据类型实例化 Agent
   */
  private async instantiateAgent(
    agentId: string,
    config: AgentConfig
  ): Promise<Agent> {
    // 动态导入对应的 Agent 类
    switch (config.type) {
      case 'explore':
        const { ExploreAgent } = await import('./explore-agent');
        return new ExploreAgent(agentId, config);

      case 'plan':
        const { PlanAgent } = await import('./plan-agent');
        return new PlanAgent(agentId, config);

      case 'bash':
        const { BashAgent } = await import('./bash-agent');
        return new BashAgent(agentId, config);

      case 'general-purpose':
        const { GeneralPurposeAgent } = await import('./general-purpose-agent');
        return new GeneralPurposeAgent(agentId, config);

      case 'code-reviewer':
        const { CodeReviewerAgent } = await import('./code-reviewer-agent');
        return new CodeReviewerAgent(agentId, config);

      default:
        throw new Error(`不支持的 Agent 类型: ${config.type}`);
    }
  }
}
