export interface DefaultSkillHubSkill {
  key: string;
  skillId: string;
  version: string;
  installName: string;
}

export const DEFAULT_SKILLHUB_SKILLS: DefaultSkillHubSkill[] = [
  { key: 'lin/agent-browser', skillId: 'lin/agent-browser', version: '1.0.3', installName: 'agent-browser' },
  { key: 'atridaisuki/web-search', skillId: 'atridaisuki/web-search', version: '1.0.2', installName: 'web-search' },
  { key: 'atridaisuki/read-pdf', skillId: 'atridaisuki/read-pdf', version: '1.0.15', installName: 'read-pdf' },
  { key: 'atridaisuki/pdf-author-editor', skillId: 'atridaisuki/pdf-author-editor', version: '1.2.5', installName: 'pdf-author-editor' },
  { key: 'atridaisuki/image-asset-generator', skillId: 'atridaisuki/image-asset-generator', version: '1.0.13', installName: 'image-asset-generator' },
];
