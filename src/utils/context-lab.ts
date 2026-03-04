function envFlag(name: string): boolean {
  const value = (process.env[name] || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function envList(name: string): string[] {
  const raw = (process.env[name] || '').trim();
  if (!raw) {
    return [];
  }
  return Array.from(
    new Set(
      raw
        .split(',')
        .map(item => item.trim())
        .filter(Boolean),
    ),
  );
}

export interface ContextLabFlags {
  enabled: boolean;
  openAiOnly: boolean;
  emptyBasePrompt: boolean;
  disableSurfacePrompt: boolean;
  minimalSurfacePrompt: boolean;
  disableReplyFallback: boolean;
  disableSessionRestore: boolean;
  disablePreviousSummary: boolean;
  disableSkillsCatalog: boolean;
  disableSkillPrompt: boolean;
  disableCompression: boolean;
  disableTransientHints: boolean;
  disableSubagentStatus: boolean;
  allowedTools: string[];
  blockedTools: string[];
}

export function getContextLabFlags(): ContextLabFlags {
  const enabled = envFlag('CONTEXT_LAB_MODE');
  return {
    enabled,
    openAiOnly: enabled && envFlag('CONTEXT_LAB_OPENAI_ONLY'),
    emptyBasePrompt: enabled && envFlag('CONTEXT_LAB_EMPTY_BASE_PROMPT'),
    disableSurfacePrompt: enabled && envFlag('CONTEXT_LAB_DISABLE_SURFACE_PROMPT'),
    minimalSurfacePrompt: enabled && envFlag('CONTEXT_LAB_MINIMAL_SURFACE_PROMPT'),
    disableReplyFallback: enabled && envFlag('CONTEXT_LAB_DISABLE_REPLY_FALLBACK'),
    disableSessionRestore: enabled && envFlag('CONTEXT_LAB_DISABLE_SESSION_RESTORE'),
    disablePreviousSummary: enabled && envFlag('CONTEXT_LAB_DISABLE_PREVIOUS_SUMMARY'),
    disableSkillsCatalog: enabled && envFlag('CONTEXT_LAB_DISABLE_SKILLS_CATALOG'),
    disableSkillPrompt: enabled && envFlag('CONTEXT_LAB_DISABLE_SKILL_PROMPT'),
    disableCompression: enabled && envFlag('CONTEXT_LAB_DISABLE_COMPRESSION'),
    disableTransientHints: enabled && envFlag('CONTEXT_LAB_DISABLE_TRANSIENT_HINTS'),
    disableSubagentStatus: enabled && envFlag('CONTEXT_LAB_DISABLE_SUBAGENT_STATUS'),
    allowedTools: enabled ? envList('CONTEXT_LAB_ALLOWED_TOOLS') : [],
    blockedTools: enabled ? envList('CONTEXT_LAB_BLOCKED_TOOLS') : [],
  };
}

export function describeContextLabFlags(flags: ContextLabFlags): string[] {
  if (!flags.enabled) {
    return [];
  }

  const enabledFlags: string[] = [];
  if (flags.openAiOnly) enabledFlags.push('openai_only');
  if (flags.emptyBasePrompt) enabledFlags.push('empty_base_prompt');
  if (flags.disableSurfacePrompt) enabledFlags.push('disable_surface_prompt');
  if (flags.minimalSurfacePrompt) enabledFlags.push('minimal_surface_prompt');
  if (flags.disableReplyFallback) enabledFlags.push('disable_reply_fallback');
  if (flags.disableSessionRestore) enabledFlags.push('disable_session_restore');
  if (flags.disablePreviousSummary) enabledFlags.push('disable_previous_summary');
  if (flags.disableSkillsCatalog) enabledFlags.push('disable_skills_catalog');
  if (flags.disableSkillPrompt) enabledFlags.push('disable_skill_prompt');
  if (flags.disableCompression) enabledFlags.push('disable_compression');
  if (flags.disableTransientHints) enabledFlags.push('disable_transient_hints');
  if (flags.disableSubagentStatus) enabledFlags.push('disable_subagent_status');
  if (flags.allowedTools.length > 0) enabledFlags.push(`allowed_tools=${flags.allowedTools.join('|')}`);
  if (flags.blockedTools.length > 0) enabledFlags.push(`blocked_tools=${flags.blockedTools.join('|')}`);
  return enabledFlags;
}
