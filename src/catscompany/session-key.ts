export type CatsSessionChatType = 'p2p' | 'group';

export interface CatsSessionKeyInput {
  topic?: string;
  chatType: CatsSessionChatType;
  senderId?: string;
}

function normalizePart(value: unknown, fallback: string): string {
  const text = String(value || '').trim();
  return text || fallback;
}

export function buildCatsSessionKey(
  input: CatsSessionKeyInput,
  botUid?: string | null,
): string {
  const prefix = input.chatType === 'group' ? 'cc_group' : 'cc_user';
  const botScope = normalizePart(botUid, 'unknown_bot');
  const chatScope = normalizePart(
    input.topic,
    input.chatType === 'group'
      ? 'unknown_group'
      : normalizePart(input.senderId, 'unknown_user'),
  );

  return `${prefix}:${botScope}:${chatScope}`;
}
