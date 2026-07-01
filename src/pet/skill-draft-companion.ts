import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  listRecentSessionLogs,
  readSessionLogByFileId,
} from '../dashboard/session-logs';
import { PathResolver } from '../utils/path-resolver';
import { isSessionTurnEntry } from '../utils/session-log-schema';

export interface SkillDraft {
  id: string;
  name: string;
  description: string;
  action: 'create_local_skill' | 'update_local_skill';
  reason: string;
  skillMarkdown: string;
  requiresConfirmation: true;
  autoInstall: false;
  createdAt: string;
  source: {
    sessions: number;
    shellFailures: number;
    runtimeErrors: number;
    failures: number;
    toolCalls: number;
    preferenceSignals: number;
    repeatedTaskSignals: number;
  };
  references: {
    hermes: string;
  };
}

export interface SkillDraftApplyResult {
  ok: true;
  skill: {
    name: string;
    path: string;
    action: 'created' | 'updated';
    autoInstall: false;
  };
  draft: SkillDraft;
}

interface SkillDraftSignals {
  sessions: number;
  shellFailures: number;
  runtimeErrors: number;
  failures: number;
  toolCalls: number;
  preferenceSnippets: string[];
  commonTasks: Map<string, number>;
}

const MIN_SHELL_FAILURES_FOR_SKILL_DRAFT = 2;

export function getSkillDrafts(options: {
  days?: number;
  limit?: number;
} = {}): { drafts: SkillDraft[]; scanned: number } {
  const sessions = listRecentSessionLogs({
    days: options.days || 7,
    limit: options.limit || 20,
  });
  const signals: SkillDraftSignals = {
    sessions: sessions.length,
    shellFailures: 0,
    runtimeErrors: 0,
    failures: 0,
    toolCalls: 0,
    preferenceSnippets: [],
    commonTasks: new Map(),
  };

  for (const session of sessions) {
    signals.runtimeErrors += session.runtimeErrors;
    signals.failures += session.failures;
    signals.toolCalls += session.toolCalls;
    const detail = readSessionLogByFileId(session.fileId);
    if (!detail) continue;
    for (const entry of detail.entries) {
      if (!isSessionTurnEntry(entry)) continue;
      const userText = compactText(entry.user.text);
      if (looksLikeUserPreference(userText)) {
        pushUnique(signals.preferenceSnippets, userText, 5);
      }
      const taskKey = extractCommonTaskKey(userText);
      if (taskKey) {
        signals.commonTasks.set(taskKey, (signals.commonTasks.get(taskKey) || 0) + 1);
      }
      for (const toolCall of entry.assistant.tool_calls) {
        if (toolCall.name === 'execute_shell' && looksLikeShellFailure(toolCall.result)) {
          signals.shellFailures += 1;
        }
      }
    }
  }

  const drafts: SkillDraft[] = [];
  if (signals.shellFailures >= MIN_SHELL_FAILURES_FOR_SKILL_DRAFT) {
    drafts.push(buildShellRecoveryDraft(signals));
  }
  if (signals.runtimeErrors >= 2 || signals.failures >= 3) {
    drafts.push(buildDebuggingTriageDraft(signals));
  }
  if (signals.preferenceSnippets.length > 0) {
    drafts.push(buildUserPreferenceDraft(signals));
  }
  const repeatedTasks = getRepeatedTasks(signals);
  if (repeatedTasks.length > 0) {
    drafts.push(buildCommonTaskDraft(signals, repeatedTasks));
  }

  return {
    drafts,
    scanned: sessions.length,
  };
}

export function applySkillDraft(id: string): SkillDraftApplyResult {
  const drafts = getSkillDrafts({ days: 7, limit: 20 }).drafts;
  const draft = drafts.find(item => item.id === id);
  if (!draft) {
    const error = new Error('Skill draft not found or no longer matches recent logs');
    (error as any).status = 404;
    throw error;
  }

  const skillDir = path.join(PathResolver.getSkillsPath(), safeSkillDirectoryName(draft.name));
  const skillPath = path.join(skillDir, 'SKILL.md');
  const exists = fs.existsSync(skillPath);
  if (exists && !isCatsCoGeneratedSkill(skillPath)) {
    const error = new Error(`Refusing to overwrite non-generated skill: ${draft.name}`);
    (error as any).status = 409;
    throw error;
  }

  PathResolver.ensureDir(skillDir);
  const tempPath = `${skillPath}.tmp`;
  fs.writeFileSync(tempPath, draft.skillMarkdown, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, skillPath);

  return {
    ok: true,
    skill: {
      name: draft.name,
      path: skillPath,
      action: exists ? 'updated' : 'created',
      autoInstall: false,
    },
    draft,
  };
}

