import { createHash } from 'crypto';
import type {
  ContextCacheScope,
  ContextLifecycleAnnotation,
  ContextSource,
  Message,
} from '../types';

export interface ContextLifecycleSummary {
  annotatedMessages: number;
  transientMessages: number;
  lifecycleCounts: {
    session: number;
    episode: number;
    call: number;
  };
  cacheScopeCounts: {
    stable: number;
    epoch: number;
    volatile: number;
  };
  epochFingerprint?: string;
  requestFingerprint?: string;
}

export interface ContextAnnotationInput {
  source: ContextSource;
  lifecycle: ContextLifecycleAnnotation['lifecycle'];
  cacheScope: ContextCacheScope;
  persistence?: ContextLifecycleAnnotation['persistence'];
  epoch?: string;
}

export function annotateContextMessage<T extends Message>(
  message: T,
  input: ContextAnnotationInput,
): T {
  return {
    ...message,
    __context: {
      schema: 'xiaoba.context_lifecycle.v1',
      source: input.source,
      lifecycle: input.lifecycle,
      cacheScope: input.cacheScope,
      persistence: input.persistence ?? 'transient',
      ...(input.epoch ? { epoch: input.epoch } : {}),
    },
    ...(input.cacheScope === 'stable'
      ? { __cacheScope: 'stable' as const }
      : { __cacheScope: 'dynamic' as const }),
  };
}

export function isTransientContextMessage(message: Message): boolean {
  return message.__context?.persistence === 'transient';
}

export function resolveContextCacheScope(message: Message): ContextCacheScope | undefined {
  if (message.__context?.cacheScope) return message.__context.cacheScope;
  if (message.__cacheScope === 'stable') return 'stable';
  if (message.__cacheScope === 'dynamic') return 'volatile';
  return undefined;
}

export function summarizeContextLifecycle(messages: readonly Message[]): ContextLifecycleSummary | undefined {
  const annotated = messages.filter(message => message.__context);
  if (annotated.length === 0) return undefined;

  const summary: ContextLifecycleSummary = {
    annotatedMessages: annotated.length,
    transientMessages: annotated.filter(message => message.__context?.persistence === 'transient').length,
    lifecycleCounts: { session: 0, episode: 0, call: 0 },
    cacheScopeCounts: { stable: 0, epoch: 0, volatile: 0 },
  };
  for (const message of annotated) {
    const annotation = message.__context!;
    summary.lifecycleCounts[annotation.lifecycle] += 1;
    summary.cacheScopeCounts[annotation.cacheScope] += 1;
  }

  const epochEntries = annotated
    .filter(message => message.__context?.lifecycle !== 'call')
    .map(contextIdentity);
  const requestEntries = annotated.map(contextIdentity);
  if (epochEntries.length > 0) summary.epochFingerprint = fingerprint(epochEntries);
  if (requestEntries.length > 0) summary.requestFingerprint = fingerprint(requestEntries);
  return summary;
}

function contextIdentity(message: Message): Record<string, unknown> {
  const annotation = message.__context!;
  return {
    source: annotation.source,
    lifecycle: annotation.lifecycle,
    cacheScope: annotation.cacheScope,
    persistence: annotation.persistence,
    epoch: annotation.epoch || '',
    content: sha256(contentText(message)).slice(0, 16),
  };
}

function contentText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map(block => block.type === 'text' ? block.text : `[image:${block.source.media_type}]`)
    .join('\n');
}

function fingerprint(value: unknown): string {
  return sha256(JSON.stringify(value)).slice(0, 16);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
