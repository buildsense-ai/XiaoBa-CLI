/**
 * Skill 元数据接口
 */
export interface SkillMetadata {
  name: string;                    // skill 名称
  description: string;             // 描述（用于自动匹配）
  argumentHint?: string;           // 参数提示
  userInvocable?: boolean;         // 是否允许用户调用（默认 true）
  autoInvocable?: boolean;         // 是否允许自动调用（默认 true）
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
