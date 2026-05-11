import { Message } from '../types';
import { SkillManager } from './skill-manager';

export const TRANSIENT_SKILLS_LIST_PREFIX = '[transient_skills_list]';
export type SkillReloadHandler = () => Promise<void>;

export interface SkillCommandResult {
  handled: boolean;
  reply?: string;
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

  buildSkillsListMessage(): Message | undefined {
    const skills = this.skillManager.getUserInvocableSkills();
    if (skills.length === 0) return undefined;

    const skillList = skills
      .map(skill => `- ${skill.metadata.name}: ${skill.metadata.description}`)
      .join('\n');

    return {
      role: 'system',
      content: `${TRANSIENT_SKILLS_LIST_PREFIX}\n你可以使用以下 skills（必须通过 skill 工具调用）：\n\n${skillList}`,
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
