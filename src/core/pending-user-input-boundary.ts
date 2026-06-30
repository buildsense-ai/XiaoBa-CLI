import { Message } from '../types';
import { renderRequiredDefaultPromptFile } from '../utils/prompt-template';

export const TRANSIENT_PENDING_USER_INPUT_PREFIX = '[transient_pending_user_input]';

export function buildPendingUserInputBoundaryMessage(): Message {
  return {
    role: 'system',
    content: `${TRANSIENT_PENDING_USER_INPUT_PREFIX}\n${renderRequiredDefaultPromptFile('transient/pending-user-input-boundary.md', {})}`,
  };
}
