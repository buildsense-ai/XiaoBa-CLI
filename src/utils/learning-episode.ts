import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  CompletedTurn,
  DistillationTurn,
  DistillationUnit,
  ExternalEventProvenance,
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
  SkillEvidenceRef,
} from './skill-evolution';

/**
 * A completed delivery attempt is the unit of learning, not a whole chat
 * session. Verification and acceptance that do not deliver a new artifact
 * fold into the open delivery attempt in the same runtime session.
 */
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
  /**
   * External source event provenance; present only when the admitting
   * DistillationUnit carried external identity (xURL). Absent for local
   * episodes and older persisted records.
   */
  externalEventProvenance?: ExternalEventProvenance;
}

export interface LearningEpisodeExtractionResult {
  episodes: LearningEpisode[];
  contradictions: ContradictionSignal[];
}

/**
 * Build the V3 candidate admitted by a settled Learning Episode.
 *
 * This is intentionally independent from the V1 explicit-acceptance
 * distiller. Completion evidence and durable semantic observations supply
 * bounded factual hints; settlement only establishes that the episode
 * survived its contradiction window. The Author/Verifier branches remain
 * responsible for naming and deciding whether that pattern deserves a
 * reusable Current Skill. Candidate text must not push lifecycle/generic
 * routing names such as "settled" or "artifact-delivery".
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
  const task = deriveCandidateTaskSummary(episode, toolNames, evidenceSummary);
  const sourceByteRange = sourceUnit?.byteRange ?? episode.unitByteRange ?? { start: 0, end: 0 };
  const generatedAt = sourceUnit?.generatedAt ?? episode.unitGeneratedAt ?? episode.settlementDeadline;
  const external = episode.externalEventProvenance;
  const externalFields = external
    ? {
        provider: external.provider,
        threadId: external.threadId,
        contentHash: external.contentHash,
        startOrdinal: external.startOrdinal,
        endOrdinal: external.endOrdinal,
      }
    : {};

  return {
    schemaVersion: 1,
    kind: 'capability',
    capabilityId: `episode-capability-${episode.episodeId.slice('episode-'.length)}`,
    title: task.title,
    applicability: task.applicability,
    actionPattern: task.actionPattern,
    boundaries: [
      'Only apply when a new task matches the same user-facing capability evidenced here.',
      'Do not reuse the pattern while the user is correcting or iterating on the delivery.',
    ],
    risks: [
      'This candidate is derived from one completed delivery attempt and may not generalize.',
      'The Author and Verifier must keep the resulting skill bounded by the supplied evidence.',
      'Do not copy lifecycle words such as settled/episode/candidate into the public routing name.',
    ],
    solvedLoop: {
      problem: task.problem,
      action: task.actionPattern,
      verification: task.verification,
      noCorrection: 'No contradiction signal was present when the settlement deadline elapsed.',
    },
    provenance: completionEvidence.map((item, index) => ({
      filePath: item.sourceFilePath,
      turn: item.turn,
      role: index === 0 ? 'problem-action' as const : 'verification' as const,
      unitByteRange: sourceByteRange,
      ...externalFields,
    })),
    generatedAt,
    sourceUnit: {
      filePath: episode.sourceFilePath,
      byteRange: sourceByteRange,
      generatedAt,
    },
  };
}

/**
 * Derive a concrete, lifecycle-neutral candidate summary from durable
 * semantic observations. This is only a hint for Author/Verifier; Runtime
 * never assigns the final routing name here.
 */
