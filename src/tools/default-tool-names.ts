export const DEFAULT_TOOL_NAMES = [
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'execute_shell',
  'send_text',
  'send_file',
  'send_to_inspector',
  'spawn_subagent',
  'check_subagent',
  'stop_subagent',
  'resume_subagent',
  'skill',
] as const;

export const OPTIONAL_DEFAULT_TOOL_NAMES = [
  'gauzmem_search',
] as const;

export const KNOWN_TOOL_NAMES = [
  ...DEFAULT_TOOL_NAMES.slice(0, -1),
  ...OPTIONAL_DEFAULT_TOOL_NAMES,
  DEFAULT_TOOL_NAMES[DEFAULT_TOOL_NAMES.length - 1],
] as const;

export type DefaultToolName = typeof KNOWN_TOOL_NAMES[number];

export function shouldEnableGauzMemTool(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.GAUZMEM_ENABLED || '').toLowerCase() === 'true';
}

export function resolveDefaultToolNames(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!shouldEnableGauzMemTool(env)) return [...DEFAULT_TOOL_NAMES];
  return [...KNOWN_TOOL_NAMES];
}
