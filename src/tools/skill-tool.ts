import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { SkillManager } from '../skills/skill-manager';
import { Skill, SkillInvocationContext } from '../types/skill';
import { SkillExecutor } from '../skills/skill-executor';
import { Logger } from '../utils/logger';
import { getPetService } from '../pet/pet-service';
import { PetEventType } from '../pet/pet-types';
import { getDistillationHeartbeatConfig } from '../utils/distillation-heartbeat-config';
import {
  GeneratedCurrentSkillIdentity,
  SkillUsageLedger,
} from '../utils/skill-usage-ledger';

/**
 * Skill 工具 - 调用已注册的 skills
 */
export class SkillTool implements Tool {
  private skillManager: SkillManager;
  private usageLedger: SkillUsageLedger;

  constructor(usageLedger = new SkillUsageLedger(getDistillationHeartbeatConfig().skillUsageLedgerPath)) {
    this.skillManager = new SkillManager();
    this.usageLedger = usageLedger;
  }

  definition: ToolDefinition = {
    name: 'skill',
    description: [
      '加载并返回一个已注册 skill 的任务说明内容。',
      '适合用户明确要求使用某个 skill，或当前任务确实匹配已知 skill 流程时使用。',
      '本工具只提供 skill 指令内容；后续执行仍由主 agent 继续完成。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: '已注册的 skill 名称。'
        },
        args: {
          type: 'string',
          description: '传给 skill 模板的可选原始参数文本。'
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
      const resolution = await this.skillManager.resolveSkill(skillName);
      const skill = resolution?.skill;

      if (!skill) {
        const availableSkills = this.skillManager.getAllSkills()
          .map(s => s.metadata.name)
          .join(', ');
        this.recordPetEvent('skill_failed', skillName, context, {
          status: 'failed',
          message: `「${skillName}」skill 出错了，点我查看`,
          errorCode: 'TOOL_NOT_FOUND',
        });
        return { ok: false, errorCode: 'TOOL_NOT_FOUND', message: `错误：未找到 skill "${skillName}"。\n\n可用的 skills: ${availableSkills}` };
      }

      if (resolution?.redirected) {
        Logger.info(`Skill route 已迁移: ${resolution.requestedName} → ${resolution.resolvedName}`);
      }

      // 检查 skill 是否可被用户调用
      if (skill.metadata.userInvocable === false) {
        this.recordPetEvent('skill_failed', skillName, context, {
          status: 'failed',
          message: `「${skillName}」skill 出错了，点我查看`,
          errorCode: 'PERMISSION_DENIED',
        });
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

      this.recordPetEvent('skill_started', skillName, context);

      // 直接返回渲染后的 SKILL.md 内容，由 tool_result 并入上下文
      const result = SkillExecutor.execute(skill, invocationContext);

      this.recordGeneratedSkillLoad(skill, context, resolution?.requestedName);

      this.recordPetEvent('skill_succeeded', skillName, context);
      return { ok: true, content: result };
    } catch (error: any) {
      if (error?.code === 'STALE_SKILL_REDIRECT') {
        this.recordPetEvent('skill_failed', skillName, context, {
          status: 'failed',
          message: `「${skillName}」skill 路由已失效，点我查看`,
          errorCode: 'STALE_SKILL_REDIRECT',
        });
        return { ok: false, errorCode: 'STALE_SKILL_REDIRECT', message: error.message };
      }
      this.recordPetEvent('skill_failed', skillName, context, {
        status: 'failed',
        message: `「${skillName}」skill 出错了，点我查看`,
        errorCode: 'TOOL_EXECUTION_ERROR',
      });
      Logger.error(`Skill 执行失败: ${error.message}`);
      return { ok: false, errorCode: 'TOOL_EXECUTION_ERROR', message: `Skill 执行失败: ${error.message}` };
    }
  }

  private recordGeneratedSkillLoad(skill: Skill, context: ToolExecutionContext, requestedRoutingName?: string): void {
    if (!isGeneratedDistilledSkill(skill) || !context.sessionId || !context.episodeId) return;
    this.usageLedger.recordGeneratedSkillLoad({
      runtimeSessionId: context.sessionId,
      episodeId: context.episodeId,
      requestedRoutingName,
      skill: generatedSkillIdentity(skill),
    });
  }

  private recordPetEvent(
    eventType: PetEventType,
    skillName: string,
    context: ToolExecutionContext,
    options: { status?: string; message?: string; errorCode?: string } = {},
  ): void {
    getPetService().recordEvent({
      event_type: eventType,
      skill_name: skillName,
      status: options.status,
      message: options.message,
      session_id: context.sessionId,
      metadata: {
        surface: context.surface,
        error_code: options.errorCode,
      },
    });
  }
}

function isGeneratedDistilledSkill(skill: Skill): boolean {
  return skill.filePath.split(/[\\/]+/).includes('generated-distilled');
}

function generatedSkillIdentity(skill: Skill): GeneratedCurrentSkillIdentity {
  const segments = skill.filePath.split(/[\\/]+/);
  const generatedIndex = segments.lastIndexOf('generated-distilled');
  const capabilityHandle = generatedIndex >= 0 ? segments[generatedIndex + 1] : undefined;
  if (!capabilityHandle) throw new Error(`Generated skill path has no capability handle: ${skill.filePath}`);
  return {
    capabilityHandle,
    routingName: skill.metadata.name,
    skillFilePath: skill.filePath,
    guidanceHash: crypto.createHash('sha256').update(fs.readFileSync(skill.filePath)).digest('hex'),
  };
}
