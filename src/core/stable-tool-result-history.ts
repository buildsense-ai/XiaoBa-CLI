import { Message } from '../types';
import {
  foldHistoricalReadFileMessages,
  ReadFileMessageFoldingOptions,
} from './read-file-message-folder';
import {
  ExecuteShellMessageFoldingOptions,
  foldHistoricalExecuteShellMessages,
} from './execute-shell-message-folder';

export interface StableToolResultStats {
  readFileFoldedCount: number;
  executeShellFoldedCount: number;
  stabilizedCount: number;
}

/**
 * Normalizes supported tool results exactly once before a completed run is persisted.
 * Later prompt-budget passes must leave these historical bytes unchanged.
 */
export function stabilizeToolResultsForHistory(
  messages: Message[],
  newMessages: Message[],
  readFileOptions: ReadFileMessageFoldingOptions,
  executeShellOptions: ExecuteShellMessageFoldingOptions,
): StableToolResultStats {
  const readResult = foldHistoricalReadFileMessages(messages, {
    ...readFileOptions,
    foldCurrentRun: true,
    keepRecentHistoricalReads: 0,
    protectedCurrentRunToolResultIndexes: undefined,
  });
  const shellResult = foldHistoricalExecuteShellMessages(readResult.messages, {
    ...executeShellOptions,
    foldCurrentRun: true,
    keepRecentHistoricalShells: 0,
    protectedCurrentRunToolResultIndexes: undefined,
  });

  const stableByCallId = new Map<string, Message>();
  let stabilizedCount = 0;
  const stableMessages = shellResult.messages.map(message => {
    if (!isSupportedToolResult(message)) return message;
    const stable = message.__toolResultStable ? message : { ...message, __toolResultStable: true };
    if (!message.__toolResultStable) stabilizedCount++;
    if (stable.tool_call_id) stableByCallId.set(stable.tool_call_id, stable);
    return stable;
  });

  replaceMessages(messages, stableMessages);
  replaceMessages(newMessages, newMessages.map(message => {
    const stable = message.tool_call_id ? stableByCallId.get(message.tool_call_id) : undefined;
    return stable ? { ...message, content: stable.content, __toolResultStable: true } : message;
  }));

  return {
    readFileFoldedCount: readResult.stats.folded_count,
    executeShellFoldedCount: shellResult.stats.folded_count,
    stabilizedCount,
  };
}

function isSupportedToolResult(message: Message): boolean {
  if (message.role !== 'tool') return false;
  const name = message.name?.toLowerCase();
  return name === 'read_file'
    || name === 'execute_shell'
    || name === 'bash'
    || name === 'shell'
    || name === 'execute_bash';
}

function replaceMessages(target: Message[], next: Message[]): void {
  target.length = 0;
  target.push(...next);
}
