import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  CompletedTurn,
  DistillationTurn,
  DistillationUnit,
  MAX_CONTINUITY_TURNS,
  normalizeContinuityLimit,
} from './distillation-unit';
import {
  ParsedSessionLogEntry,
  SessionToolCallLog,
  SessionTurnLogEntry,
  isSessionTurnEntry,
} from './session-log-schema';
import { DistilledKnowledgeCandidate } from './capability-distiller';
import {
  EvidenceBundle,
  ReferencedSkillSnapshot,
  SkillAuthorFixture,
  SkillDraft,
  SkillEvolutionResult,
  SkillEvolutionRuntime,
  SkillEvidenceRef,
  SkillVerifierFixture,
} from './skill-evolution';
import { SkillParser } from '../skills/skill-parser';
import { PathResolver } from './path-resolver';

/** A completed delivery attempt is the unit of learning, not a whole task. */
export const LEARNING_EPISODE_SCHEMA_VERSION = 3 as const;

export const MAX_SEMANTIC_OBSERVATIONS = 12 as const;
export const MAX_SEMANTIC_OBSERVATION_VALUE_LENGTH = 512 as const;
export const MAX_SEMANTIC_OBSERVATION_PAYLOAD_BYTES = 8192 as const;

export type LearningEpisodeStatus =
  | 'settling'
  | 'historical-pending'
  | 'historical-abandoned'
  | 'contradicted'
  | 'eligible';

export interface HistoricalEpisodeTargetRef {
  readonly targetId: string;
  readonly provider: string;
  readonly sourceId: string;
  readonly resourceRef: string;
  readonly position: number;
  readonly prefixDigest: string;
}

export type CompletionEvidenceKind =
  | 'artifact-delivery'
  | 'artifact-validation'
  | 'verified-tool-result'
  | 'assistant-response'
  | 'user-acceptance';

export interface EpisodeEvidenceRef {
  ref: string;
  sourceFilePath: string;
  turn: number;
  kind: CompletionEvidenceKind | 'contradiction';
  detail?: string;
}

export type SemanticObservationKind =
  | 'user-intent'
  | 'workflow-tool'
  | 'artifact-operation'
  | 'verification'
  | 'correction-or-contradiction'
  | 'referenced-skill';

/** A bounded fact supplied to Author/Verifier; it is not a final capability label. */
export interface SemanticObservation {
  kind: SemanticObservationKind;
  value: string;
  sourceRefs: string[];
}

export interface ContradictionSignal {
  signalId: string;
  kind: 'direct-correction' | 'failure-report';
  message: string;
  source: EpisodeEvidenceRef;
  precedingDeliveryTurn: number;
  precedingSourceFilePath: string;
  runtimeSessionId: string;
  preventsPromotion: true;
}

export interface LearningEpisode {
  schemaVersion: typeof LEARNING_EPISODE_SCHEMA_VERSION;
  episodeId: string;
  /** AgentTurnController's canonical episode correlation; absent in legacy logs. */
  agentTurnEpisodeId?: string;
  runtimeSessionId: string;
  sourceFilePath: string;
  deliveryTurn: number;
  completionEvidence: EpisodeEvidenceRef[];
  contradictionSignals: ContradictionSignal[];
  /** Durable bounded observations extracted at evidence admission. */
  semanticObservations: SemanticObservation[];
  predecessorEpisodeId?: string;
  /** A retry is related to its predecessor, but never shares its settlement. */
  retryOfEpisodeId?: string;
  settlementDeadline: string;
  status: LearningEpisodeStatus;
  /** Fixed source target that must complete before ordinary review. */
  historicalTarget?: HistoricalEpisodeTargetRef;
  /** Source byte range from the DistillationUnit that admitted this episode. */
  unitByteRange?: { start: number; end: number };
  /** Source generatedAt timestamp from the DistillationUnit that admitted this episode. */
  unitGeneratedAt?: string;
}

export interface LearningEpisodeExtractionResult {
  episodes: LearningEpisode[];
  contradictions: ContradictionSignal[];
}

/**
 * Build the V3 candidate admitted by a settled Learning Episode.
 *
 * This is intentionally independent from the V1 explicit-acceptance
 * distiller. Completion evidence is the source of the candidate's action
 * pattern; settlement only establishes that the episode survived its
 * contradiction window. The Author/Verifier branches remain responsible for
 * deciding whether that pattern deserves a reusable Current Skill.
 */
export function buildLearningEpisodeCandidate(
  episode: LearningEpisode,
  sourceUnit?: Pick<DistillationUnit, 'byteRange' | 'generatedAt'>,
): DistilledKnowledgeCandidate {
  const completionEvidence = episode.completionEvidence.filter(item => item.kind !== 'contradiction');
  const toolNames = uniqueStrings(completionEvidence.map(item => item.detail?.split(':', 1)[0] || item.kind));
  const evidenceSummary = completionEvidence
    .map(item => item.detail || item.kind)
    .join('; ')
    .slice(0, 280);
  const actionPattern = toolNames.length > 0
    ? `Use the settled artifact workflow with ${toolNames.join(', ')}: ${evidenceSummary}`
    : `Reuse the settled artifact workflow: ${evidenceSummary}`;
  const sourceByteRange = sourceUnit?.byteRange ?? episode.unitByteRange ?? { start: 0, end: 0 };
  const generatedAt = sourceUnit?.generatedAt ?? episode.unitGeneratedAt ?? episode.settlementDeadline;

  return {
    schemaVersion: 1,
    kind: 'capability',
    capabilityId: `episode-capability-${episode.episodeId.slice('episode-'.length)}`,
    title: 'Capability: Settled artifact delivery workflow',
    applicability: 'Applies when a similar task requires an artifact to be delivered and verified.',
    actionPattern,
    boundaries: [
      'Only apply when the new task matches the settled artifact workflow.',
      'Do not reuse a workflow while the user is correcting or iterating on the delivery.',
    ],
    risks: [
      'This candidate is derived from one settled Learning Episode and may not generalize.',
      'The Author and Verifier must keep the resulting skill bounded by the supplied evidence.',
    ],
    solvedLoop: {
      problem: 'Complete the artifact delivery recorded by the Learning Episode.',
      action: actionPattern,
      verification: `The episode settled at ${episode.settlementDeadline} without contradiction.`,
      noCorrection: 'No contradiction signal was present when the settlement deadline elapsed.',
    },
    provenance: completionEvidence.map((item, index) => ({
      filePath: item.sourceFilePath,
      turn: item.turn,
      role: index === 0 ? 'problem-action' as const : 'verification' as const,
      unitByteRange: sourceByteRange,
    })),
    generatedAt,
    sourceUnit: {
      filePath: episode.sourceFilePath,
      byteRange: sourceByteRange,
      generatedAt,
    },
  };
}