function buildShellRecoveryDraft(signals: SkillDraftSignals): SkillDraft {
  const name = 'shell-recovery-workflow';
  const description = 'Recover from failed shell commands with PowerShell-aware checks, safer alternatives, and concise user-facing repair steps.';
  const source = buildSource(signals);
  const reason = `Recent session logs show ${signals.shellFailures} shell failure${signals.shellFailures === 1 ? '' : 's'} across ${signals.sessions} scanned session${signals.sessions === 1 ? '' : 's'}.`;
  const id = stableDraftId(name, source);
  const createdAt = new Date().toISOString();
  const skillMarkdown = buildSkillMarkdown({
    name,
    description,
    id,
    createdAt,
    title: 'Shell Recovery Workflow',
    summary: 'Use this skill when shell commands fail, especially on Windows PowerShell or when a command assumes POSIX tools.',
    sections: [
      {
        heading: 'When To Use',
        lines: [
          'A command returns "command not found", "not recognized", "permission denied", or similar shell failures.',
          'A task requires translating Unix-style shell snippets into PowerShell-safe commands.',
          'The user needs a concise explanation of what failed and a safe retry plan.',
        ],
      },
      {
        heading: 'Workflow',
        lines: [
          'Identify the shell and current working directory before retrying.',
          'Check whether the failed command is unavailable, misspelled, blocked by permissions, or using syntax from another shell.',
          'Prefer native PowerShell cmdlets on Windows, such as `Get-ChildItem`, `Select-String`, `Copy-Item`, and `Remove-Item` with `-LiteralPath`.',
          'For destructive actions, resolve absolute paths first and confirm the target stays inside the intended workspace.',
          'Retry with the smallest safe command that proves the fix, then summarize what changed.',
        ],
      },
      generatedStats(signals, [
        `Shell failures observed: ${signals.shellFailures}`,
      ]),
    ],
  });
  return createDraft({ name, description, reason, skillMarkdown, source, createdAt, id });
}

function buildDebuggingTriageDraft(signals: SkillDraftSignals): SkillDraft {
  const name = 'debugging-triage-workflow';
  const description = 'Triage repeated failures and runtime errors from recent logs before retrying fixes.';
  const source = buildSource(signals);
  const reason = `Recent session logs show ${signals.runtimeErrors} runtime error${signals.runtimeErrors === 1 ? '' : 's'} and ${signals.failures} failed turn${signals.failures === 1 ? '' : 's'}.`;
  const id = stableDraftId(name, source);
  const createdAt = new Date().toISOString();
  const skillMarkdown = buildSkillMarkdown({
    name,
    description,
    id,
    createdAt,
    title: 'Debugging Triage Workflow',
    summary: 'Use this skill when a task has repeated failures, runtime error logs, or unclear retry loops.',
    sections: [
      {
        heading: 'When To Use',
        lines: [
          'A session has multiple failed turns or runtime error entries.',
          'The assistant is retrying without first identifying the failure class.',
          'The user asks to continue debugging after an earlier failure.',
        ],
      },
      {
        heading: 'Workflow',
        lines: [
          'Group failures by symptom: command failure, runtime exception, missing file, bad input, or external service issue.',
          'Read the most recent session log before proposing another fix.',
          'State the smallest reproducible failure and the next verification command.',
          'After a fix, run the narrowest test that proves the failure no longer reproduces.',
          'If the same class fails twice, stop broad retries and inspect configuration, credentials, or environment state.',
        ],
      },
      generatedStats(signals, [
        `Runtime errors observed: ${signals.runtimeErrors}`,
        `Failed turns observed: ${signals.failures}`,
      ]),
    ],
  });
  return createDraft({ name, description, reason, skillMarkdown, source, createdAt, id });
}

