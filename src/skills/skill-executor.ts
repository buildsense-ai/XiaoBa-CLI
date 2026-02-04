import { Skill, SkillInvocationContext } from '../types/skill';

/**
 * Skill 执行器
 */
export class SkillExecutor {
  /**
   * 执行 skill
   * @param skill - skill 对象
   * @param context - 调用上下文
   * @returns 处理后的提示词
   */
  static execute(skill: Skill, context: SkillInvocationContext): string {
    let content = skill.content;

    // 替换 $ARGUMENTS
    content = content.replace(/\$ARGUMENTS/g, context.rawArguments);

    // 替换 $0 (skill name)
    content = content.replace(/\$0/g, context.skillName);

    // 替换 $1, $2, $3, ...
    context.arguments.forEach((arg, index) => {
      const placeholder = new RegExp(`\\$${index + 1}`, 'g');
      content = content.replace(placeholder, arg);
    });

    // 清理未替换的占位符
    content = content.replace(/\$\d+/g, '');

    return content;
  }
}
