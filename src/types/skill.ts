/**
 * Skill 工具策略
 *
 * - allowedTools: 白名单模式（仅这些工具可用，必要工具会自动补齐）
 * - disallowedTools: 黑名单模式（这些工具不可用）
 * - 两者并存时，allowedTools 优先
 */
export interface SkillToolPolicy {
  allowedTools?: string[];
  disallowedTools?: string[];
}

/**
 * Skill 元数据接口
 */
export interface SkillMetadata {
  name: string;                    // skill 名称
  description: string;             // 描述（用于自动匹配）
  argumentHint?: string;           // 参数提示
  userInvocable?: boolean;         // 是否允许用户调用（默认 true）
  autoInvocable?: boolean;         // 是否允许自动调用（默认 true）
  maxTurns?: number;               // 最大工具调用轮次（覆盖默认值）
  toolPolicy?: SkillToolPolicy;    // 工具策略（可选）
}

/**
 * Skill 完整定义
 */
export interface Skill {
  metadata: SkillMetadata;         // 元数据
  content: string;                 // Markdown 内容（提示词）
  filePath: string;                // 文件路径
}

/**
 * Skill 调用上下文
 */
export interface SkillInvocationContext {
  skillName: string;               // skill 名称
  arguments: string[];             // 参数数组
  rawArguments: string;            // 原始参数字符串
  userMessage: string;             // 用户原始消息
}

/**
 * Skill 匹配结果
 */
export interface SkillMatchResult {
  skill: Skill;                    // 匹配到的 skill
  confidence: number;              // 匹配置信度 (0-1)
  reason: string;                  // 匹配原因
}

/**
 * Skill 激活信号（由 skill 工具返回，ConversationRunner 解析）
 */
export interface SkillActivationSignal {
  __type__: 'skill_activation';
  skillName: string;
  prompt: string;
  maxTurns?: number;
  toolPolicy?: SkillToolPolicy;
}
