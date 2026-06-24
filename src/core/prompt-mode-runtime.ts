import { Message } from '../types';
import {
  FixedPromptModeState,
  PromptModeDefinition,
  PromptModeId,
  getPromptModeDefinition,
  loadPromptModePrompt,
} from '../runtime/prompt-modes';
import { getPromptBaseDir } from '../utils/prompt-template';
import { Logger } from '../utils/logger';
import { SyntheticObservation } from './synthetic-observation';
import {
  PromptModeRouterAction,
  PromptModeRouterFinishPayload,
} from '../tools/prompt-mode-router-tools';

export const TRANSIENT_ACTIVE_PROMPT_MODE_PREFIX = '[transient_active_prompt_mode]';

const DEFAULT_MAX_ACTIVE_TURNS = 5;
const DEFAULT_ACTIVATE_CONFIDENCE = 0.7;
const DEFAULT_CLEAR_CONFIDENCE = 0.7;

export interface PromptModeRuntimeState {
  mode: PromptModeId;
  title: string;
  confidence: number;
  reason: string;
  activatedTurn: number;
  updatedTurn: number;
}

export interface PromptModeRuntimeOptions {
  promptsDir?: string;
  maxActiveTurns?: number;
  activateConfidence?: number;
  clearConfidence?: number;
}

export class PromptModeRuntime {
  private active: PromptModeRuntimeState | null = null;
  private currentTurn = 0;
  private readonly promptsDir: string;
  private readonly maxActiveTurns: number;
  private readonly activateConfidence: number;
  private readonly clearConfidence: number;

  constructor(options: PromptModeRuntimeOptions = {}) {
    this.promptsDir = options.promptsDir ?? getPromptBaseDir();
    this.maxActiveTurns = options.maxActiveTurns ?? DEFAULT_MAX_ACTIVE_TURNS;
    this.activateConfidence = options.activateConfidence ?? DEFAULT_ACTIVATE_CONFIDENCE;
    this.clearConfidence = options.clearConfidence ?? DEFAULT_CLEAR_CONFIDENCE;
  }

  beginTurn(turnNumber: number): void {
    this.currentTurn = turnNumber;
    this.expireIfNeeded(turnNumber);
  }

  getActiveMode(): PromptModeRuntimeState | null {
    return this.active ? { ...this.active } : null;
  }

  clear(reason = 'cleared'): void {
    if (this.active) {
      Logger.info(`[prompt-mode-runtime] cleared active mode ${this.active.mode}: ${reason}`);
    }
    this.active = null;
  }

  applyRouterObservations(observations: SyntheticObservation[], turnNumber = this.currentTurn): void {
    for (const observation of observations) {
      const payload = parsePromptModeRouterObservation(observation);
      if (!payload) {
        Logger.warning(`[prompt-mode-runtime] ignored malformed router observation id=${observation.id || '(none)'}`);
        continue;
      }
      this.applyRouterPayload(payload, turnNumber);
    }
  }

  applyRouterPayload(payload: PromptModeRouterFinishPayload, turnNumber = this.currentTurn): void {
    const action = payload.action;
    if (action === 'ignore') {
      Logger.info(`[prompt-mode-runtime] router ignored mode change confidence=${payload.confidence.toFixed(2)} reason=${payload.reason}`);
      return;
    }

    if (action === 'clear') {
      if (payload.confidence < this.clearConfidence) {
        Logger.info(`[prompt-mode-runtime] ignored low-confidence clear confidence=${payload.confidence.toFixed(2)} reason=${payload.reason}`);
        return;
      }
      this.clear(`router_clear confidence=${payload.confidence.toFixed(2)} reason=${payload.reason}`);
      return;
    }

    if (payload.confidence < this.activateConfidence) {
      Logger.info(`[prompt-mode-runtime] ignored low-confidence activate mode=${payload.mode || '(none)'} confidence=${payload.confidence.toFixed(2)} reason=${payload.reason}`);
      return;
    }

    const definition = getPromptModeDefinition(payload.mode, this.promptsDir);
    if (!definition) {
      Logger.warning(`[prompt-mode-runtime] ignored unknown prompt mode "${payload.mode || ''}" from router`);
      return;
    }

    this.active = {
      mode: definition.id,
      title: definition.title,
      confidence: payload.confidence,
      reason: payload.reason,
      activatedTurn: this.active?.mode === definition.id
        ? this.active.activatedTurn
        : turnNumber,
      updatedTurn: turnNumber,
    };
    Logger.info(`[prompt-mode-runtime] active mode=${definition.id} confidence=${payload.confidence.toFixed(2)} reason=${payload.reason}`);
  }

