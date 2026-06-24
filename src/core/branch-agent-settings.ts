export const BRANCH_AGENTS_ENABLED_ENV = 'XIAOBA_BRANCH_AGENTS_ENABLED';

const DISABLED_VALUES = new Set(['false', '0', 'off', 'no', 'disabled']);

export function isBranchAgentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[BRANCH_AGENTS_ENABLED_ENV];
  if (!raw || !raw.trim()) return true;
  return !DISABLED_VALUES.has(raw.trim().toLowerCase());
}

export function serializeBranchAgentsEnabled(enabled: boolean): string {
  return enabled ? 'true' : 'false';
}