function buildUserPreferenceDraft(signals: SkillDraftSignals): SkillDraft {
  const name = 'user-preference-workflow';
  const description = 'Capture explicit user preferences from recent conversations and apply them to future task handling.';
  const source = buildSource(signals);
  const reason = `Recent logs include ${signals.preferenceSnippets.length} explicit user preference signal${signals.preferenceSnippets.length === 1 ? '' : 's'}.`;
  const id = stableDraftId(name, { ...source, snippets: signals.preferenceSnippets });
  const createdAt = new Date().toISOString();
  const skillMarkdown = buildSkillMarkdown({
    name,
    description,
    id,
    createdAt,
    title: 'User Preference Workflow',
    summary: 'Use this skill when the user states how they want answers, workflow, tone, or formatting handled.',
    sections: [
      {
        heading: 'Detected Preferences',
        lines: signals.preferenceSnippets.map(snippet => `Observed preference: ${snippet}`),
      },
      {
        heading: 'Workflow',
        lines: [
          'Treat explicit user corrections as behavior requirements, not casual remarks.',
          'Apply the preference immediately in the current task when it is safe.',
          'Keep responses aligned with the preference until the user changes it.',
          'If the preference conflicts with safety or correctness, explain the constraint briefly and offer the closest safe alternative.',
        ],
      },
      generatedStats(signals, [
        `Preference signals observed: ${signals.preferenceSnippets.length}`,
      ]),
    ],
  });
  return createDraft({ name, description, reason, skillMarkdown, source, createdAt, id });
}

function buildCommonTaskDraft(signals: SkillDraftSignals, repeatedTasks: Array<{ task: string; count: number }>): SkillDraft {
  const name = 'common-task-workflow';
  const description = 'Turn repeated user requests into a reusable workflow with stable steps and checks.';
  const source = buildSource(signals);
  const topTask = repeatedTasks[0];
  const reason = `Recent logs show repeated task "${topTask.task}" ${topTask.count} times.`;
  const id = stableDraftId(name, { ...source, repeatedTasks });
  const createdAt = new Date().toISOString();
  const skillMarkdown = buildSkillMarkdown({
    name,
    description,
    id,
    createdAt,
    title: 'Common Task Workflow',
    summary: 'Use this skill when the user repeats the same task class across recent conversations.',
    sections: [
      {
        heading: 'Detected Common Tasks',
        lines: repeatedTasks.map(item => `${item.task}: seen ${item.count} times`),
      },
      {
        heading: 'Workflow',
        lines: [
          'Identify the recurring task class before starting implementation.',
          'Reuse the previous successful structure when available, but refresh facts and dates.',
          'Ask only for missing inputs that materially affect the result.',
          'Finish with the artifact or action the user normally expects for this recurring task.',
        ],
      },
      generatedStats(signals, [
        `Repeated task classes observed: ${repeatedTasks.length}`,
      ]),
    ],
  });
  return createDraft({ name, description, reason, skillMarkdown, source, createdAt, id });
}

function generatedStats(signals: SkillDraftSignals, extra: string[]): { heading: string; lines: string[] } {
  return {
    heading: 'Generated From Recent Logs',
    lines: [
      `Sessions scanned: ${signals.sessions}`,
      `Tool calls observed: ${signals.toolCalls}`,
      ...extra,
    ],
  };
}

function createDraft(input: {
  name: string;
  description: string;
  reason: string;
  skillMarkdown: string;
  source: SkillDraft['source'];
  createdAt: string;
  id: string;
}): SkillDraft {
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    action: isExistingGeneratedSkill(input.name) ? 'update_local_skill' : 'create_local_skill',
    reason: input.reason,
    skillMarkdown: input.skillMarkdown,
    requiresConfirmation: true,
    autoInstall: false,
    createdAt: input.createdAt,
    source: input.source,
    references: {
      hermes: 'Inspired by Hermes background_review: background analysis proposes skill updates, but user confirmation gates writes in CatsCo.',
    },
  };
}

function buildSource(signals: SkillDraftSignals): SkillDraft['source'] {
  return {
    sessions: signals.sessions,
    shellFailures: signals.shellFailures,
    runtimeErrors: signals.runtimeErrors,
    failures: signals.failures,
    toolCalls: signals.toolCalls,
    preferenceSignals: signals.preferenceSnippets.length,
    repeatedTaskSignals: getRepeatedTasks(signals).length,
  };
}

