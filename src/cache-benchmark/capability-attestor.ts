import type { Message } from '../types';
import type { ModelAttemptEvent, ModelAttemptSink } from '../providers/provider';
import type { ModelRequestKind } from '../providers/provider';
import type { ModelRequestOrigin } from '../providers/provider';
import type { ObservationBranchCompletion } from '../core/observation-branch-session';
import { readAuthorizedDeviceContextWitness } from '../core/authorized-device-witness';
import { remoteToolNameForDeviceOperation } from '../core/authorized-device-projection';
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
  private readonly requestKindByAttempt = new Map<string, ModelRequestKind>();
  private readonly requestOriginByAttempt = new Map<string, ModelRequestOrigin>();
  private readonly roleContextValidByAttempt = new Map<string, boolean>();
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
    this.requestKindByAttempt.set(event.attemptId, event.requestKind);
    this.requestOriginByAttempt.set(event.attemptId, event.requestOrigin);
    const contextMemoryBranchId = memoryBranchId(event.context?.sessionId);
    this.roleContextValidByAttempt.set(
      event.attemptId,
      event.requestOrigin === 'memory_branch'
        ? Boolean(contextMemoryBranchId)
        : !contextMemoryBranchId,
    );
    this.capabilitiesByAttempt.set(event.attemptId, attestRequestCapabilities(event));
    const branchId = event.requestOrigin === 'memory_branch'
      ? contextMemoryBranchId
      : undefined;
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
    const origin = this.getRequestOrigin(attemptId);
    if (origin === 'memory_branch') return 'memory_branch';
    if (origin === 'main') return 'main';
    throw new Error('unexpected_subagent_attempt');
  }

  getRequestKind(attemptId: string): ModelRequestKind {
    const kind = this.requestKindByAttempt.get(attemptId);
    if (!kind) throw new Error('attempt_request_kind_missing');
    return kind;
  }

  getRequestOrigin(attemptId: string): ModelRequestOrigin {
    const origin = this.requestOriginByAttempt.get(attemptId);
    if (!origin) throw new Error('attempt_request_origin_missing');
    return origin;
  }

  isRoleContextValid(attemptId: string): boolean {
    return this.roleContextValidByAttempt.get(attemptId) === true;
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
  const runtimeContextMessages = messages.filter(message => (
    message.__context?.source === 'runtime_context'
  ));
  const requestTools = new Map(event.request.tools.map(tool => [tool.name, tool]));
  if (
    runtimeContextMessages.length === 1
    && attestsAuthorizedDeviceContext(
      runtimeContextMessages[0],
      event.timestamp,
      requestTools,
    )
  ) {
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

function attestsAuthorizedDeviceContext(
  message: Message,
  attemptTimestamp: string,
  requestTools: ReadonlyMap<string, ModelAttemptEvent['request']['tools'][number]>,
): boolean {
  const witness = readAuthorizedDeviceContextWitness(message);
  if (
    !witness
    || witness.schema !== 'xiaoba.authorized_device_context_witness.v1'
    || witness.remoteTransportAvailable !== true
    || witness.devices.length === 0
    || typeof message.content !== 'string'
  ) return false;
  const visibleLines = message.content.split('\n').filter(line => line.startsWith('- target="'));
  const targetLines = visibleLines.map(line => (
    line.match(/^- target="(device_target_[a-f0-9]{16}|speaker_default)"：/u)?.[1] || ''
  ));
  const targets = witness.devices.map(device => device.target);
  const grantIds = witness.devices.flatMap(device => device.grantIds);
  const deviceKeys = witness.devices.map(device => `${device.ownerUserId}\0${device.deviceId}`);
  const attemptAt = Date.parse(attemptTimestamp);
  return Number.isFinite(attemptAt)
    && visibleLines.length === witness.devices.length
    && new Set(targetLines).size === targetLines.length
    && new Set(targets).size === targets.length
    && new Set(grantIds).size === grantIds.length
    && new Set(deviceKeys).size === deviceKeys.length
    && targets.every(target => targetLines.includes(target))
    && witness.devices.every(device => visibleLines.includes(device.visibleLine))
    && witness.devices.some(device => device.operations.some(operation => {
      const toolName = remoteToolNameForDeviceOperation(operation);
      const tool = toolName ? requestTools.get(toolName) : undefined;
      if (!tool || !hasStringTargetParameter(tool.parameters)) return false;
      return operation !== 'send_file'
        || Array.isArray(tool.parameters.required) && tool.parameters.required.includes('target');
    }))
    && witness.devices.every(device => (
      Boolean(device.grantIds.length > 0 && device.ownerUserId && device.deviceId)
      && new Set(device.grantIds).size === device.grantIds.length
      && device.operations.length > 0
      && new Set(device.operations).size === device.operations.length
      && device.operations.every(operation => (
        Number.isFinite(device.operationExpiresAt[operation])
        && Number(device.operationExpiresAt[operation]) > attemptAt
      ))
    ));
}

function hasStringTargetParameter(parameters: unknown): boolean {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return false;
  const properties = (parameters as Record<string, unknown>).properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return false;
  const target = (properties as Record<string, unknown>).target;
  return Boolean(
    target
    && typeof target === 'object'
    && !Array.isArray(target)
    && (target as Record<string, unknown>).type === 'string'
  );
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
