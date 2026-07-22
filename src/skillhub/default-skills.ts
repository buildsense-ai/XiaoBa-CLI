export interface DefaultSkillHubSkill {
  key: string;
  skillId: string;
  version: string;
  installName: string;
}

// agent-browser remains available for explicit installation, but is no longer
// auto-installed: its unpinned npx CLI starts a detached daemon that can outlive
// the task. ShellTool adds an idle timeout as defense in depth for explicit use.
export const DEFAULT_SKILLHUB_SKILLS: DefaultSkillHubSkill[] = [];