function buildSkillMarkdown(input: {
  name: string;
  description: string;
  id: string;
  createdAt: string;
  title: string;
  summary: string;
  sections: Array<{ heading: string; lines: string[] }>;
}): string {
  const lines = [
    '---',
    `name: ${input.name}`,
    `description: ${input.description}`,
    'user-invocable: true',
    'x-catsco-generated: true',
    'x-catsco-generated-from: session-logs',
    `x-catsco-draft-id: ${input.id}`,
    `x-catsco-updated-at: ${input.createdAt}`,
    '---',
    '',
    `# ${input.title}`,
    '',
    input.summary,
    '',
  ];

  for (const section of input.sections) {
    lines.push(`## ${section.heading}`, '');
    section.lines.forEach((line, index) => {
      const safeLine = sanitizeMarkdownLine(line);
      lines.push(section.heading === 'Workflow' ? `${index + 1}. ${safeLine}` : `- ${safeLine}`);
    });
    lines.push('');
  }

  lines.push('This skill was generated as a local draft by the CatsCo companion. Review it before sharing or publishing.');
  return lines.join('\n');
}

function getRepeatedTasks(signals: SkillDraftSignals): Array<{ task: string; count: number }> {
  return Array.from(signals.commonTasks.entries())
    .filter(([, count]) => count >= 2)
    .map(([task, count]) => ({ task, count }))
    .sort((a, b) => b.count - a.count || a.task.localeCompare(b.task))
    .slice(0, 5);
}

function extractCommonTaskKey(text: string): string {
  const normalized = compactText(text);
  if (!normalized) return '';
  const knownTasks = [
    '\u6574\u7406\u65e5\u62a5',
    '\u5199\u65e5\u62a5',
    '\u751f\u6210\u5468\u62a5',
    '\u6574\u7406\u5468\u62a5',
    '\u6392\u67e5\u9519\u8bef',
    '\u4fee\u590d\u6d4b\u8bd5',
    '\u751f\u6210\u56fe\u7247',
  ];
  for (const task of knownTasks) {
    if (normalized.includes(task)) return task;
  }
  const match = normalized.match(/(?:\u5e2e\u6211|\u8bf7|\u7ee7\u7eed|\u518d)?(?:\u505a|\u5199|\u6574\u7406|\u751f\u6210|\u521b\u5efa|\u6392\u67e5|\u4fee\u590d)([^\u3002\uff0c,.!?]{2,18})/);
  return match ? compactText(match[0]).slice(0, 24) : '';
}

function looksLikeUserPreference(text: string): boolean {
  return /(\u4ee5\u540e|\u8bb0\u4f4f|\u504f\u597d|\u4e0d\u8981|\u522b\u518d|\u8bf7\u7528|\u6211\u559c\u6b22|\u6211\u5e0c\u671b|always|never|prefer|from now on)/i.test(text || '');
}

function pushUnique(target: string[], value: string, limit: number): void {
  const next = compactText(value);
  if (!next || target.includes(next)) return;
  target.push(next);
  if (target.length > limit) target.splice(limit);
}

function compactText(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function sanitizeMarkdownLine(value: string): string {
  return compactText(value).replace(/\r?\n/g, ' ');
}

function stableDraftId(name: string, source: unknown): string {
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ name, source }))
    .digest('hex')
    .slice(0, 16);
  return `${name}:${hash}`;
}

function safeSkillDirectoryName(name: string): string {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'generated-skill';
}

function isExistingGeneratedSkill(name: string): boolean {
  const skillPath = path.join(PathResolver.getSkillsPath(), safeSkillDirectoryName(name), 'SKILL.md');
  return fs.existsSync(skillPath) && isCatsCoGeneratedSkill(skillPath);
}

function isCatsCoGeneratedSkill(skillPath: string): boolean {
  try {
    return fs.readFileSync(skillPath, 'utf8').includes('x-catsco-generated: true');
  } catch (_error) {
    return false;
  }
}

function looksLikeShellFailure(text: string): boolean {
  return /(command not found|not recognized|is not recognized|not found|permission denied|access denied|no such file|cannot find)/i.test(text || '');
}
