export interface ToolCallLog {
  name: string;
  arguments: Record<string, any>;
}

export interface TurnLog {
  turn: number;
  testerMessage: string;
  targetToolCalls: ToolCallLog[];
  targetVisibleReply: string[];
  targetFinalAnswer: string;
}

export interface AssertionSpec {
  type: 'expect_tool' | 'expect_tool_pattern' | 'expect_no_tool';
  tool: string;
  min_calls?: number;
  arg_path?: string;
  pattern?: string;
}

export interface AssertionResult {
  spec: AssertionSpec;
  passed: boolean;
  detail: string;
}

export interface JudgeDimension {
  name: string;
  description: string;
  weight: number;
}

export interface JudgeScore {
  dimension: string;
  score: number;
  reasoning: string;
}

export interface EvalSpec {
  version: number;
  target: {
    skill?: string;
    session_key: string;
    max_turns: number;
  };
  tester: {
    system_prompt: string;
    first_message: string;
    done_signal: string;
  };
  judge?: {
    dimensions: JudgeDimension[];
  };
  assertions?: AssertionSpec[];
}

export interface EvalResult {
  timestamp: string;
  specName: string;
  turns: TurnLog[];
  assertions: AssertionResult[];
  judgeScores: JudgeScore[] | null;
  weightedScore: number | null;
}
