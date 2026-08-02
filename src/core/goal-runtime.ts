import { renderRequiredDefaultPromptFile } from '../utils/prompt-template';

export type RuntimeGoalStatus = 'active' | 'completed' | 'blocked';

export interface RuntimeGoalSnapshot {
  revision: number;
  updatedAt: number;
  objective: string;
  status: RuntimeGoalStatus;
}

export interface UpdateGoalInput {
  objective?: string;
  status?: RuntimeGoalStatus;
  clear?: boolean;
}

export interface PersistedRuntimeGoalState {
  revision: number;
  updatedAt: number;
  objective: string;
  status: RuntimeGoalStatus;
}

const VALID_STATUSES = new Set<RuntimeGoalStatus>(['active', 'completed', 'blocked']);
const MAX_OBJECTIVE_LENGTH = 12_000;

/** Trusted session-scoped objective state supplied by a runtime/control plane. */
export class GoalRuntime {
  private revision = 0;
  private updatedAt = 0;
  private objective = '';
  private status: RuntimeGoalStatus = 'active';

  constructor(initial?: unknown) {
    const restored = normalizePersistedGoal(initial);
    if (!restored) return;
    this.revision = restored.revision;
    this.updatedAt = restored.updatedAt;
    this.objective = restored.objective;
    this.status = restored.status;
  }

  update(input: UpdateGoalInput): RuntimeGoalSnapshot {
    if (input.clear) return this.clear();

    const objective = input.objective === undefined
      ? this.objective
      : String(input.objective).trim();
    const status = input.status ?? (this.objective ? this.status : 'active');
    if (!objective) throw new Error('update_goal 需要提供非空 objective，或设置 clear=true');
    if (objective.length > MAX_OBJECTIVE_LENGTH) {
      throw new Error(`update_goal objective 不能超过 ${MAX_OBJECTIVE_LENGTH} 个字符`);
    }
    if (!VALID_STATUSES.has(status)) throw new Error(`update_goal status 无效：${status}`);

    this.objective = objective;
    this.status = status;
    this.revision += 1;
    this.updatedAt = Date.now();
    return this.getSnapshot();
  }

  clear(): RuntimeGoalSnapshot {
    this.objective = '';
    this.status = 'active';
    this.revision += 1;
    this.updatedAt = Date.now();
    return this.getSnapshot();
  }

  restore(snapshot: unknown): RuntimeGoalSnapshot {
    const restored = normalizePersistedGoal(snapshot);
    if (!restored) {
      this.revision = 0;
      this.updatedAt = 0;
      this.objective = '';
      this.status = 'active';
      return this.getSnapshot();
    }
    this.revision = restored.revision;
    this.updatedAt = restored.updatedAt;
    this.objective = restored.objective;
    this.status = restored.status;
    return this.getSnapshot();
  }

  getSnapshot(): RuntimeGoalSnapshot {
    return {
      revision: this.revision,
      updatedAt: this.updatedAt,
      objective: this.objective,
      status: this.status,
    };
  }

  hasGoal(): boolean {
    return this.objective.length > 0;
  }

  formatForPrompt(): string | undefined {
    if (!this.objective) return undefined;
    return renderRequiredDefaultPromptFile('transient/goal-status.md', {
      objective: this.objective,
      status: this.status,
    });
  }
}

function normalizePersistedGoal(value: unknown): PersistedRuntimeGoalState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const objective = typeof record.objective === 'string' ? record.objective.trim() : '';
  const status = record.status as RuntimeGoalStatus;
  const revision = Number(record.revision);
  const updatedAt = Number(record.updatedAt);
  if (
    !objective
    || objective.length > MAX_OBJECTIVE_LENGTH
    || !VALID_STATUSES.has(status)
    || !Number.isSafeInteger(revision)
    || revision < 1
    || !Number.isFinite(updatedAt)
    || updatedAt <= 0
  ) return undefined;
  return { objective, status, revision, updatedAt };
}