// Match delivery verbs at the tool-name boundary. A bare `file` substring is
// too broad: inspection tools such as `read_file` must not create episodes.
const DELIVERY_TOOL = /^(?:send|deliver|write|create|generate|export|upload|publish|attach|artifact)(?:_|$)/i;
const VALIDATION_TOOL = /(?:validat|check|inspect|verify|assert|test)/i;
const ARTIFACT_WORKFLOW_TOOL = /(?:select|compose|card|image)/i;
const SUCCESS_RESULT = /(?:success|succeed|ok|passed|valid|created|delivered|sent|uploaded|generated)/i;
const FAILURE_RESULT = /(?:fail|error|invalid|unable|cannot|denied|timeout)/i;
const POSITIVE_ACCEPTANCE = /(?:^|\W)(?:thanks?|works?|worked|great|perfect|excellent|correct|verified|confirmed|done|yes|yep|that(?:'|’)s right|that did it)(?:$|\W)/i;
const CONTRADICTION = /(?:^|\W)(?:redo|try again|unsuitable|not suitable|wrong|incorrect|not what|doesn['’]t work|didn['’]t work|still failing|still broken|failed|failure|error|no,|nope|instead)(?:$|\W)/i;
const CONTINUATION = /(?:^|\W)(?:continue|resume|redo|try again|接着做|继续|重做)(?:$|\W)/i;

/**
 * Extract independent delivery attempts from one Distillation Unit.
 *
 * The extraction intentionally accepts high-recall evidence. Settlement is
 * the later, durable decision point; a direct correction is attached to the
 * preceding episode and makes that episode ineligible for promotion.
 */
export function extractLearningEpisodes(
  unit: DistillationUnit,
  settlementWindowMs = 3 * 60 * 60 * 1000,
): LearningEpisodeExtractionResult {
  const turns = [...unit.continuityTurns, ...unit.newTurns];
  const newTurnNumbers = new Set(unit.newTurns.map(turn => turn.turn));
  const episodes: LearningEpisode[] = [];
  const contradictions: ContradictionSignal[] = [];

  for (let index = 0; index < turns.length; index++) {
    const deliveryTurn = turns[index];
    if (!newTurnNumbers.has(deliveryTurn.turn)) continue;
    const deliverySourceFilePath = turnSourceFilePath(deliveryTurn, unit.filePath);
    const evidence = uniqueEvidence([
      ...detectCompletionEvidence(deliverySourceFilePath, deliveryTurn),
      ...collectPrecedingWorkflowEvidence(turns, index, unit.filePath),
    ]);
    const episodeId = makeEpisodeId(deliverySourceFilePath, deliveryTurn);
    const next = turns[index + 1];
    const signal = next ? detectContradiction(deliverySourceFilePath, deliveryTurn, next, unit.filePath) : undefined;
    const accepted = next ? detectAcceptance(turnSourceFilePath(next, unit.filePath), deliveryTurn, next) : undefined;
    const hadInitialDeliveryEvidence = hasDeliveryEvidence(evidence);
    if (signal) {
      // Validation-only activity is not a delivery and must not create a
      // contradiction signal by itself.
      if (!hadInitialDeliveryEvidence) continue;
      evidence.push(signal.source);
      contradictions.push(signal);
    } else if (accepted) {
      // Legacy session logs often contain a completed assistant response but
      // no tool-call records. A following explicit acceptance is still a
      // bounded solved-loop signal; keep the response text as evidence and
      // let the Author/Verifier decide whether it deserves a Capability.
      if (!hasDeliveryEvidence(evidence)) {
        const assistantResponse = detectAssistantResponseEvidence(deliverySourceFilePath, deliveryTurn);
        if (assistantResponse) evidence.push(assistantResponse);
      }
      evidence.push(accepted);
    }
    if (!hasDeliveryEvidence(evidence)) continue;

    const predecessor = [...episodes].reverse().find(candidate =>
      candidate.runtimeSessionId === runtimeSessionIdOf(deliveryTurn)
      && candidate.deliveryTurn < deliveryTurn.turn,
    );
    const semanticObservations = extractSemanticObservations(turns, index, evidence, signal, unit.filePath);
    const episode: LearningEpisode = {
      schemaVersion: LEARNING_EPISODE_SCHEMA_VERSION,
      episodeId,
      ...(agentTurnEpisodeIdOf(deliveryTurn) && { agentTurnEpisodeId: agentTurnEpisodeIdOf(deliveryTurn) }),
      runtimeSessionId: runtimeSessionIdOf(deliveryTurn),
      sourceFilePath: deliverySourceFilePath,
      deliveryTurn: deliveryTurn.turn,
      completionEvidence: evidence,
      contradictionSignals: signal ? [signal] : [],
      semanticObservations,
      ...(predecessor && { predecessorEpisodeId: predecessor.episodeId }),
      settlementDeadline: new Date(Date.parse(deliveryTurn.timestamp) + settlementWindowMs).toISOString(),
      status: signal ? 'contradicted' : 'settling',
      unitByteRange: unit.byteRange,
      unitGeneratedAt: unit.generatedAt,
    };
    // A retry points back to the contradicted delivery, never to itself.
    if (predecessor?.status === 'contradicted') {
      episode.retryOfEpisodeId = predecessor.episodeId;
    }
    episodes.push(episode);
  }

  // A correction can arrive in a new unit immediately after a delivery that
  // was continuity context. Return the signal so the durable store can update
  // that already-known episode without re-creating it.
  for (let index = 0; index < turns.length - 1; index++) {
    const delivery = turns[index];
    const correction = turns[index + 1];
    if (!newTurnNumbers.has(correction.turn) || newTurnNumbers.has(delivery.turn)) continue;
    const deliverySourceFilePath = turnSourceFilePath(delivery, unit.filePath);
    const deliveryEvidence = detectCompletionEvidence(deliverySourceFilePath, delivery);
    const signal = detectContradiction(deliverySourceFilePath, delivery, correction, unit.filePath);
    if (signal) {
      if (!hasDeliveryEvidence(deliveryEvidence)) continue;
      contradictions.push(signal);
      continue;
    }
    const accepted = detectAcceptance(turnSourceFilePath(correction, unit.filePath), delivery, correction);
    if (accepted) {
      if (!hasDeliveryEvidence(deliveryEvidence)) {
        const assistantResponse = detectAssistantResponseEvidence(deliverySourceFilePath, delivery);
        if (!assistantResponse) continue;
        deliveryEvidence.push(assistantResponse);
      }
      episodes.push({
        schemaVersion: LEARNING_EPISODE_SCHEMA_VERSION,
        episodeId: makeEpisodeId(deliverySourceFilePath, delivery),
        ...(agentTurnEpisodeIdOf(delivery) && { agentTurnEpisodeId: agentTurnEpisodeIdOf(delivery) }),
        runtimeSessionId: runtimeSessionIdOf(delivery),
        sourceFilePath: deliverySourceFilePath,
        deliveryTurn: delivery.turn,
        completionEvidence: uniqueEvidence([
          ...deliveryEvidence,
          ...collectPrecedingWorkflowEvidence(turns, index, unit.filePath),
          accepted,
        ]),
        contradictionSignals: [],
        semanticObservations: extractSemanticObservations(turns, index, [
          ...deliveryEvidence,
          ...collectPrecedingWorkflowEvidence(turns, index, unit.filePath),
          accepted,
        ], undefined, unit.filePath),
        settlementDeadline: new Date(Date.parse(delivery.timestamp) + settlementWindowMs).toISOString(),
        status: 'settling',
        unitByteRange: unit.byteRange,
        unitGeneratedAt: unit.generatedAt,
      });
    }
  }

  return { episodes, contradictions };
}

/**
 * Extract only bounded, factual observations from the fixed unit window.
 * The output is persisted with the episode and is never re-derived during
 * settlement or review.
 */
function extractSemanticObservations(
  turns: readonly CompletedTurn[],
  deliveryIndex: number,
  evidence: readonly EpisodeEvidenceRef[],
  contradiction?: ContradictionSignal,
  fallbackSourceFilePath = '',
): SemanticObservation[] {
  const delivery = turns[deliveryIndex];
  if (!delivery) return [];
  const observations: SemanticObservation[] = [];
  const intentTurns: CompletedTurn[] = [delivery];
  for (let index = deliveryIndex - 1; index >= 0; index--) {
    const preceding = turns[index];
    if (!preceding) continue;
    if (hasDeliveryEvidence(detectCompletionEvidence(turnSourceFilePath(preceding, fallbackSourceFilePath), preceding))) break;
    if (preceding.user.text.trim()) intentTurns.unshift(preceding);
    if (intentTurns.length >= 3) break;
  }
  const intentText = intentTurns
    .map(turn => turn.user.text.trim())
    .filter(Boolean)
    .join(' ');
  if (intentText) {
    observations.push({
      kind: 'user-intent',
      value: intentText,
      sourceRefs: uniqueStrings(intentTurns.map(turn => evidenceRef(
        turnSourceFilePath(turn, fallbackSourceFilePath),
        turn.turn,
        'user-intent',
      ))),
    });
  }

  const workflowEvidence = evidence.filter(item => item.kind === 'verified-tool-result');
  for (const item of workflowEvidence) {
    observations.push({
      kind: 'workflow-tool',
      value: item.detail || 'verified workflow tool result',
      sourceRefs: [item.ref],
    });
  }
  for (const item of evidence.filter(item => item.kind === 'artifact-delivery')) {
    observations.push({
      kind: 'artifact-operation',
      value: item.detail?.split(':', 1)[0] || 'artifact delivery',
      sourceRefs: [item.ref],
    });
  }
  for (const item of evidence.filter(item => item.kind === 'artifact-validation' || item.kind === 'user-acceptance')) {
    observations.push({
      kind: 'verification',
      value: item.detail || item.kind,
      sourceRefs: [item.ref],
    });
  }
  if (contradiction) {
    observations.push({
      kind: 'correction-or-contradiction',
      value: contradiction.message,
      sourceRefs: [contradiction.source.ref],
    });
  }
  return boundSemanticObservations(observations);
}

function boundSemanticObservations(observations: readonly SemanticObservation[]): SemanticObservation[] {
  const bounded: SemanticObservation[] = [];
  const seen = new Set<string>();
  for (const observation of observations) {
    const value = observation.value.trim().slice(0, MAX_SEMANTIC_OBSERVATION_VALUE_LENGTH);
    const sourceRefs = uniqueStrings(observation.sourceRefs).slice(0, MAX_SEMANTIC_OBSERVATIONS);
    if (!value || sourceRefs.length === 0) continue;
    const normalized = { kind: observation.kind, value, sourceRefs };
    const key = JSON.stringify(normalized);
    if (seen.has(key)) continue;
    const candidate = [...bounded, normalized];
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MAX_SEMANTIC_OBSERVATION_PAYLOAD_BYTES) break;
    bounded.push(normalized);
    seen.add(key);
    if (bounded.length >= MAX_SEMANTIC_OBSERVATIONS) break;
  }
  return bounded;
}

function detectCompletionEvidence(filePath: string, turn: CompletedTurn): EpisodeEvidenceRef[] {
  const evidence: EpisodeEvidenceRef[] = [];
  const hasArtifactCompletion = turn.assistant.tool_calls.some(tool =>
    (isDeliveryTool(tool) || VALIDATION_TOOL.test(tool.name))
    && !FAILURE_RESULT.test(tool.result || ''),
  );
  const workflowEvidence = hasArtifactCompletion ? detectWorkflowEvidence(filePath, turn) : [];
  for (const tool of turn.assistant.tool_calls) {
    const detail = toolDetail(tool);
    if (VALIDATION_TOOL.test(tool.name) && SUCCESS_RESULT.test(tool.result || '')) {
      evidence.push({
        ref: evidenceRef(filePath, turn.turn, `validation:${tool.name}`),
        sourceFilePath: filePath,
        turn: turn.turn,
        kind: 'artifact-validation',
        detail,
      });
    } else if (isDeliveryTool(tool) && !FAILURE_RESULT.test(tool.result || '')) {
      evidence.push({
        ref: evidenceRef(filePath, turn.turn, `delivery:${tool.name}`),
        sourceFilePath: filePath,
        turn: turn.turn,
        kind: 'artifact-delivery',
        detail,
      });
    }
  }
  return uniqueEvidence([...evidence, ...workflowEvidence]);
}

function detectWorkflowEvidence(filePath: string, turn: CompletedTurn): EpisodeEvidenceRef[] {
  return turn.assistant.tool_calls
    .filter(tool => isArtifactWorkflowTool(tool) && !FAILURE_RESULT.test(tool.result || ''))
    .map(tool => ({
      ref: evidenceRef(filePath, turn.turn, `workflow:${tool.name}`),
      sourceFilePath: filePath,
      turn: turn.turn,
      kind: 'verified-tool-result' as const,
      detail: toolDetail(tool),
    }));
}

function collectPrecedingWorkflowEvidence(
  turns: readonly CompletedTurn[],
  deliveryIndex: number,
  unitFilePath: string,
): EpisodeEvidenceRef[] {
  const evidence: EpisodeEvidenceRef[] = [];
  for (let index = deliveryIndex - 1; index >= 0; index--) {
    const preceding = turns[index];
    const sourceFilePath = turnSourceFilePath(preceding, unitFilePath);
    if (hasDeliveryEvidence(detectCompletionEvidence(sourceFilePath, preceding))) break;
    evidence.unshift(...detectWorkflowEvidence(sourceFilePath, preceding));
  }
  return uniqueEvidence(evidence);
}

function isArtifactWorkflowTool(tool: SessionToolCallLog): boolean {
  return ARTIFACT_WORKFLOW_TOOL.test(tool.name) || isOpenCliWorkflowCommand(tool);
}

function isOpenCliWorkflowCommand(tool: SessionToolCallLog): boolean {
  if (!/^execute_shell$/i.test(tool.name)) return false;
  const argumentsText = typeof tool.arguments === 'string'
    ? tool.arguments
    : JSON.stringify(tool.arguments ?? '');
  return /\bopencli\b[\s\S]*\b(?:google\s+images?|images?)\b/i.test(argumentsText);
}

function toolDetail(tool: SessionToolCallLog): string {
  const argumentsText = typeof tool.arguments === 'string'
    ? tool.arguments.trim()
    : JSON.stringify(tool.arguments ?? '');
  const suffix = argumentsText && argumentsText !== '{}'
    ? ` ${argumentsText}`
    : '';
  return `${tool.name}${suffix}: ${String(tool.result || '')}`.trim();
}

function isDeliveryTool(tool: SessionToolCallLog): boolean {
  return DELIVERY_TOOL.test(tool.name);
}

function hasDeliveryEvidence(evidence: readonly EpisodeEvidenceRef[]): boolean {
  return evidence.some(item =>
    item.kind === 'artifact-delivery'
    || item.kind === 'verified-tool-result'
    || item.kind === 'assistant-response',
  );
}

function detectAssistantResponseEvidence(
  filePath: string,
  turn: CompletedTurn,
): EpisodeEvidenceRef | undefined {
  const text = turn.assistant.text.trim();
  if (!text) return undefined;
  return {
    ref: evidenceRef(filePath, turn.turn, 'assistant-response'),
    sourceFilePath: filePath,
    turn: turn.turn,
    kind: 'assistant-response',
    detail: text.slice(0, 1000),
  };
}

function detectContradiction(
  deliverySourceFilePath: string,
  delivery: CompletedTurn,
  next: CompletedTurn,
  fallbackCorrectionFilePath: string,
): ContradictionSignal | undefined {
  const message = next.user.text.trim();
  if (!message || !CONTRADICTION.test(message)) return undefined;
  const correctionSourceFilePath = turnSourceFilePath(next, fallbackCorrectionFilePath);
  const source: EpisodeEvidenceRef = {
    ref: evidenceRef(correctionSourceFilePath, next.turn, 'contradiction'),
    sourceFilePath: correctionSourceFilePath,
    turn: next.turn,
    kind: 'contradiction',
    detail: message,
  };
  return {
    signalId: makeSignalId(deliverySourceFilePath, correctionSourceFilePath, delivery.turn, next.turn),
    kind: /(?:fail|error|doesn|didn|broken)/i.test(message) ? 'failure-report' : 'direct-correction',
    message,
    source,
    precedingDeliveryTurn: delivery.turn,
    precedingSourceFilePath: deliverySourceFilePath,
    runtimeSessionId: runtimeSessionIdOf(delivery),
    preventsPromotion: true,
  };
}

function detectAcceptance(
  filePath: string,
  delivery: CompletedTurn,
  next: CompletedTurn,
): EpisodeEvidenceRef | undefined {
  const message = next.user.text.trim();
  if (!message || !POSITIVE_ACCEPTANCE.test(message) || CONTRADICTION.test(message)) return undefined;
  return {
    ref: evidenceRef(filePath, next.turn, 'acceptance'),
    sourceFilePath: filePath,
    turn: next.turn,
    kind: 'user-acceptance',
    detail: message,
  };
}

function runtimeSessionIdOf(turn: CompletedTurn): string {
  const candidate = turn as SessionTurnLogEntry & { runtime_session_id?: string; runtime_id?: string };
  return String(candidate.runtime_session_id || candidate.runtime_id || candidate.session_id).trim();
}

/** Read the durable AgentTurnController correlation without guessing for legacy entries. */
export function agentTurnEpisodeIdOf(turn: CompletedTurn): string | undefined {
  const candidate = turn as SessionTurnLogEntry;
  return typeof candidate.episode_id === 'string' && candidate.episode_id.trim()
    ? candidate.episode_id.trim()
    : undefined;
}

function turnSourceFilePath(turn: CompletedTurn, fallback: string): string {
  const origin = (turn as DistillationTurn).origin?.filePath;
  return typeof origin === 'string' && origin.trim() ? origin : fallback;
}

function evidenceRef(filePath: string, turn: number, kind: string): string {
  return `${filePath}#turn-${turn}:${kind}`;
}

function makeEpisodeId(filePath: string, turn: CompletedTurn): string {
  const persistedEpisodeId = persistedEpisodeIdOf(turn);
  if (persistedEpisodeId) return persistedEpisodeId;
  return `episode-${hash(`${filePath}|${runtimeSessionIdOf(turn)}|turn-${turn.turn}`).slice(0, 20)}`;
}

function persistedEpisodeIdOf(turn: CompletedTurn): string | undefined {
  const candidate = turn as SessionTurnLogEntry & { episode_id?: unknown };
  const episodeId = typeof candidate.episode_id === 'string' ? candidate.episode_id.trim() : '';
  return episodeId || undefined;
}

function makeSignalId(
  deliveryFilePath: string,
  correctionFilePath: string,
  deliveryTurn: number,
  correctionTurn: number,
): string {
  return `contradiction-${hash(`${deliveryFilePath}|${correctionFilePath}|${deliveryTurn}|${correctionTurn}`).slice(0, 20)}`;
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function uniqueEvidence(evidence: EpisodeEvidenceRef[]): EpisodeEvidenceRef[] {
  return [...new Map(evidence.map(item => [item.ref, item])).values()];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

export interface SettleLearningEpisodesOptions {
  now?: Date;
  promote?: (episode: LearningEpisode) => LearningEpisodeStatus;
}

/** Settle each episode independently; contradiction always wins. */
export function settleLearningEpisodes(
  episodes: readonly LearningEpisode[],
  options: SettleLearningEpisodesOptions = {},
): LearningEpisode[] {
  const now = (options.now ?? new Date()).getTime();
  return episodes.map(episode => {
    if (
      episode.status === 'historical-pending'
      || episode.status === 'historical-abandoned'
    ) {
      return cloneEpisode(episode);
    }
    if (episode.status === 'contradicted' || episode.contradictionSignals.length > 0) {
      return { ...cloneEpisode(episode), status: 'contradicted' };
    }
    if (episode.status !== 'settling') return cloneEpisode(episode);
    if (Date.parse(episode.settlementDeadline) > now) return cloneEpisode(episode);
    const status = options.promote?.(episode) ?? 'eligible';
    return { ...cloneEpisode(episode), status };
  });
}

function cloneEpisode(episode: LearningEpisode): LearningEpisode {
  return JSON.parse(JSON.stringify(episode)) as LearningEpisode;
}

export interface LearningEpisodeStoreState {
  schemaVersion: typeof LEARNING_EPISODE_SCHEMA_VERSION;
  episodes: Record<string, LearningEpisode>;
  /** Set when the last durable state was quarantined; all writes fail closed. */
  stateCorrupt?: boolean;
}

export interface LearningEpisodeStoreOptions {
  /**
   * Injectable atomic writer used by both `load()` migration and `save()`.
   * Defaults to a temp-file + rename atomic write. Tests inject a deterministic
   * writer to simulate migration I/O failure without leaving partial state.
   */
  atomicWrite?: (filePath: string, state: LearningEpisodeStoreState) => void;
  /**
   * Injectable quarantine used when the store file is corrupted, malformed,
   * or has an unknown schema version. Defaults to renaming the file to a
   * sidecar `.quarantine.*` path so the original evidence is preserved for
   * diagnosis and recovery. Tests inject a failing quarantine to verify
   * fail-closed behavior.
   */
  quarantine?: (filePath: string) => void;
}

export class LearningEpisodeStore {
  private readonly corruptionMarkerPath: string;

  constructor(
    private readonly filePath: string,
    private readonly options: LearningEpisodeStoreOptions = {},
  ) {
    this.corruptionMarkerPath = `${filePath}.state-corrupt`;
  }

  load(): LearningEpisodeStoreState {
    if (fs.existsSync(this.corruptionMarkerPath)) {
      return { ...emptyEpisodeStoreState(), stateCorrupt: true };
    }
    if (!fs.existsSync(this.filePath)) return emptyEpisodeStoreState();

    // Read and parse in two stages. A read failure (permission, I/O) fails
    // closed so the caller cannot overwrite a possibly-valid store. A parse
    // or validation failure (corrupted JSON, invalid structure, unknown schema
    // version) quarantines the file before returning an empty state so a
    // subsequent save() cannot silently overwrite recoverable evidence.
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return emptyEpisodeStoreState();
      throw new Error(
        `Learning Episode store read failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    let parsed: LearningEpisodeStoreState & { schemaVersion?: number };
    try {
      parsed = JSON.parse(raw) as unknown as typeof parsed;
      if (!parsed.episodes || typeof parsed.episodes !== 'object') throw new Error('invalid episode store');
      const persistedVersion: number | undefined = parsed.schemaVersion;
      if (persistedVersion !== undefined && persistedVersion !== 1 && persistedVersion !== 2 && persistedVersion !== 3) {
        throw new Error('invalid episode store');
      }
    } catch (error) {
      // Corrupted JSON, invalid structure, or unknown schema version:
      // quarantine the file so a later save() cannot overwrite recoverable
      // evidence, then return an empty state. If quarantine itself fails,
      // fail closed to protect the data.
      this.quarantineFile(error);
      return { ...emptyEpisodeStoreState(), stateCorrupt: true };
    }

    const persistedVersion: number | undefined = parsed.schemaVersion;
    const persistingV1 = persistedVersion === undefined || persistedVersion === 1;
    if (persistedVersion === 3) {
      for (const episode of Object.values(parsed.episodes)) {
        if (!Array.isArray(episode.semanticObservations)) episode.semanticObservations = [];
        episode.schemaVersion = LEARNING_EPISODE_SCHEMA_VERSION;
      }
      return parsed as LearningEpisodeStoreState;
    }

    if (!persistingV1 && persistedVersion !== 2) {
      return parsed as LearningEpisodeStoreState;
    }

    // v1/v2 → v3 migration: the store-level schemaVersion AND each nested
    // episode schemaVersion must be upgraded together. Legacy status labels
    // 'promoted' → 'eligible' and 'rejected' → 'contradicted' are migrated in
    // the same pass. Evidence, settlement deadline, and predecessor/retry
    // linkage are preserved untouched. Missing observations remain an empty
    // array so legacy input is explicit incomplete semantic input, not a
    // fabricated observation set.
    for (const episode of Object.values(parsed.episodes)) {
      const rawStatus = episode.status as string;
      if (rawStatus === 'promoted') {
        episode.status = 'eligible' as const;
      } else if (rawStatus === 'rejected') {
        episode.status = 'contradicted' as const;
      }
      episode.schemaVersion = LEARNING_EPISODE_SCHEMA_VERSION;
      if (!Array.isArray(episode.semanticObservations)) episode.semanticObservations = [];
    }
    parsed.schemaVersion = LEARNING_EPISODE_SCHEMA_VERSION;

    // Durable migration write. A structurally valid legacy store whose atomic
    // migration write fails must NOT return an empty state that a later caller
    // could overwrite — report a durable migration I/O failure instead so the
    // source evidence is retained for diagnosis and retry.
    try {
      this.atomicWrite(parsed as LearningEpisodeStoreState);
    } catch (cause) {
      throw new Error(
        `Learning Episode store migration write failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    return parsed as LearningEpisodeStoreState;
  }

  save(state: LearningEpisodeStoreState): void {
    if (fs.existsSync(this.corruptionMarkerPath) || state.stateCorrupt) {
      throw new Error('Learning Episode store is state-corrupt; explicit recovery is required before writing.');
    }
    this.atomicWrite(state);
  }

  /** Explicit operator recovery after the quarantined state has been inspected/restored. */
  recover(state: LearningEpisodeStoreState): void {
    this.atomicWrite({ ...state, stateCorrupt: undefined });
    try {
      fs.unlinkSync(this.corruptionMarkerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  /**
   * Move a corrupted/unknown-schema store file aside so the original evidence
   * is preserved for diagnosis and recovery. If the quarantine rename fails,
   * fail closed with the original parse error so the caller cannot overwrite
   * the un-quarantined file.
   */
  private quarantineFile(error: unknown): void {
    const quarantineFn = this.options.quarantine ?? defaultLearningEpisodeQuarantine;
    try {
      // Publish the durable fail-closed latch before moving the evidence. If
      // the process crashes or the quarantine rename fails, the next process
      // still refuses fresh writes instead of treating a missing canonical
      // store as an empty store.
      fs.writeFileSync(this.corruptionMarkerPath, `${new Date().toISOString()}\n`, { encoding: 'utf8', mode: 0o600 });
      quarantineFn(this.filePath);
    } catch {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private atomicWrite(state: LearningEpisodeStoreState): void {
    const writer = this.options.atomicWrite ?? defaultLearningEpisodeAtomicWrite;
    writer(this.filePath, state);
  }

  upsert(episodes: readonly LearningEpisode[]): LearningEpisodeStoreState {
    const state = this.load();
    for (const episode of episodes) {
      const existing = state.episodes[episode.episodeId];
      const linked = episode.retryOfEpisodeId || episode.predecessorEpisodeId
        ? episode
        : linkRetryToStoredPredecessor(episode, state);
      state.episodes[episode.episodeId] = mergeEpisode(existing, linked);
    }
    this.save(state);
    return state;
  }

  /** Upsert new episodes and apply correction signals discovered at a later cursor. */
  applyExtraction(
    result: LearningEpisodeExtractionResult,
    options: { historicalTarget?: HistoricalEpisodeTargetRef } = {},
  ): LearningEpisodeStoreState {
    const episodes = options.historicalTarget
      ? result.episodes.map(episode => ({
        ...episode,
        status: 'historical-pending' as const,
        historicalTarget: options.historicalTarget,
      }))
      : result.episodes;
    const state = this.upsert(episodes);
    for (const signal of result.contradictions) {
      const predecessor = Object.values(state.episodes).find(episode =>
        episode.sourceFilePath === signal.precedingSourceFilePath
        && episode.runtimeSessionId === signal.runtimeSessionId
        && episode.deliveryTurn === signal.precedingDeliveryTurn,
      );
      if (!predecessor) continue;
      predecessor.contradictionSignals = [...new Map(
        [...predecessor.contradictionSignals, signal].map(item => [item.signalId, item]),
      ).values()];
      // Historical evidence may link a contradiction before its immutable
      // target is complete. Keep the episode behind that target's review gate;
      // reconciliation applies the already-durable signal idempotently.
      if (
        predecessor.status !== 'historical-pending'
        && predecessor.status !== 'historical-abandoned'
      ) {
        predecessor.status = 'contradicted';
      }
      predecessor.completionEvidence = uniqueEvidence([...predecessor.completionEvidence, signal.source]);
    }
    this.save(state);
    return state;
  }

  /**
   * Idempotently release episodes linked to one completed immutable target.
   * Existing contradictions win; no additional wall-clock settlement starts.
   */
  reconcileHistoricalTarget(targetId: string): LearningEpisodeStoreState {
    const state = this.load();
    let changed = false;
    for (const episode of Object.values(state.episodes)) {
      if (
        episode.status !== 'historical-pending'
        || episode.historicalTarget?.targetId !== targetId
      ) continue;
      episode.status = episode.contradictionSignals.length > 0
        ? 'contradicted'
        : 'eligible';
      changed = true;
    }
    if (changed) this.save(state);
    return state;
  }

  /** Permanently hold episodes whose fixed historical target was abandoned. */
  abandonHistoricalTarget(targetId: string): LearningEpisodeStoreState {
    const state = this.load();
    let changed = false;
    for (const episode of Object.values(state.episodes)) {
      if (
        episode.status !== 'historical-pending'
        || episode.historicalTarget?.targetId !== targetId
      ) continue;
      episode.status = 'historical-abandoned';
      changed = true;
    }
    if (changed) this.save(state);
    return state;
  }

  /** Relink only abandoned/pending historical evidence to a deliberate reopened range. */
  reopenHistoricalTarget(
    originalTargetId: string,
    reopenedTarget: HistoricalEpisodeTargetRef,
  ): LearningEpisodeStoreState {
    const state = this.load();
    let changed = false;
    for (const episode of Object.values(state.episodes)) {
      if (
        (episode.status !== 'historical-abandoned' && episode.status !== 'historical-pending')
        || episode.historicalTarget?.targetId !== originalTargetId
      ) continue;
      episode.status = 'historical-pending';
      episode.historicalTarget = reopenedTarget;
      changed = true;
    }
    if (changed) this.save(state);
    return state;
  }

  settle(options: SettleLearningEpisodesOptions = {}): LearningEpisodeStoreState {
    const state = this.load();
    const settled = settleLearningEpisodes(Object.values(state.episodes), options);
    state.episodes = Object.fromEntries(settled.map(episode => [episode.episodeId, episode]));
    this.save(state);
    return state;
  }
}

function emptyEpisodeStoreState(): LearningEpisodeStoreState {
  return { schemaVersion: LEARNING_EPISODE_SCHEMA_VERSION, episodes: {} };
}

function defaultLearningEpisodeAtomicWrite(filePath: string, state: LearningEpisodeStoreState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, filePath);
}

function defaultLearningEpisodeQuarantine(filePath: string): void {
  const quarantinePath = `${filePath}.quarantine.${Date.now()}.${process.pid}`;
  fs.renameSync(filePath, quarantinePath);
}

function mergeEpisode(existing: LearningEpisode | undefined, incoming: LearningEpisode): LearningEpisode {
  if (!existing) return cloneEpisode(incoming);
  const signals = [...existing.contradictionSignals, ...incoming.contradictionSignals];
  const merged: LearningEpisode = {
    ...existing,
    ...(existing.agentTurnEpisodeId || !incoming.agentTurnEpisodeId
      ? {}
      : { agentTurnEpisodeId: incoming.agentTurnEpisodeId }),
    completionEvidence: uniqueEvidence([...existing.completionEvidence, ...incoming.completionEvidence]),
    contradictionSignals: [...new Map(signals.map(signal => [signal.signalId, signal])).values()],
    semanticObservations: mergeSemanticObservations(existing.semanticObservations, incoming.semanticObservations),
  };
  if (
    merged.contradictionSignals.length > 0
    && merged.status !== 'historical-pending'
    && merged.status !== 'historical-abandoned'
  ) {
    merged.status = 'contradicted';
  }
  return merged;
}

function mergeSemanticObservations(
  existing: readonly SemanticObservation[] | undefined,
  incoming: readonly SemanticObservation[] | undefined,
): SemanticObservation[] {
  return boundSemanticObservations([
    ...(existing ?? []),
    ...(incoming ?? []),
  ]);
}

function linkRetryToStoredPredecessor(
  episode: LearningEpisode,
  state: LearningEpisodeStoreState,
): LearningEpisode {
  const predecessor = Object.values(state.episodes)
    .filter(candidate =>
      candidate.runtimeSessionId === episode.runtimeSessionId
      && candidate.deliveryTurn < episode.deliveryTurn,
    )
    .filter(candidate => candidate.status === 'contradicted')
    .sort((a, b) => b.deliveryTurn - a.deliveryTurn)[0];
  if (!predecessor) return episode;
  return {
    ...episode,
    predecessorEpisodeId: predecessor.episodeId,
    retryOfEpisodeId: predecessor.episodeId,
  };
}

export interface ContinuityFile {
  filePath: string;
  entries: ParsedSessionLogEntry[];
}

export interface ContinuityReadOptions {
  files: readonly ContinuityFile[];
  currentFilePath: string;
  runtimeSessionId: string;
  maxTurns?: number;
}

/**
 * Read continuity from exactly one predecessor file.
 *
 * The ordered file list is part of the contract: a file that is not the
 * immediate predecessor cannot be read, even if its session id matches.
 */
export function readImmediatePredecessorContinuity(options: ContinuityReadOptions): DistillationTurn[] {
  const currentIndex = options.files.findIndex(file => file.filePath === options.currentFilePath);
  if (currentIndex <= 0) return [];
  const current = options.files[currentIndex];
  const currentTurns = current.entries.filter(isSessionTurnEntry);
  if (currentTurns.length === 0 || !hasContinuationSignal(currentTurns[0].user.text)) return [];
  if (currentTurns.some(turn => runtimeSessionIdOf(turn) !== options.runtimeSessionId)) return [];

  const predecessor = options.files[currentIndex - 1];
  const predecessorTurns = predecessor.entries.filter(isSessionTurnEntry);
  if (predecessorTurns.length === 0) return [];
  if (predecessorTurns.some(turn => runtimeSessionIdOf(turn) !== options.runtimeSessionId)) return [];
  const maxTurns = Math.min(MAX_CONTINUITY_TURNS, normalizeContinuityLimit(options.maxTurns));
  return maxTurns === 0
    ? []
    : predecessorTurns.slice(-maxTurns).map(turn => ({
      ...turn,
      origin: { filePath: predecessor.filePath },
    }));
}

/** Read only the current file and its immediate predecessor when eligible. */
export function readImmediatePredecessorContinuityFromDisk(
  orderedFilePaths: readonly string[],
  currentFilePath: string,
  runtimeSessionId: string,
  maxTurns = MAX_CONTINUITY_TURNS,
): DistillationTurn[] {
  const currentIndex = orderedFilePaths.indexOf(currentFilePath);
  if (currentIndex <= 0) return [];
  const currentEntries = readSessionEntries(currentFilePath);
  const currentTurns = currentEntries.filter(isSessionTurnEntry);
  if (currentTurns.length === 0 || !hasContinuationSignal(currentTurns[0].user.text)) return [];
  const predecessorPath = orderedFilePaths[currentIndex - 1];
  const predecessorEntries = readSessionEntries(predecessorPath);
  return readImmediatePredecessorContinuity({
    files: [
      { filePath: predecessorPath, entries: predecessorEntries },
      { filePath: currentFilePath, entries: currentEntries },
    ],
    currentFilePath,
    runtimeSessionId,
    maxTurns,
  });
}

function readSessionEntries(filePath: string): ParsedSessionLogEntry[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as ParsedSessionLogEntry);
}

function hasContinuationSignal(text: string): boolean {
  return CONTINUATION.test(String(text || '').replace(/\s+/g, ' ').trim());
}

export interface FlashcardCompositionOptions {
  episode: LearningEpisode;
  sourceFilePath: string;
  outputDir: string;
  registryPath: string;
  auditPath: string;
  journalPath: string;
  workingDirectory: string;
  wordCardMakerVersion?: string;
  wordCardMakerPath?: string;
  logEnabled?: boolean;
  authorFixture?: SkillAuthorFixture;
  verifierFixture?: SkillVerifierFixture;
}

export interface FlashcardCompositionResult {
  evolution: SkillEvolutionResult;
  referencedSkill: ReferencedSkillSnapshot;
  manualSkillHashBefore?: string;
  manualSkillHashAfter?: string;
}

/**
 * Controlled V3 regression adapter for the flashcard workflow.
 *
 * The generated skill adds the opencli selection/validation/delivery pattern
 * and records word-card-maker as a live reference. It writes only the
 * generated output/registry/audit paths supplied by the caller.
 */
export async function promoteFlashcardComposition(
  options: FlashcardCompositionOptions,
): Promise<FlashcardCompositionResult> {
  if (options.episode.status !== 'eligible') {
    throw new Error('A flashcard Composition Capability requires a settled, eligible retry episode.');
  }
  if (options.episode.contradictionSignals.length > 0 || !options.episode.retryOfEpisodeId) {
    throw new Error('A flashcard Composition Capability requires an uncontested retry episode.');
  }
  if (options.episode.sourceFilePath !== options.sourceFilePath) {
    throw new Error('Flashcard composition source file must match the episode provenance.');
  }
  const deliveryEvidence = options.episode.completionEvidence.filter(evidence => evidence.kind === 'artifact-delivery');
  const validationEvidence = options.episode.completionEvidence.filter(evidence => evidence.kind === 'artifact-validation');
  if (deliveryEvidence.length === 0 || validationEvidence.length === 0) {
    throw new Error('A flashcard Composition Capability requires validated delivery evidence.');
  }
  const referencedSkill = makeReferencedSkill(options);
  const manualSkillHashBefore = options.wordCardMakerPath ? hashFile(options.wordCardMakerPath) : undefined;
  const bundle = buildFlashcardEvidenceBundle(options.episode, options.sourceFilePath, referencedSkill);
  const runtime = new SkillEvolutionRuntime({
    workingDirectory: options.workingDirectory,
    outputDir: options.outputDir,
    registryPath: options.registryPath,
    auditPath: options.auditPath,
    journalPath: options.journalPath,
    logEnabled: options.logEnabled,
    authorFixture: options.authorFixture ?? flashcardAuthor,
    verifierFixture: options.verifierFixture ?? flashcardVerifier,
  });
  const evolution = await runtime.reviewAndApply(bundle);
  const manualSkillHashAfter = options.wordCardMakerPath ? hashFile(options.wordCardMakerPath) : undefined;
  if (manualSkillHashBefore !== manualSkillHashAfter) {
    throw new Error('word-card-maker changed during Composition Capability promotion.');
  }
  return { evolution, referencedSkill, manualSkillHashBefore, manualSkillHashAfter };
}

export function buildFlashcardEvidenceBundle(
  episode: LearningEpisode,
  sourceFilePath: string,
  referencedSkill: ReferencedSkillSnapshot,
): EvidenceBundle {
  const settlementEvidence = episode.completionEvidence.filter(evidence => evidence.kind === 'user-acceptance');
  const deliveryEvidence = episode.completionEvidence.filter(evidence => evidence.kind === 'artifact-delivery');
  const validationEvidence = episode.completionEvidence.filter(evidence => evidence.kind === 'artifact-validation');
  if (deliveryEvidence.length === 0 || validationEvidence.length === 0 || settlementEvidence.length === 0) {
    throw new Error('Flashcard evidence bundle requires validation, delivery, and acceptance evidence.');
  }
  const settlementSource = settlementEvidence.map(toSkillEvidenceRef);
  const settlementRefs = new Set(settlementSource.map(evidence => evidence.ref));
  const completionEvidence = episode.completionEvidence
    .filter(evidence => !settlementRefs.has(evidence.ref))
    .map(toSkillEvidenceRef);
  return {
    bundleId: `flashcard-${episode.episodeId}`,
    episode: {
      ...episode,
      workflow: 'flashcard correction and verified retry',
    },
    completionEvidence,
    settlementEvidence,
    boundedContinuity: [],
    referencedSkills: [referencedSkill],
    relatedCurrentSkills: [],
  };
}

function toSkillEvidenceRef(evidence: EpisodeEvidenceRef): SkillEvidenceRef {
  return {
    ref: evidence.ref,
    sourceFilePath: evidence.sourceFilePath,
    turn: evidence.turn,
  };
}

function makeReferencedSkill(options: FlashcardCompositionOptions): ReferencedSkillSnapshot {
  return {
    name: 'word-card-maker',
    ...(options.wordCardMakerVersion && { version: options.wordCardMakerVersion }),
    ...(options.wordCardMakerPath && { contentFingerprint: hashFile(options.wordCardMakerPath) }),
  };
}

const flashcardAuthor: SkillAuthorFixture = ({ bundle }): SkillDraft => ({
  body: [
    'Use the referenced `word-card-maker` skill for the base word-card structure.',
    'For image cards, use `opencli` to select a suitable image, validate the selected artifact and its dimensions/content, then deliver the validated card.',
    'Keep selection, validation, and delivery explicit; if validation fails, report the failure and retry instead of delivering an unsuitable artifact.',
  ].join('\n\n'),
  envelope: {
    decision: 'create_current_skill',
    routingName: 'flashcard-image-delivery',
    description: 'Create validated flashcards by composing word-card-maker with opencli image selection and delivery.',
    referencedSkills: ['word-card-maker'],
    evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
    rationale: 'Controlled flashcard correction and verified retry workflow.',
  },
});

const flashcardVerifier: SkillVerifierFixture = ({ bundle, draft }): ReturnType<SkillVerifierFixture> => ({
  decision: draft.body.includes('word-card-maker')
    && draft.body.includes('opencli')
    && draft.envelope.referencedSkills?.includes('word-card-maker')
    && bundle.referencedSkills.some(skill => skill.name === 'word-card-maker')
    ? 'accept'
    : 'reject',
  transition: 'create_current_skill',
  issues: [],
  rationale: 'The draft is semantic, references the manual word-card-maker skill, and contains the opencli selection/validation/delivery workflow.',
});

function hashFile(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** Existing discovery uses recursive SKILL.md files; expose a small testable view. */
export function listDiscoverableGeneratedSkills(skillsRoot = PathResolver.getSkillsPath()): Array<{ name: string; description: string; filePath: string }> {
  return PathResolver.findSkillFiles(skillsRoot).flatMap(filePath => {
    try {
      const skill = SkillParser.parse(filePath);
      return [{ name: skill.metadata.name, description: skill.metadata.description, filePath: skill.filePath }];
    } catch {
      return [];
    }
  });
}
