import type { ToolSurface } from '../types/tool';

export type VisibleProgressEventType =
  | 'turn_started'
  | 'model_prelude'
  | 'tool_started'
  | 'tool_finished'
  | 'runtime_status'
  | 'retry';

export interface VisibleProgressEvent {
  type: VisibleProgressEventType;
  text?: string;
  toolName?: string;
  toolDescription?: string;
  ok?: boolean;
  errorCode?: string;
  durationMs?: number;
  resultSummary?: string;
  timestamp?: string;
}

export interface VisibleProgressRecentContextItem {
  role: string;
  content: string;
}

export interface VisibleProgressTurnState {
  emittedCount: number;
  shouldBeConservative: boolean;
  emitAgainPolicy: string;
}

export interface VisibleProgressSnapshot {
  currentUserInput: string;
  surface?: ToolSurface;
  recentContext: VisibleProgressRecentContextItem[];
  emittedProgress: string[];
  turnState: VisibleProgressTurnState;
  events: VisibleProgressEvent[];
}
