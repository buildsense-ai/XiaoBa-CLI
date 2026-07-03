export interface DefaultSkillHubSkill {
  key: string;
  skillId: string;
  version: string;
  installName: string;
}

export const DEFAULT_SKILLHUB_SKILLS: DefaultSkillHubSkill[] = [
  { key: 'lin/agent-browser', skillId: 'lin/agent-browser', version: '1.0.3', installName: 'agent-browser' },
];