function deriveCandidateTaskSummary(
  episode: LearningEpisode,
  toolNames: readonly string[],
  evidenceSummary: string,
): {
  title: string;
  applicability: string;
  actionPattern: string;
  problem: string;
  verification: string;
} {
  const observations = episode.semanticObservations ?? [];
  const userIntent = firstObservationValue(observations, 'user-intent');
  const artifactOperation = firstObservationValue(observations, 'artifact-operation');
  const workflowTool = firstObservationValue(observations, 'workflow-tool');
  const verificationObservation = firstObservationValue(observations, 'verification');
  const intentSnippet = compactTaskSnippet(userIntent);
  const means = uniqueStrings([
    ...toolNames,
    ...(artifactOperation ? [artifactOperation.split(/\s+/, 1)[0]!] : []),
    ...(workflowTool ? [workflowTool] : []),
  ]).slice(0, 4);

  const title = intentSnippet
    ? `Capability: ${intentSnippet}`
    : means.length > 0
      ? `Capability: Deliver task artifact with ${means.join(', ')}`
      : 'Capability: Deliver verified task artifact';

  const applicability = intentSnippet
    ? `Applies when a similar task needs: ${intentSnippet}`
    : 'Applies when a similar task needs a verified artifact delivery.';

  const actionPattern = means.length > 0
    ? `Complete the user task${intentSnippet ? ` (${intentSnippet})` : ''} using ${means.join(', ')}: ${evidenceSummary}`
    : `Complete the user task${intentSnippet ? ` (${intentSnippet})` : ''}: ${evidenceSummary}`;

  const problem = intentSnippet
    || (means.length > 0 ? `Deliver the requested artifact with ${means.join(', ')}.` : 'Deliver the requested artifact.');

  const verification = verificationObservation
    ? `User or validation signal: ${compactTaskSnippet(verificationObservation, 120)}. Episode settled at ${episode.settlementDeadline} without contradiction.`
    : `The episode settled at ${episode.settlementDeadline} without contradiction.`;

  return {
    title: sanitizeCandidateNarrative(title),
    applicability: sanitizeCandidateNarrative(applicability),
    actionPattern: sanitizeCandidateNarrative(actionPattern),
    problem: sanitizeCandidateNarrative(problem),
    verification: sanitizeCandidateNarrative(verification),
  };
}

function firstObservationValue(
  observations: readonly SemanticObservation[],
  kind: SemanticObservation['kind'],
): string | undefined {
  const value = observations.find(item => item.kind === kind)?.value?.trim();
  return value || undefined;
}

function compactTaskSnippet(value: string | undefined, maxChars = 96): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .replace(/\s+/g, ' ')
    .replace(/^Capability:\s*/i, '')
    .trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxChars) return normalized;
  const slice = normalized.slice(0, maxChars);
  const boundary = Math.max(slice.lastIndexOf('，'), slice.lastIndexOf('。'), slice.lastIndexOf(','), slice.lastIndexOf(';'), slice.lastIndexOf(' '));
  const compact = (boundary >= Math.floor(maxChars * 0.6) ? slice.slice(0, boundary) : slice).trim();
  return compact || slice.trim();
}

