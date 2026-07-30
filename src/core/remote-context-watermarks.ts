import type { Message } from '../types';

export type RemoteContextWatermarks = Record<string, number>;

/**
 * Collects the highest durable remote message ID already represented by the
 * transcript. Remote history is fetched completely and in sequence, so a
 * compacted high-water mark can stand in for the individual IDs it summarizes.
 */
export function collectRemoteContextWatermarks(
  messages: Message[],
): RemoteContextWatermarks {
  const watermarks: RemoteContextWatermarks = {};

  for (const message of messages) {
    for (const [source, rawId] of Object.entries(message.__remoteContextWatermarks || {})) {
      recordWatermark(watermarks, source, rawId);
    }
    recordWatermark(
      watermarks,
      message.__remoteContextSource,
      message.__remoteContextId,
    );
  }

  return watermarks;
}

function recordWatermark(
  watermarks: RemoteContextWatermarks,
  rawSource: unknown,
  rawId: unknown,
): void {
  const source = typeof rawSource === 'string' ? rawSource.trim() : '';
  const id = Number(rawId);
  if (!source || !Number.isFinite(id) || id <= 0) return;
  watermarks[source] = Math.max(watermarks[source] || 0, id);
}