  buildTransientMessage(options: {
    turnNumber?: number;
    fixedMode?: FixedPromptModeState;
  } = {}): Message | null {
    const turnNumber = options.turnNumber ?? this.currentTurn;
    if (options.fixedMode) return null;
    this.expireIfNeeded(turnNumber);
    if (!this.active) return null;

    const content = loadPromptModePrompt(this.promptsDir, this.active.mode);
    if (!content) {
      Logger.warning(`[prompt-mode-runtime] active mode "${this.active.mode}" is unreadable; clearing`);
      this.active = null;
      return null;
    }

    return {
      role: 'system',
      content: [
        TRANSIENT_ACTIVE_PROMPT_MODE_PREFIX,
        `Active prompt mode: ${this.active.mode} (${this.active.title}).`,
        `Selected asynchronously by runtime mode router with confidence ${this.active.confidence.toFixed(2)}.`,
        `Reason: ${this.active.reason}`,
        'Apply this mode where it fits the current user request. If the user has clearly changed topic, follow the user and do not force this mode.',
        '',
        content,
      ].join('\n'),
    };
  }

  private expireIfNeeded(turnNumber: number): void {
    if (!this.active) return;
    if (turnNumber - this.active.updatedTurn <= this.maxActiveTurns) return;
    Logger.info(`[prompt-mode-runtime] expired active mode ${this.active.mode} after ${this.maxActiveTurns} turns`);
    this.active = null;
  }
}

export function buildPromptModeRouterObservation(
  payload: PromptModeRouterFinishPayload,
  definition?: PromptModeDefinition,
): SyntheticObservation {
  const idParts = [
    'prompt-mode-router',
    payload.action,
    payload.mode || 'none',
    Date.now().toString(36),
  ];

  return {
    id: idParts.join('-').replace(/[^a-zA-Z0-9_-]/g, '_'),
    source: 'runtime',
    status: 'completed',
    relevance: payload.action === 'ignore' ? 'low' : 'high',
    confidence: payload.confidence,
    summary: payload.reason,
    metadata: {
      branchType: 'prompt_mode_router',
      ...(payload.mode ? { refs: [`mode:${payload.mode}`] } : {}),
    },
    formattedContent: JSON.stringify({
      source: 'prompt_mode_router',
      action: payload.action,
      mode: definition?.id || payload.mode,
      confidence: payload.confidence,
      reason: payload.reason,
    }),
  };
}

export function parsePromptModeRouterObservation(
  observation: SyntheticObservation,
): PromptModeRouterFinishPayload | null {
  const raw = observation.formattedContent || observation.summary;
  let parsed: any;
  try {
    parsed = JSON.parse(String(raw || '{}'));
  } catch {
    return null;
  }

  if (parsed?.source !== 'prompt_mode_router') return null;
  const action = parsed.action as PromptModeRouterAction;
  if (action !== 'activate' && action !== 'clear' && action !== 'ignore') return null;
  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence)) return null;
  const reason = String(parsed.reason || '').trim() || 'mode router result';
  const mode = typeof parsed.mode === 'string' && parsed.mode.trim()
    ? parsed.mode.trim()
    : undefined;

  return {
    action,
    ...(mode ? { mode } : {}),
    confidence: Math.max(0, Math.min(1, confidence)),
    reason,
  };
}