/** Strip lifecycle/process words that push Author toward banned routing names. */
function sanitizeCandidateNarrative(value: string): string {
  return value
    .replace(/\bsettled artifact workflow\b/gi, 'verified task delivery')
    .replace(/\bsettled artifact\b/gi, 'verified artifact')
    .replace(/\bsettled\b/gi, 'completed')
    .replace(/\bsettling\b/gi, 'pending')
    .replace(/\bLearning Episode\b/gi, 'completed delivery attempt')
    .replace(/\bepisode\b/gi, 'delivery attempt')
    .replace(/\bcandidate\b/gi, 'proposal')
    .replace(/\s+/g, ' ')
    .trim();
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
const NON_PRODUCTION_TOKEN = /(?:^|[:/_.-])(?:smoke|synthetic|replay)(?:$|[:/_.-])/i;

/**
 * Extract delivery attempts from one Distillation Unit.
 *
 * Corrections and true redeliveries stay independent. Verification or
 * acceptance that does not deliver a new artifact folds into the open
 * predecessor delivery in the same runtime session, so create→check→accept
 * remains one learning unit rather than two competing capabilities.
 *
 * Settlement is still the later durable decision point; a direct correction
 * attaches to the preceding episode and makes that episode ineligible for
 * promotion.
 */
export function extractLearningEpisodes(
  unit: DistillationUnit,
  settlementWindowMs = 3 * 60 * 60 * 1000,
): LearningEpisodeExtractionResult {
  if (isNonProductionLearningUnit(unit)) {
    return { episodes: [], contradictions: [] };
  }
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
    const accepted = next ? detectAcceptance(turnSourceFilePath(next, unit.filePath), next) : undefined;
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
    } else if (!hasDeliveryEvidence(evidence) && isExternalCompleteFinalDelivery(deliveryTurn)) {
      // External Session Log Sources (xURL/Pi) materialize a complete
      // User→final-Assistant event with empty tool_calls. Treat the final
      // assistant text as candidate episode evidence only for external
      // session metadata. Internal chat still requires tool delivery or a
      // following acceptance; settlement/prefilter/Author/Verifier gates
      // remain unchanged and external evidence never gets promotion authority.
      const assistantResponse = detectAssistantResponseEvidence(deliverySourceFilePath, deliveryTurn);
      if (assistantResponse) evidence.push(assistantResponse);
    }
    if (!hasDeliveryEvidence(evidence)) continue;

    const predecessor = [...episodes].reverse().find(candidate =>
      candidate.runtimeSessionId === runtimeSessionIdOf(deliveryTurn)
      && candidate.deliveryTurn < deliveryTurn.turn,
    );
    const semanticObservations = extractSemanticObservations(turns, index, evidence, signal, unit.filePath);

    // create → verify/report → accept is one human task. If this turn did not
    // deliver a new artifact and the open predecessor still can settle, fold
    // verification/acceptance evidence into that predecessor instead of
    // minting a competing episode that steals the acceptance signal.
    if (
      predecessor
      && predecessor.status !== 'contradicted'
      && shouldFoldIntoOpenDelivery(evidence, predecessor)
    ) {
      predecessor.completionEvidence = uniqueEvidence([
        ...predecessor.completionEvidence,
        ...evidence,
      ]);
      predecessor.semanticObservations = boundSemanticObservations([
        ...predecessor.semanticObservations,
        ...semanticObservations,
      ]);
      if (signal) {
        predecessor.contradictionSignals = uniqueContradictionSignals([
          ...predecessor.contradictionSignals,
          signal,
        ]);
        predecessor.status = 'contradicted';
      }
      continue;
    }

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
      ...(unit.externalEventProvenance && { externalEventProvenance: unit.externalEventProvenance }),
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
    const accepted = detectAcceptance(turnSourceFilePath(correction, unit.filePath), correction);
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
        ...(unit.externalEventProvenance && { externalEventProvenance: unit.externalEventProvenance }),
      });
    }
  }

  return { episodes, contradictions };
}

