import type { Message } from '../types';
import type { ModelAttemptEvent, ModelAttemptSink } from '../providers/provider';
import {
  REQUIRED_CACHE_BENCHMARK_CAPABILITIES,
  type CacheBenchmarkCapability,
} from './types';

export const BENCHMARK_IDENTITY_MARKER = '[cache_benchmark_identity:v1]';
export const BENCHMARK_GOAL_MARKER = '[cache_benchmark_goal:v1]';
export const BENCHMARK_RECOVERY_MARKER = '[cache_benchmark_recovery:v1]';

/**
 * Derives capability coverage from the exact request crossing the provider
 * boundary. Case declarations are deliberately not inputs to this observer.
 */
export class AttemptCapabilityAttestor implements ModelAttemptSink {
  private readonly capabilitiesByAttempt = new Map<string, CacheBenchmarkCapability[]>();

  observe(event: ModelAttemptEvent): void {
    if (event.outcome !== 'started') return;
    this.capabilitiesByAttempt.set(event.attemptId, attestRequestCapabilities(event));
  }

  get(attemptId: string): CacheBenchmarkCapability[] {
    return [...(this.capabilitiesByAttempt.get(attemptId) ?? [])];
  }
}

export function attestRequestCapabilities(event: ModelAttemptEvent): CacheBenchmarkCapability[] {
  const capabilities = new Set<CacheBenchmarkCapability>();
  const messages = event.request.messages;
  const text = messages.map(messageText).join('\n');
  const sources = new Set(messages
    .map(message => message.__context?.source)
    .filter((source): source is NonNullable<typeof source> => Boolean(source)));

  if (text.includes(BENCHMARK_IDENTITY_MARKER)) capabilities.add('identity');
  if (/\[发言人:\s*[^\]]+\]/.test(text)) capabilities.add('group-chat-participants');
  if (sources.has('runtime_context') && /可操作的用户电脑：/.test(text)) {
    capabilities.add('device-authorization');
  }
  if (event.request.tools.length > 0) capabilities.add('tools');
  if (sources.has('skills_list')) capabilities.add('skills');
  if (sources.has('plan_status')) capabilities.add('plan');
  // A durable objective string is useful workload state, but it is not a real
  // Goal runtime. Acceptance requires typed Goal provenance.
  if (sources.has('goal_status')) capabilities.add('goal');
  if (sources.has('subagent_status')) capabilities.add('subagent');
  if (
    event.context?.sessionId?.startsWith('branch:memory:')
    || messages.some(message => (
      message.__syntheticObservation
      && message.__context?.source === 'synthetic_observation'
      && messageText(message).includes('"source":"memory"')
    ))
  ) {
    capabilities.add('memory');
  }
  if (sources.has('runtime_feedback')) capabilities.add('runtime-feedback');
  if (text.includes(BENCHMARK_RECOVERY_MARKER)) capabilities.add('session-recovery');

  return REQUIRED_CACHE_BENCHMARK_CAPABILITIES.filter(capability => capabilities.has(capability));
}

function messageText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map(block => block.type === 'text' ? block.text : '[image]')
    .join('\n');
}
