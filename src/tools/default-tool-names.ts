export const DEFAULT_TOOL_NAMES = [
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'resolve_common_directory',
  'execute_shell',
  'send_text',
  'send_file',
  'import_file',
  'spawn_subagent',
  'check_subagent',
  'wait_subagents',
  'stop_subagent',
  'resume_subagent',
  'update_plan',
  'record_decision',
  'share_skillhub_skill',
  'skillhub',
  'skill',
  // Native read-only recall over the Agent-private CatsLog daily knowledge
  // corpus. Default-enabled by name; actual exposure is capability-gated: the
  // ToolManager registers it only when a device-bound provider was supplied,
  // and every call re-checks live login/state (typed unavailable otherwise —
  // never a fake-empty result). Explicit profile allowlists that omit the
  // name keep it off.
  'catslog_knowledge_recall',
] as const;

export type DefaultToolName = typeof DEFAULT_TOOL_NAMES[number];