function isNonProductionLearningUnit(unit: DistillationUnit): boolean {
  return NON_PRODUCTION_TOKEN.test(path.basename(unit.filePath))
    || unit.newTurns.some(turn => (
    NON_PRODUCTION_TOKEN.test(String(turn.session_id || ''))
    || /^(?:smoke|test|synthetic|replay)$/i.test(String(turn.session_type || '').trim())
    ));
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

function hasArtifactDeliveryEvidence(evidence: readonly EpisodeEvidenceRef[]): boolean {
  return evidence.some(item => item.kind === 'artifact-delivery');
}

/**
 * Fold verification/acceptance into the open delivery when this turn did not
 * create or redeliver an artifact. A new artifact-delivery always starts its
 * own attempt (retry, second product, or corrected delivery).
 */
function shouldFoldIntoOpenDelivery(
  evidence: readonly EpisodeEvidenceRef[],
  predecessor: LearningEpisode,
): boolean {
  if (hasArtifactDeliveryEvidence(evidence)) return false;
  if (!hasArtifactDeliveryEvidence(predecessor.completionEvidence)) return false;
  return evidence.some(item =>
    item.kind === 'assistant-response'
    || item.kind === 'artifact-validation'
    || item.kind === 'user-acceptance'
    || item.kind === 'contradiction'
    || item.kind === 'verified-tool-result',
  );
}

function uniqueContradictionSignals(
  signals: readonly ContradictionSignal[],
): ContradictionSignal[] {
  return [...new Map(signals.map(signal => [signal.signalId, signal])).values()];
}

/**
 * External Session Log turns are tagged `session_type: 'external'` by the
 * source adapter (not by URI guessing). A complete external final is a turn
 * with non-empty assistant text; tool_calls may be empty for Pi/xURL finals.
 */
function isExternalCompleteFinalDelivery(turn: CompletedTurn): boolean {
  if (String(turn.session_type ?? '').trim().toLowerCase() !== 'external') return false;
  const assistantText = turn.assistant.text.trim();
  if (!assistantText) return false;

  // External timelines (notably Pi/xURL) may coalesce many progress updates
  // into one assistant turn.  Non-empty text only proves that the agent spoke;
  // it does not prove that the requested work reached a reusable outcome.
  // Require an outcome near the tail, where Pi writes its final hand-off, and
  // reject context-free continuation prompts that cannot name a capability.
  const userText = turn.user.text.replace(/\s+/g, ' ').trim();
  if (isContextFreeContinuation(userText)) return false;

  const tail = utf8Tail(assistantText, 2_000);
  // Order-sensitive terminal-outcome polarity: the LAST decisive outcome
  // determines whether the external tail is a successful final or a retry.
  // A corrected success (earlier failure → later success) admits; a final
  // blocker after an implementation (earlier positive → later negative)
  // rejects. Never manufacture success from an earlier positive word when
  // the terminal outcome is negative.
  return lastPositiveOutcomeAfterLastNegative(tail);
}

const EXTERNAL_TERMINAL_OUTCOME = /(?:\b(?:completed?|done|fixed|implemented|updated|created|removed|restored|verified|validated|delivered|committed|shipped)\b|\btests?\b[^\n]{0,80}\bpass(?:ed|ing)?\b|\ball\s+\d+[^\n]{0,40}\bpass(?:ed|ing)?\b|\bcommit\s+[0-9a-f]{7,40}\b|(?:已|已经)(?:完成|修复|修改|更新|删除|恢复|创建|实现|验证|提交|交付)|(?:改好|删掉|恢复完成|测试通过|验证通过))/iu;

/**
 * Explicit non-success / negative-review or terminal-blocker markers.
 * Kept narrow so genuine success (e.g. "nothing failed", "all checks passed")
 * is never vetoed: bare words like "failed" or "fix" are NOT matched — only
 * explicit negative outcomes, directive-to-fix, or terminal blocking issues.
 */
const EXTERNAL_NON_SUCCESS_TAIL = /\bnot\s+(?:ok(?:ay)?|verified|validated|done|completed|fixed|implemented|delivered|shipped|ready|correct|valid|pass(?:ed|ing)?)\b|\b(?:did|do|does|don'?t|doesn'?t|didn'?t|won'?t|cannot|can'?t|failed\s+to|did\s+not)\s+(?:not\s+)?(?:pass|verify|validated?|complete|deliver|ship)\b|\b(?:tests?|checks?)\s+(?:fail|fails|failed|are\s+failing|still\s+fail)\b|\bstill\s+(?:failing|broken|present|not\s+(?:passing|ok|verified))\b|\bfix\s+(?:the(?:se)?|this)\s+(?:issues?|problems?|bugs?|failures?)\b|\bis\s+not\s+(?:ok(?:ay)?|ready|correct|valid|verified)\b|\bblock(?:er|ing)(?:\s+issue)?\b|\bunsafe\b|\bneeds?\s+(?:further|more)\s+(?:work|review|changes?|fix)\b|(?:未|没有)(?:完成|修复|通过|验证|交付|实现)|(?:测试|验证)(?:未|没有)通过/iu;

/**
 * Order-sensitive terminal-outcome polarity: the LAST decisive outcome
 * marker in the tail determines the result.
 *
 * Positive matches are judged by their END position (where the success claim
 * is), negative matches by their START position (where the failure is). This
 * prevents "tests failed ... tests pass" spans from collapsing to the same
 * start index.
 */
function lastPositiveOutcomeAfterLastNegative(tail: string): boolean {
  return lastMatchEndPosition(EXTERNAL_TERMINAL_OUTCOME, tail)
    > lastMatchPosition(EXTERNAL_NON_SUCCESS_TAIL, tail);
}

function lastMatchPosition(re: RegExp, text: string): number {
  let pos = -1;
  let match: RegExpExecArray | null;
  const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((match = globalRe.exec(text)) !== null) {
    pos = match.index;
  }
  return pos;
}

function lastMatchEndPosition(re: RegExp, text: string): number {
  let pos = -1;
  let match: RegExpExecArray | null;
  const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((match = globalRe.exec(text)) !== null) {
    pos = match.index + match[0].length;
  }
  return pos;
}

function isContextFreeContinuation(value: string): boolean {
  return /^(?:(?:yes[,，]?\s*)?(?:(?:go on|continue|resume)(?:[,，]?\s*(?:go on|continue|resume))*?)|继续(?:\s*继续)*|接着(?:做)?)[.!。！\s]*$/iu.test(value);
}

function utf8Prefix(value: string, maxBytes: number): string {
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maxBytes) end -= 1;
  return value.slice(0, end).trimEnd();
}

function utf8Tail(value: string, maxBytes: number): string {
  let start = Math.max(0, value.length - maxBytes);
  while (start < value.length && Buffer.byteLength(value.slice(start), 'utf8') > maxBytes) {
    start += 1;
  }
  return value.slice(start).trimStart();
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
    detail: boundedAssistantResponseDetail(text),
  };
}

