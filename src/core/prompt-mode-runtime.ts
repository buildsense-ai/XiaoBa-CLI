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
import {
  SyntheticObservation,
  SyntheticObservationTiming,
} from './synthetic-observation';
import {
  PromptModeRouterAction,
  PromptModeRouterFinishPayload,
} from '../tools/prompt-mode-router-tools';

export const TRANSIENT_ACTIVE_PROMPT_MODE_PREFIX = '[transient_active_prompt_mode]';

const DEFAULT_FULL_PROMPT_REFRESH_INTERVAL = 3;
const DEFAULT_ACTIVATE_CONFIDENCE = 0.7;
const DEFAULT_CLEAR_CONFIDENCE = 0.7;

export interface PromptModeRuntimeState {
  mode: PromptModeId;
  title: string;
  confidence: number;
  reason: string;
  activatedTurn: number;
  updatedTurn: number;
  sourceTiming?: SyntheticObservationTiming;
  originTurn?: number;
  appliedTurn: number;
  instructionsInjectedTurn?: number;
}

export interface PromptModeRuntimeOptions {
  promptsDir?: string;
  fullPromptRefreshInterval?: number;
  activateConfidence?: number;
  clearConfidence?: number;
}

export class PromptModeRuntime {
  private active: PromptModeRuntimeState | null = null;
  private currentTurn = 0;
  private readonly promptsDir: string;
  private readonly fullPromptRefreshInterval: number;
  private readonly activateConfidence: number;
  private readonly clearConfidence: number;

  constructor(options: PromptModeRuntimeOptions = {}) {
    this.promptsDir = options.promptsDir ?? getPromptBaseDir();
    this.fullPromptRefreshInterval = Math.max(
      1,
      Math.floor(options.fullPromptRefreshInterval ?? DEFAULT_FULL_PROMPT_REFRESH_INTERVAL),
    );
    this.activateConfidence = options.activateConfidence ?? DEFAULT_ACTIVATE_CONFIDENCE;
    this.clearConfidence = options.clearConfidence ?? DEFAULT_CLEAR_CONFIDENCE;
  }

  beginTurn(turnNumber: number): void {
    this.currentTurn = turnNumber;
  }

  getActiveMode(): PromptModeRuntimeState | null {
    return this.active ? { ...this.active } : null;
  }

  getTurnsUntilFullPromptRefresh(turnNumber = this.currentTurn): number | null {
    if (!this.active) return null;
    if (this.active.instructionsInjectedTurn === undefined) return 0;
    const turnsSinceFullPrompt = turnNumber - this.active.instructionsInjectedTurn;
    return Math.max(0, this.fullPromptRefreshInterval - turnsSinceFullPrompt);
  }

  clear(reason = 'cleared'): void {
    if (this.active) {
      Logger.info(`[prompt-mode-runtime] cleared active mode ${this.active.mode}: ${reason}`);
      this.logRuntimeEvent('clear', this.active, {
        reason,
        turnsUntilFullPromptRefresh: this.getTurnsUntilFullPromptRefresh(),
      });
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
      this.logRuntimeEvent('ignore', this.active, {
        confidence: payload.confidence,
        reason: payload.reason,
      });
      return;
    }

    if (action === 'clear') {
      if (payload.confidence < this.clearConfidence) {
        Logger.info(`[prompt-mode-runtime] ignored low-confidence clear confidence=${payload.confidence.toFixed(2)} reason=${payload.reason}`);
        this.logRuntimeEvent('ignore_clear', this.active, {
          confidence: payload.confidence,
          reason: payload.reason,
        });
        return;
      }
      this.clear(`router_clear confidence=${payload.confidence.toFixed(2)} reason=${payload.reason}`);
      return;
    }

    if (payload.confidence < this.activateConfidence) {
      Logger.info(`[prompt-mode-runtime] ignored low-confidence activate mode=${payload.mode || '(none)'} confidence=${payload.confidence.toFixed(2)} reason=${payload.reason}`);
      this.logRuntimeEvent('ignore_activate', this.active, {
        mode: payload.mode,
        confidence: payload.confidence,
        reason: payload.reason,
      });
      return;
    }

    const definition = getPromptModeDefinition(payload.mode, this.promptsDir);
    if (!definition) {
      Logger.warning(`[prompt-mode-runtime] ignored unknown prompt mode "${payload.mode || ''}" from router`);
      this.logRuntimeEvent('ignore_unknown_mode', this.active, {
        mode: payload.mode,
        confidence: payload.confidence,
        reason: payload.reason,
      });
      return;
    }

    const previous = this.active?.mode === definition.id
      ? this.active
      : null;
    this.active = {
      mode: definition.id,
      title: definition.title,
      confidence: payload.confidence,
      reason: payload.reason,
      activatedTurn: previous
        ? previous.activatedTurn
        : turnNumber,
      updatedTurn: turnNumber,
      sourceTiming: payload.sourceTiming,
      originTurn: payload.originTurn,
      appliedTurn: turnNumber,
      instructionsInjectedTurn: previous?.instructionsInjectedTurn,
    };
    Logger.info(`[prompt-mode-runtime] active mode=${definition.id} confidence=${payload.confidence.toFixed(2)} reason=${payload.reason}`);
    this.logRuntimeEvent('activate', this.active, {
      fullPromptRefreshInterval: this.fullPromptRefreshInterval,
      turnsUntilFullPromptRefresh: this.getTurnsUntilFullPromptRefresh(turnNumber),
    });
  }

