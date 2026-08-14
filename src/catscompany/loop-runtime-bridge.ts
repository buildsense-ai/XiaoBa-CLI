import {
  LoopEvidenceSender,
  type LoopActionPacket,
  validateLoopActionPacket,
} from './loop-evidence';

export interface LoopRuntimeBridgeOptions {
  evidenceSender: LoopEvidenceSender;
  botUid: string;
  controllerUid: string;
  prepareSession: (workerSessionId: string) => Promise<void> | void;
  execute: (packet: LoopActionPacket) => Promise<void>;
}

export interface LoopActionHandlingResult {
  handled: boolean;
  kind?: LoopActionPacket['kind'];
}

function parseLoopActionPacket(text: string): LoopActionPacket | null {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>;
    return value.schema === 'loopctl-action-packet-v1' ? value as unknown as LoopActionPacket : null;
  } catch {
    return null;
  }
}

/**
 * Adapts Controller Actions into a single Worker runtime session. It owns no
 * Controller state: invalid packets fail locally, and only attested evidence
 * can advance an Attempt.
 */
function normalizeCatsUid(value: unknown): string {
  const raw = String(value ?? '').trim();
  const numeric = raw.match(/^(?:usr)?(\d+)$/i);
  return numeric ? `usr${numeric[1]}` : raw;
}

export class LoopRuntimeBridge {
  private static readonly MAX_TRACKED_ACTIONS = 512;
  private readonly handledActions = new Map<string, Promise<void>>();
  private readonly latestAttemptState = new Map<string, { generation: number; revision: number }>();

  constructor(private readonly options: LoopRuntimeBridgeOptions) {}

  async handle(text: string, receivedTopicId: string, senderUid: string): Promise<LoopActionHandlingResult> {
    const packet = parseLoopActionPacket(text);
    if (!packet) return { handled: false };
    if (normalizeCatsUid(senderUid) !== normalizeCatsUid(this.options.controllerUid)) {
      throw new Error('Loop Action packet sender does not match configured Controller UID');
    }
    const previous = this.latestAttemptState.get(packet.attemptId);
    if (previous && (packet.generation < previous.generation ||
      (packet.generation === previous.generation && packet.workItemRevision < previous.revision))) {
      throw new Error('Loop Action packet generation or revision is older than an already observed packet');
    }

    const eventType = packet.kind === 'preflight_attempt' ? 'worker_ready' : 'runtime_started';
    validateLoopActionPacket(packet, receivedTopicId, this.options.botUid, eventType);
    if (!previous || packet.generation > previous.generation || packet.workItemRevision > previous.revision) {
      this.latestAttemptState.set(packet.attemptId, { generation: packet.generation, revision: packet.workItemRevision });
    }
    const actionKey = [packet.actionKey, packet.attemptId, packet.generation, packet.workItemRevision, packet.workerSessionId, receivedTopicId].join(':');
    let operation = this.handledActions.get(actionKey);
    if (!operation) {
      operation = this.run(packet, receivedTopicId, eventType);
      if (this.handledActions.size >= LoopRuntimeBridge.MAX_TRACKED_ACTIONS) {
        const oldest = this.handledActions.keys().next().value;
        if (oldest) this.handledActions.delete(oldest);
      }
      this.handledActions.set(actionKey, operation);
      operation.catch(() => this.handledActions.delete(actionKey));
    }
    await operation;
    return { handled: true, kind: packet.kind };
  }

  private async run(
    packet: LoopActionPacket,
    receivedTopicId: string,
    eventType: 'worker_ready' | 'runtime_started',
  ): Promise<void> {
    await this.options.prepareSession(packet.workerSessionId);
    if (eventType === 'worker_ready') {
      await this.options.evidenceSender.workerReady(packet, receivedTopicId);
      return;
    }
    await this.options.evidenceSender.runtimeStarted(packet, receivedTopicId);
    await this.options.execute(packet);
  }
}
