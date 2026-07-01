import {
  listRecentSessionLogs,
  readSessionLogByFileId,
} from '../dashboard/session-logs';
import { isSessionTurnEntry } from '../utils/session-log-schema';

export interface SkillCompanionRecommendation {
  id: string;
  title: string;
  reason: string;
  action: 'skillhub_search';
  searchQuery: string;
  autoInstall: false;
  score: number;
  createdAt: string;
  source: {
    sessions: number;
    shellFailures: number;
    failures: number;
    runtimeErrors: number;
    toolCalls: number;
  };
}

const MIN_SHELL_FAILURES_FOR_RECOMMENDATION = 2;

export function getSkillCompanionRecommendations(options: {
  days?: number;
  limit?: number;
} = {}): { recommendations: SkillCompanionRecommendation[]; scanned: number } {
  const sessions = listRecentSessionLogs({
    days: options.days || 7,
    limit: options.limit || 20,
  });
  const signals = {
    shellFailures: 0,
    runtimeErrors: 0,
    failures: 0,
    toolCalls: 0,
  };

  for (const session of sessions) {
    signals.runtimeErrors += session.runtimeErrors;
    signals.failures += session.failures;
    signals.toolCalls += session.toolCalls;
    const detail = readSessionLogByFileId(session.fileId);
    if (!detail) continue;
    for (const entry of detail.entries) {
      if (!isSessionTurnEntry(entry)) continue;
      for (const toolCall of entry.assistant.tool_calls) {
        if (toolCall.name === 'execute_shell' && looksLikeShellFailure(toolCall.result)) {
          signals.shellFailures += 1;
        }
      }
    }
  }

  const recommendations: SkillCompanionRecommendation[] = [];
  const now = new Date().toISOString();
  const source = {
    sessions: sessions.length,
    shellFailures: signals.shellFailures,
    failures: signals.failures,
    runtimeErrors: signals.runtimeErrors,
    toolCalls: signals.toolCalls,
  };

  if (signals.shellFailures >= MIN_SHELL_FAILURES_FOR_RECOMMENDATION) {
    recommendations.push({
      id: `shell-help:${signals.shellFailures}`,
      title: 'Shell command helper skill',
      reason: `Recent logs show ${signals.shellFailures} shell failure${signals.shellFailures === 1 ? '' : 's'}. Search SkillHub for a skill that improves shell portability and recovery.`,
      action: 'skillhub_search',
      searchQuery: 'shell powershell command portability',
      autoInstall: false,
      score: Math.min(100, 70 + signals.shellFailures * 5),
      createdAt: now,
      source,
    });
  }

  if (signals.runtimeErrors >= 2 || signals.failures >= 3) {
    recommendations.push({
      id: `debugging-help:${signals.runtimeErrors}:${signals.failures}`,
      title: 'Debugging workflow skill',
      reason: `Recent logs show ${signals.runtimeErrors} runtime error${signals.runtimeErrors === 1 ? '' : 's'} and ${signals.failures} failed turn${signals.failures === 1 ? '' : 's'}. Search SkillHub for a troubleshooting skill before installing anything.`,
      action: 'skillhub_search',
      searchQuery: 'debugging troubleshooting logs',
      autoInstall: false,
      score: Math.min(95, 55 + signals.runtimeErrors * 10 + signals.failures * 3),
      createdAt: now,
      source,
    });
  }

  return {
    recommendations: recommendations
      .sort((a, b) => b.score - a.score)
      .slice(0, 3),
    scanned: sessions.length,
  };
}

function looksLikeShellFailure(text: string): boolean {
  return /(command not found|not recognized|is not recognized|无法将|不是内部|not found|permission denied|访问被拒绝)/i.test(text || '');
}
