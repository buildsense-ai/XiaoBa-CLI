export interface SkillMetadata {
  name: string;
  description: string;
  argumentHint?: string;
  userInvocable?: boolean;
}

export interface Skill {
  metadata: SkillMetadata;
  content: string;
  filePath: string;
}

export interface SkillInvocationContext {
  skillName: string;
  arguments: string[];
  rawArguments: string;
  userMessage: string;
}

export interface SkillMatchResult {
  skill: Skill;
  confidence: number;
  reason: string;
}
