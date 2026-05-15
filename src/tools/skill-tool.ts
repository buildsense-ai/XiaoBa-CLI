import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { SkillManager } from '../skills/skill-manager';
import { SkillInvocationContext } from '../types/skill';
import { SkillExecutor } from '../skills/skill-executor';
import { Logger } from '../utils/logger';

/**
 * Skill 工具 - 调用已注册的 skills
 */
export class SkillTool implements Tool {
  private skillManager: SkillManager;

  constructor() {
    this.skillManager = new SkillManager();
  }

  definition: ToolDefinition = {
    name: 'skill',
    description: '调用已注册的 skill。Skills 是预定义的任务模板，可以执行复杂的多步骤任务。',
    parameters: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: '已注册的 Skill 名称（例如当前 skills 目录里存在的任务模板）'
        },
        args: {
          type: 'string',
          description: 'Skill 参数（可选）'
        }
      },
      required: ['skill']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const { skill: skillName, args: skillArgs = '' } = args;

    try {
      // 特殊命令：reload
      if (skillName === 'reload' || skillName === '__reload__') {
        await this.skillManager.loadSkills();
        const count = this.skillManager.getAllSkills().length;
        return { ok: true, content: `已重新加载 ${count} 个 skills` };
      }

      // 加载所有 skills
      await this.skillManager.loadSkills();

      // 获取指定的 skill
      const skill = this.skillManager.getSkill(skillName);

      if (!skill) {
        const availableSkills = this.skillManager.getAllSkills()
          .map(s => s.metadata.name)
          .join(', ');
        return { ok: false, errorCode: 'TOOL_NOT_FOUND', message: `错误：未找到 skill "${skillName}"。\n\n可用的 skills: ${availableSkills}` };
      }

      // 检查 skill 是否可被用户调用
      if (skill.metadata.userInvocable === false) {
        return { ok: false, errorCode: 'PERMISSION_DENIED', message: `错误：Skill "${skillName}" 不允许用户调用。` };
      }

      Logger.info(`执行 Skill: ${skillName}`);
      if (skillArgs) {
        Logger.info(`参数: ${skillArgs}`);
      }

      // 解析参数
      const argumentsArray = skillArgs ? skillArgs.trim().split(/\s+/) : [];

      // 创建 skill 调用上下文
      const invocationContext: SkillInvocationContext = {
        skillName: skillName,
        arguments: argumentsArray,
        rawArguments: skillArgs,
        userMessage: skillArgs
      };

      // 直接返回渲染后的 SKILL.md 内容，由 tool_result 并入上下文
      const result = SkillExecutor.execute(skill, invocationContext);

      return { ok: true, content: result };
    } catch (error: any) {
      Logger.error(`Skill 执行失败: ${error.message}`);
      return { ok: false, errorCode: 'TOOL_EXECUTION_ERROR', message: `Skill 执行失败: ${error.message}` };
    }
  }
}
