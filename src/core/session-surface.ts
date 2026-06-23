import { parseSessionKeyV2 } from './session-router';

export type SessionSurface = 'cli' | 'feishu' | 'catscompany' | 'weixin';

export interface ComposeSurfacePromptOptions {
  promptsDir?: string;
}

export function resolveSessionSurface(sessionKey: string, sessionType?: string): SessionSurface {
  const parsedV2 = parseSessionKeyV2(sessionKey);
  if (parsedV2) {
    if (parsedV2.source === 'catscompany') return 'catscompany';
    if (parsedV2.source === 'feishu') return 'feishu';
    if (parsedV2.source === 'weixin') return 'weixin';
    return 'cli';
  }

  const normalizedSessionType = (sessionType || '').toLowerCase();
  if (normalizedSessionType === 'weixin') return 'weixin';
  if (normalizedSessionType === 'feishu') return 'feishu';
  if (normalizedSessionType === 'catscompany') return 'catscompany';

  if (sessionKey.startsWith('cc_user:') || sessionKey.startsWith('cc_group:')) {
    return 'catscompany';
  }
  if (sessionKey.startsWith('user:') || sessionKey.startsWith('group:')) {
    return 'feishu';
  }
  return 'cli';
}

export function composeSurfacePrompt(
  sessionKey: string,
  sessionType?: string,
  _options: ComposeSurfacePromptOptions = {},
): string | undefined {
  resolveSessionSurface(sessionKey, sessionType);
  return undefined;
}
