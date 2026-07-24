import * as path from 'path';

export type BotSkillMutationListener = (skillsRoot: string) => void;

const listeners = new Set<BotSkillMutationListener>();

export function onBotSkillMutation(listener: BotSkillMutationListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyBotSkillMutation(skillsRoot: string): void {
  const resolved = path.resolve(skillsRoot);
  for (const listener of listeners) {
    try {
      listener(resolved);
    } catch {
      // Mutation notification is advisory; the next startup scan is the fallback.
    }
  }
}
