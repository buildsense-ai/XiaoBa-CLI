export const DEFAULT_TOOL_NAMES = [
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'execute_shell',
  'send_text',
  'send_file',
  'spawn_subagent',
  'check_subagent',
  'stop_subagent',
  'resume_subagent',
  'update_plan',
  'record_decision',
  'skill',
] as const;

export type DefaultToolName = typeof DEFAULT_TOOL_NAMES[number];
