import type { Message } from '../types';
import type { ModelAttemptEvent, ModelAttemptSink } from '../providers/provider';
import type { ObservationBranchCompletion } from '../core/observation-branch-session';
import {
  REQUIRED_CACHE_BENCHMARK_CAPABILITIES,
  type CacheBenchmarkAttemptRole,
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
  private readonly branchByAttempt = new Map<string, string>();
  private readonly outcomesByAttempt = new Map<string, ModelAttemptEvent['outcome']>();
  private readonly attemptsByBranch = new Map<string, Set<string>>();
  private readonly observationsByAttempt = new Map<string, Array<{
    branchId: string;
    observationId: string;
  }>>();
  private readonly completionsByBranch = new Map<string, ObservationBranchCompletion>();

  observe(event: ModelAttemptEvent): void {
    this.outcomesByAttempt.set(event.attemptId, event.outcome);
    if (event.outcome !== 'started') return;
    this.capabilitiesByAttempt.set(event.attemptId, attestRequestCapabilities(event));
    const branchId = memoryBranchId(event.context?.sessionId);
    if (branchId) {
      this.branchByAttempt.set(event.attemptId, branchId);
      const attempts = this.attemptsByBranch.get(branchId) ?? new Set<string>();
      attempts.add(event.attemptId);
      this.attemptsByBranch.set(branchId, attempts);
    }
    const observations = memoryObservationLinks(event.request.messages);
    if (observations.length > 0) {
      this.observationsByAttempt.set(event.attemptId, observations);
    }
  }

  registerMemoryCompletion(completion: ObservationBranchCompletion): void {
    if (completion.branchType !== 'memory') return;
    this.completionsByBranch.set(completion.branchId, structuredClone(completion));
  }

  getRole(attemptId: string): CacheBenchmarkAttemptRole {
    return this.branchByAttempt.has(attemptId) ? 'memory_branch' : 'main';
  }

  get(attemptId: string): CacheBenchmarkCapability[] {
    const capabilities = new Set(this.capabilitiesByAttempt.get(attemptId) ?? []);
    const branchId = this.branchByAttempt.get(attemptId);
    if (branchId && this.isValidPublishedBranch(branchId)) {
      capabilities.add('memory');
    }
    const observations = this.observationsByAttempt.get(attemptId) ?? [];
    if (observations.some(observation => {
      const completion = this.completionsByBranch.get(observation.branchId);
      return completion?.status === 'published'
        && completion.observationId === observation.observationId
        && this.isValidPublishedBranch(observation.branchId);
    })) {
      capabilities.add('memory');
    }
    return REQUIRED_CACHE_BENCHMARK_CAPABILITIES.filter(capability => capabilities.has(capability));
  }

  private isValidPublishedBranch(branchId: string): boolean {
    const completion = this.completionsByBranch.get(branchId);
    const attempts = this.attemptsByBranch.get(branchId);
    if (completion?.status !== 'published' || !completion.observationId || !attempts?.size) return false;
    const refs = completion.observationRefs ?? [];
    const digests = completion.observationRefDigests ?? {};
    if (
      refs.length === 0
      || Object.keys(digests).length !== refs.length
      || refs.some(ref => !/^sha256:[a-f0-9]{64}$/.test(digests[ref] || ''))
    ) return false;
    return [...attempts].every(attemptId => this.outcomesByAttempt.get(attemptId) === 'succeeded');
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
  const durableBenchmarkMessages = messages.filter(
    message => message.__remoteContextSource === 'cache-benchmark'
      && Number.isSafeInteger(message.__remoteContextId)
      && Number(message.__remoteContextId) > 0,
  );
  const durableRecordIds = durableBenchmarkMessages.map(
    message => Number(message.__remoteContextId),
  );
  const hasDuplicateDurableRecordId = new Set(durableRecordIds).size !== durableRecordIds.length;
  const participantsByRecordId = new Map<number, {
    speakerId: string;
    kind: 'human' | 'other_agent';
  }>();
  for (const message of durableBenchmarkMessages) {
    const match = messageText(message).match(
      /^\[(发言人|其他 Agent): [^;\]\n]+; id=([^\]\n]+)\](?:\n|$)/u,
    );
    if (!match) continue;
    participantsByRecordId.set(Number(message.__remoteContextId), {
      speakerId: match[2],
      kind: match[1] === '其他 Agent' ? 'other_agent' : 'human',
    });
  }
  const participantIds = new Set(
    [...participantsByRecordId.values()].map(participant => participant.speakerId),
  );
  const participantKinds = [...participantsByRecordId.values()].map(participant => participant.kind);
  if (
    !hasDuplicateDurableRecordId
    && participantsByRecordId.size >= 2
    && participantIds.size >= 2
    && participantKinds.includes('human')
    && participantKinds.includes('other_agent')
  ) {
    capabilities.add('group-chat-participants');
  }
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
  if (sources.has('runtime_feedback')) capabilities.add('runtime-feedback');
  if (!hasDuplicateDurableRecordId && durableBenchmarkMessages.some(
    message => messageText(message).includes(BENCHMARK_RECOVERY_MARKER),
  )) capabilities.add('session-recovery');

  return REQUIRED_CACHE_BENCHMARK_CAPABILITIES.filter(capability => capabilities.has(capability));
}

function memoryBranchId(sessionId: string | undefined): string | undefined {
  const prefix = 'branch:memory:';
  if (!sessionId?.startsWith(prefix)) return undefined;
  const branchId = sessionId.slice(prefix.length).trim();
  return branchId || undefined;
}

function memoryObservationLinks(messages: readonly Message[]): Array<{
  branchId: string;
  observationId: string;
}> {
  const seen = new Set<string>();
  const links: Array<{ branchId: string; observationId: string }> = [];
  for (const message of messages) {
    if (
      !message.__syntheticObservation
      || message.__context?.source !== 'synthetic_observation'
      || message.syntheticObservationProvenance?.branchType !== 'memory'
      || !message.syntheticObservationId
    ) continue;
    const branchId = message.syntheticObservationProvenance.branchId.trim();
    const observationId = message.syntheticObservationId.trim();
    if (!branchId || !observationId) continue;
    const key = `${branchId}\0${observationId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ branchId, observationId });
  }
  return links;
}

function messageText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map(block => block.type === 'text' ? block.text : '[image]')
    .join('\n');
}
