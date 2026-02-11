interface PlanModeState {
  planFilePath: string;
  inPlanMode: boolean;
}

export class PlanModeStore {
  private static states: Map<string, PlanModeState> = new Map();

  static get(sessionId: string): PlanModeState {
    if (!this.states.has(sessionId)) {
      this.states.set(sessionId, {
        planFilePath: '',
        inPlanMode: false,
      });
    }
    return this.states.get(sessionId)!;
  }

  static enter(sessionId: string, planFilePath: string): void {
    this.states.set(sessionId, {
      planFilePath,
      inPlanMode: true,
    });
  }

  static exit(sessionId: string): void {
    this.states.set(sessionId, {
      planFilePath: '',
      inPlanMode: false,
    });
  }
}