  buildTransientMessage(options: {
    turnNumber?: number;
    fixedMode?: FixedPromptModeState;
  } = {}): Message | null {
    const turnNumber = options.turnNumber ?? this.currentTurn;
    if (options.fixedMode) return null;
    if (!this.active) return null;

    const includeInstructions = this.shouldInjectFullInstructions(turnNumber);
    const content = includeInstructions
      ? loadPromptModePrompt(this.promptsDir, this.active.mode)
      : null;
    if (includeInstructions) {
      if (!content) {
        Logger.warning(`[prompt-mode-runtime] active mode "${this.active.mode}" is unreadable; clearing`);
        this.active = null;
        return null;
      }
      this.active.instructionsInjectedTurn = turnNumber;
    }

    return {
      role: 'system',
      content: [
        TRANSIENT_ACTIVE_PROMPT_MODE_PREFIX,
        `Active prompt mode: ${this.active.mode} (${this.active.title}).`,
        `Selected asynchronously by runtime mode router with confidence ${this.active.confidence.toFixed(2)}.`,
        `Reason: ${this.active.reason}`,
        this.formatModeTimingLine(this.active, turnNumber),
        `Full mode instructions refresh every ${this.fullPromptRefreshInterval} active turn(s).`,
        'Apply this mode where it fits the current user request. If the user has clearly changed topic, follow the user and do not force this mode.',
        'If the user explicitly asks to leave or disable this mode, stop applying the active mode and answer the user normally.',
        ...(
          content
            ? ['', content]
            : [
              `Full mode instructions were already supplied on turn ${this.active.instructionsInjectedTurn}.`,
              `Turns until next full refresh: ${this.getTurnsUntilFullPromptRefresh(turnNumber)}.`,
              'This is only a short status reminder; do not explain it to the user.',
            ]
        ),
      ].join('\n'),
    };
  }

  private shouldInjectFullInstructions(turnNumber: number): boolean {
    if (!this.active) return false;
    return this.active.instructionsInjectedTurn === undefined
      || this.active.instructionsInjectedTurn === turnNumber
      || turnNumber - this.active.instructionsInjectedTurn >= this.fullPromptRefreshInterval;
  }

  private formatModeTimingLine(state: PromptModeRuntimeState, turnNumber: number): string {
    if (state.sourceTiming === 'late_previous_turn') {
      const origin = state.originTurn !== undefined ? ` turn ${state.originTurn}` : ' the previous user turn';
      return `Timing: selected from${origin} and arrived late; apply it only if the current request continues that thread.`;
    }
    if (state.sourceTiming === 'current_turn') {
      return `Timing: selected for the current user turn ${turnNumber}.`;
    }
    return 'Timing: selected asynchronously; apply it only where it fits the current user request.';
  }

  private logRuntimeEvent(
    action: string,
    state: PromptModeRuntimeState | null,
    extra: Record<string, unknown> = {},
  ): void {
    Logger.runtimeEvent(
      'INFO',
      `[prompt-mode-runtime] ${action}${state ? ` mode=${state.mode}` : ''}`,
      {
        type: 'prompt_mode_runtime',
        payload: {
          action,
          activeMode: state ? {
            mode: state.mode,
            title: state.title,
            confidence: state.confidence,
            reason: state.reason,
            activatedTurn: state.activatedTurn,
            updatedTurn: state.updatedTurn,
            sourceTiming: state.sourceTiming,
            originTurn: state.originTurn,
            appliedTurn: state.appliedTurn,
            instructionsInjectedTurn: state.instructionsInjectedTurn,
          } : null,
          ...extra,
        },
      },
    );
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
    ...extractPromptModeObservationTiming(observation),
  };
}

function extractPromptModeObservationTiming(
  observation: SyntheticObservation,
): Pick<PromptModeRouterFinishPayload, 'sourceTiming' | 'originTurn'> {
  const rawTiming = observation.metadata?.timing ?? observation.timing;
  const sourceTiming = rawTiming === 'current_turn' || rawTiming === 'late_previous_turn'
    ? rawTiming
    : undefined;
  const rawOriginTurn = observation.metadata?.originTurn;
  const originTurn = typeof rawOriginTurn === 'number' && Number.isFinite(rawOriginTurn)
    ? rawOriginTurn
    : undefined;
  return {
    ...(sourceTiming ? { sourceTiming } : {}),
    ...(originTurn !== undefined ? { originTurn } : {}),
  };
}
