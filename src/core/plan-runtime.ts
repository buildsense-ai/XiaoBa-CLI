export type PlanStepStatus = 'pending' | 'in_progress' | 'completed';

export interface RuntimePlanStep {
  text: string;
  status: PlanStepStatus;
}

export interface RuntimePlanSnapshot {
  revision: number;
  updatedAt: number;
  steps: RuntimePlanStep[];
}

export interface UpdatePlanInput {
  steps?: RuntimePlanStep[];
  clear?: boolean;
}

const VALID_STATUSES = new Set<PlanStepStatus>(['pending', 'in_progress', 'completed']);

export class PlanRuntime {
  private revision = 0;
  private updatedAt = 0;
  private steps: RuntimePlanStep[] = [];

  update(input: UpdatePlanInput): RuntimePlanSnapshot {
    if (input.clear) {
      return this.clear();
    }

    const steps = normalizeSteps(input.steps);

    this.steps = steps;
    this.revision += 1;
    this.updatedAt = Date.now();
    return this.getSnapshot();
  }

  clear(): RuntimePlanSnapshot {
    this.steps = [];
    this.revision += 1;
    this.updatedAt = Date.now();
    return this.getSnapshot();
  }

  getSnapshot(): RuntimePlanSnapshot {
    return {
      revision: this.revision,
      updatedAt: this.updatedAt,
      steps: this.steps.map(step => ({ ...step })),
    };
  }

  hasPlan(): boolean {
    return this.steps.length > 0;
  }

  formatForPrompt(): string | undefined {
    if (this.steps.length === 0) return undefined;
    const lines = this.steps.map((step, index) => {
      const marker = step.status === 'completed'
        ? '[completed]'
        : step.status === 'in_progress'
          ? '[in_progress]'
          : '[pending]';
      return `${index + 1}. ${marker} ${step.text}`;
    });
    return [
      '当前运行时计划：',
      ...lines,
      '',
      '这是当前任务的临时计划状态，不是用户的新需求。继续推进时请保持计划准确；小任务不需要维护计划。',
    ].join('\n');
  }
}

function normalizeSteps(rawSteps: RuntimePlanStep[] | undefined): RuntimePlanStep[] {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new Error('update_plan 需要提供非空 steps 数组，或设置 clear=true');
  }

  return rawSteps.map((raw, index) => {
    const text = String(raw?.text || '').trim();
    const status = String(raw?.status || 'pending') as PlanStepStatus;
    if (!text) {
      throw new Error(`第 ${index + 1} 个计划步骤缺少 text`);
    }
    if (!VALID_STATUSES.has(status)) {
      throw new Error(`第 ${index + 1} 个计划步骤 status 无效：${status}`);
    }
    return {
      text,
      status,
    };
  });
}
