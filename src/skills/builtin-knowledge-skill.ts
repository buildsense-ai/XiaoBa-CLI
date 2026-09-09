import * as path from 'path';
import { PathResolver } from '../utils/path-resolver';
import { SkillParser } from './skill-parser';
import { Skill } from '../types/skill';

export const KNOWLEDGE_SKILL_NAME = 'xiaoba-knowledge';
// Package resources, separate from the mutable per-bot Skill workspace.
export const KNOWLEDGE_SKILL_FILE = path.resolve(__dirname, '../../skills', KNOWLEDGE_SKILL_NAME, 'SKILL.md');

export function isBuiltinKnowledgeSkillFile(file: string): boolean {
  return path.resolve(file) === path.resolve(KNOWLEDGE_SKILL_FILE);
}

export function loadBuiltinKnowledgeSkill(): Skill {
  return SkillParser.parse(KNOWLEDGE_SKILL_FILE);
}

// Resolve runtime paths only on invocation, never in the cached Skill listing.
export function renderKnowledgePaths(skill: Skill): Skill {
  if (!isBuiltinKnowledgeSkillFile(skill.filePath)) return skill;
  return {
    ...skill,
    content: skill.content
      .replace(/<KNOWLEDGE_ROOT>/g, () => path.join(PathResolver.getRuntimeDataRoot(), 'knowledge'))
      .replace(/<KNOWLEDGE_NODE>/g, () => process.env.XIAOBA_NODE_EXECUTABLE?.trim() || process.execPath),
  };
}
