import { Message } from '../types';
import { renderRequiredDefaultPromptFile } from '../utils/prompt-template';
import { SkillManager } from './skill-manager';
import type { Skill } from '../types/skill';

export const TRANSIENT_SKILLS_LIST_PREFIX = '[transient_skills_list]';
export type SkillReloadHandler = () => Promise<void>;

export interface SkillCommandResult {
  handled: boolean;
  reply?: string;
}

export interface BuildSkillsListMessageOptions {
  skillNames?: string[];
}

export class SessionSkillRuntime {
  constructor(
    private skillManager: SkillManager,
    private sessionKey: string,
    private reloadHandler: SkillReloadHandler = () => this.skillManager.loadSkills(),
  ) {}

  setReloadHandler(handler: SkillReloadHandler): void {
    this.reloadHandler = handler;
  }

  async reloadSkills(): Promise<void> {
    await this.reloadHandler();
  }

  buildSkillsListMessage(options: BuildSkillsListMessageOptions = {}): Message | undefined {
    const allowedNames = options.skillNames && options.skillNames.length > 0
      ? new Set(options.skillNames)
      : undefined;
    const skills = this.skillManager
      .getUserInvocableSkills()
      .filter(skill => !allowedNames
        || allowedNames.has(skill.metadata.name)
        || isGeneratedDistilledSkill(skill));
    if (skills.length === 0) return undefined;

    const skillList = skills
      .map(skill => `- ${skill.metadata.name}: ${skill.metadata.description}`)
      .join('\n');

    return {
      role: 'system',
      content: `${TRANSIENT_SKILLS_LIST_PREFIX}\n${renderRequiredDefaultPromptFile('transient/skills-list.md', { skillList })}`,
    };
  }

  handleSkillsCommand(): SkillCommandResult {
    const skills = this.skillManager.getUserInvocableSkills();
    if (skills.length === 0) {
      return { handled: true, reply: '暂无可用的 skills。' };
    }

    const lines = skills.map(skill => {
      const hint = skill.metadata.argumentHint ? ` ${skill.metadata.argumentHint}` : '';
      return `${skill.metadata.name}${hint}\n  ${skill.metadata.description}`;
    });

    return { handled: true, reply: '可用的 Skills（请通过 skill 工具调用）：\n\n' + lines.join('\n\n') };
  }
}

function isGeneratedDistilledSkill(skill: Skill): boolean {
  return skill.filePath.split(/[\\/]+/).includes('generated-distilled');
}
