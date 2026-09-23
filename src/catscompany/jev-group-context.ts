import type { CatsClient } from './client';
import { agentContextMessageSeq, selectNativeFeishuGroupContextEntries } from './agent-context-history';
import type { CatsCompanyGroupActivationHistoryEntry } from './jev-group-activation';

const HISTORY_PAGE_SIZE = 20;
const HISTORY_WINDOW_SIZE = 10;
const HISTORY_ENTRY_CHARS = 350;

/** Read-only, bounded pre-turn snapshot. Never changes session history or its cursor. */
export async function loadCatsCompanyGroupActivationContext(
  client: Pick<CatsClient, 'getAgentContextHistory'>,
  topic: string,
  currentSeq: number,
  botUid: string | null,
  signal: AbortSignal,
): Promise<CatsCompanyGroupActivationHistoryEntry[]> {
  if (!Number.isSafeInteger(currentSeq) || currentSeq <= 0 || !botUid) {
    throw new Error('JEV group context requires a current sequence and bot identity');
  }
  const page = await client.getAgentContextHistory(topic, {
    beforeId: currentSeq,
    limit: HISTORY_PAGE_SIZE,
    signal,
  });
  if (page.topic_id !== topic || normalizeUid(page.agent_uid) !== normalizeUid(botUid)
    || !Array.isArray(page.messages)) {
    throw new Error('JEV group context scope mismatch');
  }

  // The server marks messages aimed at another member ineligible. Reuse the
  // existing clear boundary and role filter, but do not persist a cursor here.
  return selectNativeFeishuGroupContextEntries(
    page.messages.filter(message => message.topic_id === topic
      && message.type === 'text'
      && agentContextMessageSeq(message) > 0
      && agentContextMessageSeq(message) < currentSeq),
    0,
    currentSeq,
  )
    .slice(-HISTORY_WINDOW_SIZE)
    .map(entry => ({
      seq: entry.id,
      role: entry.role,
      text: entry.content.replace(/\0/g, '').slice(0, HISTORY_ENTRY_CHARS),
    }));
}

function normalizeUid(value: unknown): string {
  const raw = String(value ?? '').trim();
  const match = raw.match(/^(?:usr)?(\d+)$/i);
  return match ? `usr${match[1]}` : raw;
}
