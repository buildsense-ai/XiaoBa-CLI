import { TurnLog, AssertionSpec, AssertionResult, ToolCallLog } from './eval-types';

export function runAssertions(turns: TurnLog[], specs: AssertionSpec[]): AssertionResult[] {
  const allToolCalls = turns.flatMap(t => t.targetToolCalls);
  return specs.map(spec => runOne(allToolCalls, spec));
}

function runOne(allCalls: ToolCallLog[], spec: AssertionSpec): AssertionResult {
  switch (spec.type) {
    case 'expect_tool': return expectTool(allCalls, spec);
    case 'expect_tool_pattern': return expectToolPattern(allCalls, spec);
    case 'expect_no_tool': return expectNoTool(allCalls, spec);
  }
}

function expectTool(calls: ToolCallLog[], spec: AssertionSpec): AssertionResult {
  const min = spec.min_calls ?? 1;
  const count = calls.filter(c => c.name === spec.tool).length;
  return {
    spec,
    passed: count >= min,
    detail: `${spec.tool} called ${count} times (min: ${min})`,
  };
}

function expectToolPattern(calls: ToolCallLog[], spec: AssertionSpec): AssertionResult {
  const regex = new RegExp(spec.pattern || '');
  const matched = calls.filter(c => {
    if (c.name !== spec.tool) return false;
    const val = getNestedValue(c.arguments, spec.arg_path || '');
    return typeof val === 'string' && regex.test(val);
  });
  return {
    spec,
    passed: matched.length > 0,
    detail: `${spec.tool}[${spec.arg_path}] matched /${spec.pattern}/ ${matched.length} times`,
  };
}

function expectNoTool(calls: ToolCallLog[], spec: AssertionSpec): AssertionResult {
  const count = calls.filter(c => c.name === spec.tool).length;
  return {
    spec,
    passed: count === 0,
    detail: `${spec.tool} called ${count} times (expected 0)`,
  };
}

function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}
