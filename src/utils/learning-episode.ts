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
import type {
  BoundedSourceEvidence,
  EvidenceBundle,
  ReferencedSkillSnapshot,
  SkillEvidenceRef,
} from './skill-evolution';
import { validateFrozenSourceEvidence } from './frozen-source-evidence';

/**
 * A completed production AgentTurn is the unit of learning, not a whole chat
 * session. This includes response-only turns that may carry preferences or
 * decisions. Verification and acceptance that do not deliver a new artifact
 * still fold into the open artifact-delivery attempt in the same session.
 */
export const LEARNING_EPISODE_SCHEMA_VERSION = 3 as const;

export const MAX_SEMANTIC_OBSERVATIONS = 12 as const;
export const MAX_SEMANTIC_OBSERVATION_VALUE_LENGTH = 512 as const;
export const MAX_SEMANTIC_OBSERVATION_PAYLOAD_BYTES = 8192 as const;
/**
 * Maximum UTF-8 bytes retained for one local source-evidence transcript.
 * The transcript is frozen at Episode admission; review never re-reads the
 * source log. A balanced head/tail bound keeps both the request and outcome
 * visible when a turn is unusually verbose.
 */
export const MAX_LEARNING_EPISODE_SOURCE_EVIDENCE_CONTENT_BYTES = 4096 as const;
export const MAX_LEARNING_EPISODE_SOURCE_EVIDENCE_ENTRIES = 64 as const;
export const MAX_LEARNING_EPISODE_SOURCE_EVIDENCE_PAYLOAD_BYTES = 128 * 1024;

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
  /** Identity of the exact source turn captured when this ref was admitted. */
  sourceAgentTurnEpisodeId?: string;
  sourceRuntimeSessionId?: string;
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
  /**
   * Immutable, bounded transcript snapshots for completion refs. This is
   * optional only for backwards compatibility with pre-snapshot records; review
   * must fail closed when a local Episode does not carry it.
   */
  sourceEvidence?: BoundedSourceEvidence[];
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
  const toolNames = uniqueStrings(completionEvidence
    .filter(item => item.kind !== 'assistant-response' && item.kind !== 'user-acceptance')
    .map(item => item.detail?.split(':', 1)[0] || item.kind));
  const evidenceSummary = completionEvidence
    .map(item => item.detail || item.kind)
    .join('; ')
    .slice(0, 280);
  const task = deriveCandidateTaskSummary(episode, toolNames, evidenceSummary);
  const reviewHints = deriveCandidateReviewHints(episode.semanticObservations ?? []);
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
      'Do not reuse the pattern while the user is correcting or iterating on the task.',
      ...reviewHints.boundaries,
    ],
    risks: [
      'This candidate is derived from one completed AgentTurn and may not generalize.',
      'The Author and Verifier must keep the resulting skill bounded by the supplied evidence.',
      'Do not copy lifecycle words such as settled/episode/candidate into the public routing name.',
      ...reviewHints.risks,
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
 * Preserve boundary signals that are easy to lose when a concrete delivery is
 * summarized into a reusable capability. Classify once so boundary and risk
 * text cannot drift onto different trigger conditions. These are review hints:
 * the Author/Verifier still decide whether to create, revise, defer, or reject.
 */
function deriveCandidateReviewHints(
  observations: readonly SemanticObservation[],
): { boundaries: string[]; risks: string[] } {
  const userIntentObservations = observations.filter(
    observation => observation.kind === 'user-intent',
  );
  const boundaries: string[] = [];
  const risks: string[] = [];
  for (const rule of CANDIDATE_REVIEW_HINT_RULES) {
    if (!rule.matches(userIntentObservations)) continue;
    boundaries.push(rule.boundary);
    risks.push(rule.risk);
  }
  return {
    boundaries: uniqueStrings(boundaries),
    risks: uniqueStrings(risks),
  };
}

interface CandidateReviewHintRule {
  matches: (observations: readonly SemanticObservation[]) => boolean;
  boundary: string;
  risk: string;
}

const CANDIDATE_REVIEW_HINT_RULES: readonly CandidateReviewHintRule[] = [
  {
    matches: observations => observationMatches(observations, DYNAMIC_SKILL_INVENTORY_TASK),
    boundary: 'For dynamic Skill inventories, read the single authoritative Current Skill Registry at execution time, verify discovered Skill directories and active/enabled state, and include the observation time; never hard-code counts or names from this episode.',
    risk: 'Dynamic inventories may change between sessions; stale snapshots can produce wrong skill names, counts, or instructions.',
  },
  {
    matches: observations => observationContainsAll(
      observations,
      USER_PROVIDED_MATERIAL,
      INVESTOR_CONTEXT,
      TRANSCRIPT_MATERIAL,
      ANALYSIS_ACTION,
    ),
    boundary: 'For analysis of a user-provided investor transcript, fix the input requirements, analysis dimensions, fact/opinion separation rules, and citation/source boundaries before reuse.',
    risk: 'A single investor-transcript analysis can be overgeneralized into an unsupported domain-analysis skill.',
  },
  {
    matches: observations => observationContainsAllAfterRemovingNegatedActions(
      observations,
      EMAIL_SYSTEM,
      EXTERNAL_EMAIL_ACTION,
    ),
    boundary: 'For email account operations, require explicit current authorization and an available login state; never handle verification codes, plaintext secrets, or unauthorized mailboxes.',
    risk: 'Prior account, credential, or email-system access does not grant future authority.',
  },
  {
    matches: observations => observationContainsAll(
      observations,
      CROSS_REPOSITORY,
      MENTION_GATING,
      REPOSITORY_CHANGE_ACTION,
    ),
    boundary: 'For cross-repository mention-gating changes, require explicit current repository authorization, baseline tests, a structured mention protocol, and final review, CI, and merge evidence; defer until that closure is present.',
    risk: 'Prior private-repository, PR, CI, or merge access does not grant future authority, and an unclosed change may not be safely replayable.',
  },
  {
    matches: observations => observationContainsAllAfterRemovingNegatedActions(
      observations,
      STRONG_PRIVILEGED_ACCESS,
      PRIVILEGED_ACTION,
    ),
    boundary: 'For privileged account or external-system work, require explicit current authorization and available credentials/login state; do not inherit access from this episode.',
    risk: 'Prior account, credential, or external-system access does not grant future authority.',
  },
  {
    matches: observations => observationContainsAll(
      observations,
      OUTPUT_DOCUMENT_TASK,
      OPERATION_RECAP_CONTEXT,
      UNDERLYING_OPERATION_TASK,
    ),
    boundary: 'Distinguish the delivered document from the transferable operation behind it; do not turn a one-off write-up into a broad reporting skill when the evidence supports a narrower operation.',
    risk: 'The visible artifact may be a report about a capability rather than the capability that should be learned.',
  },
];

function observationMatches(
  observations: readonly SemanticObservation[],
  pattern: RegExp,
): boolean {
  return observations.some(observation => pattern.test(observation.value));
}

function observationContainsAll(
  observations: readonly SemanticObservation[],
  ...patterns: readonly RegExp[]
): boolean {
  return observations.some(observation =>
    patterns.every(pattern => pattern.test(observation.value)),
  );
}

function observationContainsAllAfterRemovingNegatedActions(
  observations: readonly SemanticObservation[],
  ...patterns: readonly RegExp[]
): boolean {
  return observations.some(observation => {
    const affirmativeText = observation.value
      .replace(NEGATED_ENGLISH_EXTERNAL_ACTION_CLAUSE, ' ')
      .replace(NEGATED_CHINESE_EXTERNAL_ACTION_CLAUSE, ' ');
    return patterns.every(pattern => pattern.test(affirmativeText));
  });
}

const DYNAMIC_SKILL_INVENTORY_TASK = /(?:(?:list|inventory|catalog)[\s\S]{0,24}(?:registered|enabled)[\s\S]{0,16}\bskills\b|(?:registered|enabled)[\s\S]{0,24}\bskills\b[\s\S]{0,32}(?:list|inventory|catalog|registry|count|names?|enabled)|\bskills\b[\s\S]{0,16}(?:registry|registration|enabled state)|(?:列出|清单|列表|目录)[\s\S]{0,20}(?:当前|实际)[\s\S]{0,12}(?:注册|启用)[\s\S]{0,12}(?:Skills|技能)|(?:当前|实际)[\s\S]{0,24}(?:注册|启用)[\s\S]{0,12}(?:Skills|技能)[\s\S]{0,32}(?:清单|列表|目录|注册表|数量|名称|启用)|(?:Skills|技能)[\s\S]{0,12}(?:注册表|注册状态|启用状态))/iu;
const USER_PROVIDED_MATERIAL = /(?:user[-\s]?provided|provided by the user|用户提供)/iu;
const INVESTOR_CONTEXT = /(?:investor|投资者|交流会)/iu;
const TRANSCRIPT_MATERIAL = /(?:transcript|文字稿|访谈稿)/iu;
const ANALYSIS_ACTION = /(?:analy[sz]e|analysis|summari[sz]e|review|extract|分析|摘要|总结|提取)/iu;
const EMAIL_SYSTEM = /(?:\bmail\b|\bemail\b|mailbox|mails\.dev|邮箱|邮件)/iu;
const EXTERNAL_EMAIL_ACTION = /(?:\b(?:send|sending|sent|receive|receives|received|receiving|establish|establishes|established|establishing|setup|configure|configures|configured|configuring|authenticate|authenticates|authenticated|authenticating|access|accesses|accessed|accessing)\b|\blog(?:s|ged|ging)?\s+in\b|收发|发送|接收|建立|配置|登录|访问|验收)/iu;
const CROSS_REPOSITORY = /(?:cross[-\s]?repositor(?:y|ies)|cross[-\s]?repo|two repositor(?:y|ies)|two repos|双仓|跨仓|两个私有仓)/iu;
const MENTION_GATING = /(?:\bmention(?:[-\s]?gating)?\b|activation gate|mention gate|门控|激活链路|@ 激活)/iu;
const REPOSITORY_CHANGE_ACTION = /(?:modify|change|implement|fix|commit|merge|修改|改动|实现|修复|提交|合并)/iu;
const STRONG_PRIVILEGED_ACCESS = /(?:oauth|access token|api key|secret|credential|login state|account access|private repositor(?:y|ies)|验证码|密钥|凭据|登录态|账号权限|私有仓)/iu;
const PRIVILEGED_ACTION = /(?:\b(?:access|authenticate|authorize|setup|configure|modify|change|implement|rotate|store)\b|\blog(?:ging)?\s+in\b|访问|认证|授权|登录|建立|配置|修改|实现|轮换|保存)/iu;
const NEGATED_ENGLISH_EXTERNAL_ACTION_CLAUSE = /(?:without|do not|don't|never|no need to)\s+(?:(?:currently|yet)\s+)?(?:access(?:ing)?|use|using|log(?:ging)?\s+in|authenticate|send(?:ing)?|receive|receiving)\b[^,;.，。；]*?(?=\b(?:but|however|instead)\b|[,;.，。；]|$)/giu;
const NEGATED_CHINESE_EXTERNAL_ACTION_CLAUSE = /(?:不|无需|不要|禁止)(?:访问|使用|登录|授权|发送|接收)[^,;.，。；]*?(?=(?:但|但是|而是|不过|然后)|[,;.，。；]|$)/giu;
const OUTPUT_DOCUMENT_TASK = /(?:report|document|write[-\s]?up|html|kami|pdf|docx|复盘|报告|文档|清单|总结|摘要)/iu;
const OPERATION_RECAP_CONTEXT = /(?:recap|history|journey|retrospective|write[-\s]?up about|documenting how|历程|过程|复盘|回顾|记录)/iu;
const UNDERLYING_OPERATION_TASK = /(?:establish|setup|configure|implement|fix|verify|validate|build|operate|established|configured|implemented|fixed|verified|validated|建立|配置|实现|修复|验证|验收|收发|改动|链路|能力)/iu;

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
    : `Follow the observed user preference or task intent${intentSnippet ? ` (${intentSnippet})` : ''}: ${evidenceSummary}`;

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
 * Extract candidate learning episodes from one Distillation Unit.
 *
 * Every completed internal production AgentTurn with a non-empty assistant
 * response is observable evidence: response-only turns can carry reusable
 * preferences, decisions, explanations, or workflows. Corrections and true
 * redeliveries stay independent. Verification or acceptance that does not
 * deliver a new artifact folds into the open predecessor delivery in the same
 * runtime session, so create→check→accept remains one learning unit.
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
    const next = turns[index + 1];
    const completionEvidence = detectCompletionEvidence(deliverySourceFilePath, deliveryTurn);
    const evidence = uniqueEvidence([
      ...completionEvidence,
      ...(hasArtifactDeliveryEvidence(completionEvidence)
        ? collectPrecedingWorkflowEvidence(turns, index, unit.filePath)
        : []),
    ]);
    const isWorkflowStepForFollowingArtifact = next
      ? detectWorkflowEvidence(deliverySourceFilePath, deliveryTurn).length > 0
        && hasArtifactDeliveryEvidence(detectCompletionEvidence(
          turnSourceFilePath(next, unit.filePath),
          next,
        ))
      : false;
    const definitelyNonLearningInteraction = isDefinitelyNonLearningInteraction(deliveryTurn);
    if (
      !hasDeliveryEvidence(evidence)
      && String(deliveryTurn.session_type ?? '').trim().toLowerCase() !== 'external'
      && !isWorkflowStepForFollowingArtifact
      && !definitelyNonLearningInteraction
    ) {
      const assistantResponse = detectAssistantResponseEvidence(deliverySourceFilePath, deliveryTurn);
      if (assistantResponse) evidence.push(assistantResponse);
    }
    const episodeId = makeEpisodeId(deliverySourceFilePath, deliveryTurn);
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
      // External and legacy inputs may not have admitted a response above. A
      // following explicit acceptance still makes that response bounded
      // evidence for Author/Verifier review.
      if (!hasDeliveryEvidence(evidence) && !definitelyNonLearningInteraction) {
        const assistantResponse = detectAssistantResponseEvidence(deliverySourceFilePath, deliveryTurn);
        if (assistantResponse) evidence.push(assistantResponse);
      }
      evidence.push(accepted);
    } else if (!hasDeliveryEvidence(evidence) && isExternalCompleteFinalDelivery(deliveryTurn)) {
      // External Session Log Sources (xURL/Pi) materialize a complete
      // User→final-Assistant event with empty tool_calls. Treat the final
      // assistant text as candidate episode evidence only for external
      // session metadata. External evidence remains terminal-outcome gated;
      // Author/Verifier still decide whether it deserves a Capability.
      const assistantResponse = detectAssistantResponseEvidence(deliverySourceFilePath, deliveryTurn);
      if (assistantResponse) evidence.push(assistantResponse);
    }
    if (!hasDeliveryEvidence(evidence)) continue;

    const predecessor = [...episodes].reverse().find(candidate =>
      candidate.runtimeSessionId === runtimeSessionIdOf(deliveryTurn)
      && candidate.deliveryTurn < deliveryTurn.turn,
    );
    const semanticObservations = extractSemanticObservations(turns, index, evidence, signal, unit.filePath);
    const sourceEvidence = freezeSourceEvidence(turns, evidence, unit.filePath, unit.byteRange);

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
      if (sourceEvidence) {
        predecessor.sourceEvidence = mergeSourceEvidence([
          ...(predecessor.sourceEvidence ?? []),
          ...sourceEvidence,
        ]);
      } else if (predecessor.sourceEvidence) {
        // Preserve the first-writer snapshot. The newly folded refs remain in
        // completionEvidence and bundle construction will fail closed for any
        // ref without a matching frozen source, but an ambiguous later turn
        // must not erase earlier evidence that was already trustworthy.
      }
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
      ...(sourceEvidence ? { sourceEvidence } : {}),
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
      const acceptedEvidence = uniqueEvidence([
        ...deliveryEvidence,
        ...collectPrecedingWorkflowEvidence(turns, index, unit.filePath),
        accepted,
      ]);
      const acceptedSourceEvidence = freezeSourceEvidence(
        turns,
        acceptedEvidence,
        unit.filePath,
        unit.byteRange,
      );
      episodes.push({
        schemaVersion: LEARNING_EPISODE_SCHEMA_VERSION,
        episodeId: makeEpisodeId(deliverySourceFilePath, delivery),
        ...(agentTurnEpisodeIdOf(delivery) && { agentTurnEpisodeId: agentTurnEpisodeIdOf(delivery) }),
        runtimeSessionId: runtimeSessionIdOf(delivery),
        sourceFilePath: deliverySourceFilePath,
        deliveryTurn: delivery.turn,
        completionEvidence: acceptedEvidence,
        contradictionSignals: [],
        ...(acceptedSourceEvidence
          ? {
            sourceEvidence: acceptedSourceEvidence,
          }
          : {}),
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
 * Freeze the source material used by Author/Verifier for one Episode.
 *
 * Episode evidence refs are intentionally small control-plane records. Their
 * `detail` field is useful for candidate hints, but it is not a replayable
 * transcript and may omit the user's request or the assistant's response.
 * Capture the matching turn while the Distillation Unit is still in memory so
 * later review never depends on a mutable/deleted source log.
 */
function freezeSourceEvidence(
  turns: readonly CompletedTurn[],
  evidence: readonly EpisodeEvidenceRef[],
  unitFilePath: string,
  unitByteRange: { start: number; end: number },
): BoundedSourceEvidence[] | undefined {
  const relevant = uniqueEvidence(evidence.filter(item => item.kind !== 'contradiction'));
  if (
    relevant.length === 0
    || relevant.length > MAX_LEARNING_EPISODE_SOURCE_EVIDENCE_ENTRIES
  ) return undefined;
  const frozen = new Map<string, BoundedSourceEvidence>();
  for (const item of relevant) {
    const turn = findUniqueEvidenceSourceTurn(turns, item, unitFilePath);
    // A ref without a matching in-memory turn cannot be made auditable. Keep
    // it absent; bundle construction will fail closed instead of fabricating
    // source content from the summary detail.
    if (!turn) return undefined;
    const content = formatFrozenTurnEvidence(turn, item);
    if (!content) return undefined;
    const origin = (turn as DistillationTurn).origin;
    const byteRange = origin?.byteRange
      ?? (turnSourceFilePath(turn, unitFilePath) === unitFilePath ? unitByteRange : undefined);
    if (frozen.has(item.ref)) continue;
    frozen.set(item.ref, {
      ref: item.ref,
      role: 'problem-action',
      content,
      sourceFilePath: item.sourceFilePath,
      turn: item.turn,
      ...(byteRange ? { byteRange } : {}),
    });
  }
  const result = [...frozen.values()];
  return isSourceEvidencePayloadWithinBounds(result) ? result : undefined;
}

function findUniqueEvidenceSourceTurn(
  turns: readonly CompletedTurn[],
  evidence: EpisodeEvidenceRef,
  unitFilePath: string,
): CompletedTurn | undefined {
  const candidates = turns.filter(candidate => (
    candidate.turn === evidence.turn
    && turnSourceFilePath(candidate, unitFilePath) === evidence.sourceFilePath
    && runtimeSessionIdOf(candidate) === evidence.sourceRuntimeSessionId
    && agentTurnEpisodeIdOf(candidate) === evidence.sourceAgentTurnEpisodeId
  ));
  if (candidates.length === 0) return undefined;

  // Duplicate physical records are harmless only when their complete
  // user/assistant evidence is identical. Divergent records under the same
  // identity are ambiguous and must not be resolved by array order.
  const unique = firstByKey(candidates, evidenceSourceTurnFingerprint);
  return unique.length === 1 ? unique[0] : undefined;
}

function evidenceSourceTurnFingerprint(turn: CompletedTurn): string {
  return hash(JSON.stringify({
    runtimeSessionId: runtimeSessionIdOf(turn),
    agentTurnEpisodeId: agentTurnEpisodeIdOf(turn),
    user: turn.user,
    assistant: turn.assistant,
  }));
}

function isSourceEvidencePayloadWithinBounds(
  evidence: readonly BoundedSourceEvidence[],
): boolean {
  return evidence.length <= MAX_LEARNING_EPISODE_SOURCE_EVIDENCE_ENTRIES
    && Buffer.byteLength(JSON.stringify(evidence), 'utf8')
      <= MAX_LEARNING_EPISODE_SOURCE_EVIDENCE_PAYLOAD_BYTES;
}

function formatFrozenTurnEvidence(
  turn: CompletedTurn,
  evidence: EpisodeEvidenceRef,
): string {
  const user = String(turn.user?.text ?? '').trim();
  const assistant = String(turn.assistant?.text ?? '').trim();
  const detail = String(evidence.detail ?? '').trim();
  const sections: string[] = [];
  if (user) sections.push(`User:\n${user}`);
  if (assistant) sections.push(`Assistant:\n${assistant}`);
  // Tool results and acceptance text are already captured in the ref detail;
  // include them when they add information beyond the transcript itself.
  if (detail && detail !== user && detail !== assistant && evidence.kind !== 'assistant-response') {
    sections.push(`Observed ${evidence.kind}:\n${detail}`);
  }
  return boundSourceEvidenceContent(sections.join('\n\n'));
}

function boundSourceEvidenceContent(value: string): string {
  const normalized = value.trim();
  if (!normalized) return '';
  if (Buffer.byteLength(normalized, 'utf8') <= MAX_LEARNING_EPISODE_SOURCE_EVIDENCE_CONTENT_BYTES) {
    return normalized;
  }
  const marker = '\n[... middle omitted from bounded source evidence ...]\n';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const contentBudget = Math.max(0, MAX_LEARNING_EPISODE_SOURCE_EVIDENCE_CONTENT_BYTES - markerBytes);
  const headBudget = Math.floor(contentBudget / 2);
  const tailBudget = contentBudget - headBudget;
  return `${utf8Prefix(normalized, headBudget)}${marker}${utf8Tail(normalized, tailBudget)}`.trim();
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
    const sourceFilePath = turnSourceFilePath(preceding, fallbackSourceFilePath);
    if (hasDeliveryEvidence(detectCompletionEvidence(sourceFilePath, preceding))) break;
    if (
      preceding.assistant.text.trim()
      && detectWorkflowEvidence(sourceFilePath, preceding).length === 0
    ) break;
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
  for (const [toolIndex, tool] of turn.assistant.tool_calls.entries()) {
    const detail = toolDetail(tool);
    if (VALIDATION_TOOL.test(tool.name) && SUCCESS_RESULT.test(tool.result || '')) {
      evidence.push({
        ref: toolEvidenceRef(filePath, turn, toolIndex, `validation:${tool.name}`),
        sourceFilePath: filePath,
        turn: turn.turn,
        kind: 'artifact-validation',
        detail,
        ...sourceTurnEvidenceIdentity(turn),
      });
    } else if (isDeliveryTool(tool) && !FAILURE_RESULT.test(tool.result || '')) {
      evidence.push({
        ref: toolEvidenceRef(filePath, turn, toolIndex, `delivery:${tool.name}`),
        sourceFilePath: filePath,
        turn: turn.turn,
        kind: 'artifact-delivery',
        detail,
        ...sourceTurnEvidenceIdentity(turn),
      });
    }
  }
  return uniqueEvidence([...evidence, ...workflowEvidence]);
}

function detectWorkflowEvidence(filePath: string, turn: CompletedTurn): EpisodeEvidenceRef[] {
  return turn.assistant.tool_calls
    .map((tool, toolIndex) => ({ tool, toolIndex }))
    .filter(({ tool }) => isArtifactWorkflowTool(tool) && !FAILURE_RESULT.test(tool.result || ''))
    .map(({ tool, toolIndex }) => ({
      ref: toolEvidenceRef(filePath, turn, toolIndex, `workflow:${tool.name}`),
      sourceFilePath: filePath,
      turn: turn.turn,
      kind: 'verified-tool-result' as const,
      detail: toolDetail(tool),
      ...sourceTurnEvidenceIdentity(turn),
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
    const workflowEvidence = detectWorkflowEvidence(sourceFilePath, preceding);
    if (preceding.assistant.text.trim() && workflowEvidence.length === 0) break;
    evidence.unshift(...workflowEvidence);
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
    item.kind === 'artifact-validation'
    || item.kind === 'verified-tool-result',
  );
}

/**
 * Filter only interactions that cannot carry a user preference or workflow.
 *
 * This is deliberately an anchored, short-form allowlist rather than a
 * classifier. Anything with additional task content remains a candidate and
 * is left for Author/Verifier to narrow or reject.
 */
const PURE_ACKNOWLEDGEMENT = /^(?:thank(?:s| you)?(?: a lot)?(?:,? (?:that|it|this) (?:works?|worked)(?: perfectly| great| well)?)?|yes|yep|yeah|y|great|good|perfect|excellent|correct|done|verified|confirmed|that(?:'s|’s| is) (?:right|correct|good|great|perfect)|(?:that|it|this) (?:works?|worked)(?: perfectly| great| well)?|looks? good|you (?:did|fixed|solved) it|谢谢(?:你)?|多谢(?:你)?|感谢(?:你)?|好的?|可以|行|没问题|对|没错|正确|很好|完美|完成了?|解决了?|这样(?:就)?(?:好|可以|行))[\s.!?。！？，,]*$/iu;
const PURE_GREETING = /^(?:hi|hello|hey|good morning|good afternoon|good evening|bye|goodbye|你好|您好|嗨|早上好|晚上好|再见|晚安)[\s.!?。！？，,]*$/iu;
const PURE_SOCIAL_RESPONSE = /^(?:you(?:'re| are) welcome|glad (?:it|that) helped|glad to help|happy to help|anytime|ok(?:ay)?|got it|understood|hello(?:,? how can i help(?: you)?)?|hi(?:,? how can i help(?: you)?)?|goodbye|不客气|不用谢|好的?|收到|明白了?|你好|您好|再见)[\s.!?。！？，,]*$/iu;

function isDefinitelyNonLearningInteraction(turn: CompletedTurn): boolean {
  const userText = turn.user.text.replace(/\s+/g, ' ').trim();
  const assistantText = turn.assistant.text.replace(/\s+/g, ' ').trim();
  return userText.length > 0
    && assistantText.length > 0
    && (PURE_ACKNOWLEDGEMENT.test(userText) || PURE_GREETING.test(userText))
    && PURE_SOCIAL_RESPONSE.test(assistantText);
}

function uniqueContradictionSignals(
  signals: readonly ContradictionSignal[],
): ContradictionSignal[] {
  return firstByKey(signals, signal => signal.signalId);
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
  // into one assistant turn. Reject only context-free continuations and an
  // explicit unresolved terminal failure here; absence of a success keyword
  // is not evidence that a substantive final is waste. Author/Verifier own the
  // later, narrower judgment about whether the result is reusable.
  const userText = turn.user.text.replace(/\s+/g, ' ').trim();
  if (isContextFreeContinuation(userText)) return false;

  const tail = utf8Tail(assistantText, 2_000);
  if (EXTERNAL_UNFINISHED_PROGRESS_TAIL.test(tail)) return false;
  // Order-sensitive terminal-outcome polarity: the LAST decisive outcome
  // determines whether the external tail is a successful final or a retry.
  // A corrected success (earlier failure → later success) admits; a final
  // blocker after an implementation (earlier positive → later negative)
  // rejects. Never manufacture success from an earlier positive word when
  // the terminal outcome is negative.
  return hasNoUnresolvedTerminalFailure(tail);
}

const EXTERNAL_TERMINAL_OUTCOME = /(?:\b(?:completed?|done|fixed|implemented|updated|created|removed|restored|verified|validated|delivered|committed|shipped)\b|\btests?\b[^\n]{0,80}\bpass(?:ed|ing)?\b|\ball\s+\d+[^\n]{0,40}\bpass(?:ed|ing)?\b|\bcommit\s+[0-9a-f]{7,40}\b|(?:已|已经)(?:完成|修复|修改|更新|删除|恢复|创建|实现|验证|提交|交付)|(?:改好|删掉|恢复完成|测试通过|验证通过))/iu;

/**
 * A final sentence that explicitly says the work is still underway or that a
 * concrete implementation step comes next is progress narration, not a
 * delivery. Keep this veto tail-anchored and narrow: earlier investigation
 * does not erase a later substantive final, and no success keyword is needed.
 */
const EXTERNAL_UNFINISHED_PROGRESS_TAIL = /(?:^|[\n.!?。！？]\s*)(?:(?:i(?:'m| am)\s+)?(?:still\s+)?(?:exploring|investigating|working\s+on|looking\s+into|checking)\b|(?:(?:let\s+me|i(?:'ll|\s+will)|i(?:'m|\s+am)\s+going\s+to|next[,，:]?\s+i(?:'ll|\s+will))\s+(?:add|write|implement|fix|check|test|inspect|investigate|explore|update|create|run|continue|work)\b)|(?:正在|仍在)(?:检查|调查|探索|处理|修复|实现|编写|测试)|接下来(?:我)?(?:会|将|先)(?:检查|调查|探索|处理|修复|实现|编写|测试|添加|更新))[^\n.!?。！？]{0,240}[.!?。！？]?\s*$/iu;

/**
 * Explicit non-success / negative-review or terminal-blocker markers.
 * Kept narrow so genuine success (e.g. "nothing failed", "all checks passed")
 * is never vetoed: bare words like "failed" or "fix" are NOT matched — only
 * explicit negative outcomes, directive-to-fix, or terminal blocking issues.
 */
const EXTERNAL_NON_SUCCESS_TAIL = /\bnot\s+(?:ok(?:ay)?|verified|validated|done|completed|fixed|implemented|delivered|shipped|ready|correct|valid|pass(?:ed|ing)?)\b|\b(?:did|do|does|don'?t|doesn'?t|didn'?t|won'?t|cannot|can'?t|failed\s+to|did\s+not)\s+(?:not\s+)?(?:pass|verify|validated?|complete|deliver|ship)\b|\b(?:tests?|checks?)\s+(?:fail|fails|failed|are\s+failing|still\s+fail)\b|\bstill\s+(?:failing|broken|present|not\s+(?:passing|ok|verified))\b|\bfix\s+(?:the(?:se)?|this)\s+(?:issues?|problems?|bugs?|failures?)\b|\bis\s+not\s+(?:ok(?:ay)?|ready|correct|valid|verified)\b|\bblock(?:er|ing)(?:\s+issue)?\b|\bunsafe\b|\bneeds?\s+(?:further|more)\s+(?:work|review|changes?|fix)\b|(?:未|没有)(?:完成|修复|通过|验证|交付|实现)|(?:测试|验证)(?:未|没有)通过|(?:测试|验证)(?:失败|不通过)|(?:无法|不能|未能)(?:完成|修复|通过|验证|交付|实现)|(?:遇到|发生)(?:了)?(?:错误|问题|异常)/iu;

/**
 * Order-sensitive terminal-outcome polarity: the LAST decisive outcome
 * marker in the tail determines the result.
 *
 * Positive matches are judged by their END position (where the success claim
 * is), negative matches by their START position (where the failure is). This
 * prevents "tests failed ... tests pass" spans from collapsing to the same
 * start index.
 */
function hasNoUnresolvedTerminalFailure(tail: string): boolean {
  const lastNegative = lastMatchPosition(EXTERNAL_NON_SUCCESS_TAIL, tail);
  return lastNegative < 0
    || lastMatchEndPosition(EXTERNAL_TERMINAL_OUTCOME, tail) > lastNegative;
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
    ...sourceTurnEvidenceIdentity(turn),
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
    ...sourceTurnEvidenceIdentity(next),
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
  if (
    !message
    || (!POSITIVE_ACCEPTANCE.test(message) && !PURE_ACKNOWLEDGEMENT.test(message))
    || CONTRADICTION.test(message)
  ) return undefined;
  return {
    ref: evidenceRef(filePath, next.turn, 'acceptance'),
    sourceFilePath: filePath,
    turn: next.turn,
    kind: 'user-acceptance',
    detail: message,
    ...sourceTurnEvidenceIdentity(next),
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

function sourceTurnEvidenceIdentity(turn: CompletedTurn): Pick<
  EpisodeEvidenceRef,
  'sourceAgentTurnEpisodeId' | 'sourceRuntimeSessionId'
> {
  const sourceAgentTurnEpisodeId = agentTurnEpisodeIdOf(turn);
  return {
    ...(sourceAgentTurnEpisodeId ? { sourceAgentTurnEpisodeId } : {}),
    sourceRuntimeSessionId: runtimeSessionIdOf(turn),
  };
}

function turnSourceFilePath(turn: CompletedTurn, fallback: string): string {
  const origin = (turn as DistillationTurn).origin?.filePath;
  return typeof origin === 'string' && origin.trim() ? origin : fallback;
}

function evidenceRef(filePath: string, turn: number, kind: string): string {
  return `${filePath}#turn-${turn}:${kind}`;
}

/**
 * Preserve distinct same-name tool calls in one turn. Older logs and the
 * common single-call case retain their original ref shape; only a duplicate
 * group receives a stable call suffix, using the provider id when available
 * and the same-name ordinal as a legacy fallback.
 */
function toolEvidenceRef(
  filePath: string,
  turn: CompletedTurn,
  toolIndex: number,
  kind: string,
): string {
  const tool = turn.assistant.tool_calls[toolIndex]!;
  const domain = kind.split(':', 1)[0]!;
  const group = turn.assistant.tool_calls
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => (
      candidate.name === tool.name
      && isToolEvidenceDomainCandidate(candidate, domain)
    ));
  if (group.length <= 1) return evidenceRef(filePath, turn.turn, kind);
  const ordinal = group.findIndex(item => item.index === toolIndex) + 1;
  const providerId = typeof tool.id === 'string' && tool.id.trim()
    ? `id-${hash(tool.id.trim()).slice(0, 12)}`
    : `ordinal-${ordinal}`;
  return evidenceRef(filePath, turn.turn, `${kind}:call-${providerId}-${ordinal}`);
}

function isToolEvidenceDomainCandidate(tool: SessionToolCallLog, domain: string): boolean {
  if (domain === 'validation') {
    return VALIDATION_TOOL.test(tool.name) && SUCCESS_RESULT.test(tool.result || '');
  }
  if (domain === 'delivery') {
    return !(VALIDATION_TOOL.test(tool.name) && SUCCESS_RESULT.test(tool.result || ''))
      && isDeliveryTool(tool)
      && !FAILURE_RESULT.test(tool.result || '');
  }
  return domain === 'workflow'
    && isArtifactWorkflowTool(tool)
    && !FAILURE_RESULT.test(tool.result || '');
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
  return firstByKey(evidence, item => item.ref);
}

function firstByKey<T>(values: readonly T[], keyOf: (value: T) => string): T[] {
  const first = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (!first.has(key)) first.set(key, value);
  }
  return [...first.values()];
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
          || (episode.sourceEvidence !== undefined && !isValidFrozenSourceEvidence(episode.sourceEvidence))
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
      predecessor.contradictionSignals = uniqueContradictionSignals([
        ...predecessor.contradictionSignals,
        signal,
      ]);
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

function isValidFrozenSourceEvidence(value: unknown): value is BoundedSourceEvidence[] {
  if (!Array.isArray(value)) return false;
  if (value.some(item => (
    !item
    || typeof item !== 'object'
    || (item as Partial<BoundedSourceEvidence>).role !== 'problem-action'
  ))) return false;
  const sourceEvidence = value as BoundedSourceEvidence[];
  const failure = validateFrozenSourceEvidence(
    {
      completionEvidence: sourceEvidence.map(source => ({
        ref: source.ref,
        sourceFilePath: source.sourceFilePath,
        turn: source.turn,
        byteRange: source.byteRange,
      })),
      settlementEvidence: [],
      sourceEvidence,
    },
    {
      maxEntries: MAX_LEARNING_EPISODE_SOURCE_EVIDENCE_ENTRIES,
      maxPayloadBytes: MAX_LEARNING_EPISODE_SOURCE_EVIDENCE_PAYLOAD_BYTES,
      maxContentBytes: MAX_LEARNING_EPISODE_SOURCE_EVIDENCE_CONTENT_BYTES,
      requireSettlementCoverage: false,
    },
  );
  return !failure;
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
    contradictionSignals: uniqueContradictionSignals(signals),
    ...(existing.sourceEvidence !== undefined || incoming.sourceEvidence !== undefined
      ? {
        sourceEvidence: mergeSourceEvidence([
          ...(existing.sourceEvidence ?? []),
          ...(incoming.sourceEvidence ?? []),
        ]),
      }
      : {}),
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

function mergeSourceEvidence(
  evidence: readonly BoundedSourceEvidence[],
): BoundedSourceEvidence[] | undefined {
  // Episode replay may re-extract the same ref from a changed source log. The
  // durable first snapshot remains authoritative; replay may only add a ref
  // that was not present at original admission. If later refs would exceed a
  // bound, retain the already-admitted prefix instead of erasing it.
  const merged: BoundedSourceEvidence[] = [];
  for (const item of firstByKey(evidence, candidate => candidate.ref)) {
    const candidate = [...merged, item];
    if (isSourceEvidencePayloadWithinBounds(candidate)) merged.push(item);
  }
  return merged.length > 0 ? merged : undefined;
}

function mergeSemanticObservations(
  existing: readonly SemanticObservation[] | undefined,
  incoming: readonly SemanticObservation[] | undefined,
): SemanticObservation[] {
  const first = firstByKey([
    ...(existing ?? []),
    ...(incoming ?? []),
  ], observation => JSON.stringify({
    kind: observation.kind,
    sourceRefs: [...observation.sourceRefs].sort(),
  }));
  return boundSemanticObservations(first);
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
    authority: { kind: 'flashcard', episodeId: episode.episodeId },
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
