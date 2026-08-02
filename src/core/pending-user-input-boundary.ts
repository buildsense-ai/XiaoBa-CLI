import { Message } from '../types';
import { renderRequiredDefaultPromptFile } from '../utils/prompt-template';
import { annotateContextMessage } from './context-lifecycle';

export const TRANSIENT_PENDING_USER_INPUT_PREFIX = '[transient_pending_user_input]';

export function buildPendingUserInputBoundaryMessage(epoch?: string): Message {
  return annotateContextMessage({
    role: 'system',
    content: `${TRANSIENT_PENDING_USER_INPUT_PREFIX}\n${renderRequiredDefaultPromptFile('transient/pending-user-input-boundary.md', {})}`,
  }, {
    source: 'pending_user_input',
    lifecycle: 'episode',
    cacheScope: 'epoch',
    epoch,
  });
}
