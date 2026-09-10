import * as path from 'path';
import { Skill } from '../types/skill';
import { PathResolver } from '../utils/path-resolver';
import { SkillParser } from './skill-parser';

export const PROMPT_EDITOR_SKILL_FILE = path.resolve(__dirname, '../../skills/catsco-prompt-editor/SKILL.md');

export function loadBuiltinPromptEditorSkill(): Skill {
  return SkillParser.parse(PROMPT_EDITOR_SKILL_FILE);
}

export function renderPromptEditorPaths(skill: Skill): Skill {
  if (path.resolve(skill.filePath) !== PROMPT_EDITOR_SKILL_FILE) return skill;
  return {
    ...skill,
    content: skill.content
      .replace(/<PROMPT_RUNTIME_ROOT>/g, () => PathResolver.getRuntimeDataRoot())
      .replace(/<PROMPT_NODE>/g, () => process.env.XIAOBA_NODE_EXECUTABLE?.trim() || process.execPath),
  };
}