const MAX_ASSISTANT_RESPONSE_EVIDENCE_BYTES = 1000;

function boundedAssistantResponseDetail(text: string): string {
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes <= MAX_ASSISTANT_RESPONSE_EVIDENCE_BYTES) return text;

  // A skill review needs both the initial action and the terminal outcome.
  // Prefix-only truncation systematically discarded the most valuable part of
  // long Pi turns, so preserve a balanced head/tail evidence window.
  const markerReserve = 96;
  const contentBudget = MAX_ASSISTANT_RESPONSE_EVIDENCE_BYTES - markerReserve;
  const headBudget = Math.floor(contentBudget / 2);
  const tailBudget = contentBudget - headBudget;
  const head = utf8Prefix(text, headBudget);
  const tail = utf8Tail(text, tailBudget);
  const keptBytes = Buffer.byteLength(head, 'utf8') + Buffer.byteLength(tail, 'utf8');
  const omittedBytes = Math.max(0, totalBytes - keptBytes);
  return `${head}\n[${omittedBytes} bytes omitted from middle of bounded assistant-response evidence]\n${tail}`;
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
   * Injectable atomic writer used by `save()` and `recover()`.
   * Defaults to a temp-file + rename atomic write.
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

    let parsed: LearningEpisodeStoreState;
    try {
      parsed = JSON.parse(raw) as LearningEpisodeStoreState;
      if (
        !parsed
        || typeof parsed !== 'object'
        || parsed.schemaVersion !== LEARNING_EPISODE_SCHEMA_VERSION
        || !parsed.episodes
        || typeof parsed.episodes !== 'object'
        || Object.values(parsed.episodes).some(episode => (
          !episode
          || typeof episode !== 'object'
          || episode.schemaVersion !== LEARNING_EPISODE_SCHEMA_VERSION
          || !Array.isArray(episode.semanticObservations)
        ))
      ) {
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

    return parsed;
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

function hasContinuationSignal(text: string): boolean {
  return CONTINUATION.test(String(text || '').replace(/\s+/g, ' ').trim());
}

export function buildFlashcardEvidenceBundle(
  episode: LearningEpisode,
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
