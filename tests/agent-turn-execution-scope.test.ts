import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const agentSessionSource = readFileSync(join(process.cwd(), 'src/core/agent-session.ts'), 'utf-8');
const agentTurnSource = readFileSync(join(process.cwd(), 'src/core/agent-turn-controller.ts'), 'utf-8');
const toolTypesSource = readFileSync(join(process.cwd(), 'src/types/tool.ts'), 'utf-8');

test('AgentSession accepts executionScope in HandleMessageOptions', () => {
  assert.match(agentSessionSource, /executionScope\?:\s*ExecutionScope/);
  assert.match(agentSessionSource, /executionScope\s*=\s*opts\.executionScope/);
  assert.match(agentSessionSource, /executionScope,\s*\n\s*pendingUserInputProvider/);
});

test('AgentTurnController forwards executionScope into ToolExecutionContext', () => {
  assert.match(agentTurnSource, /executionScope\?:\s*ExecutionScope/);
  assert.match(agentTurnSource, /executionScope:\s*params\.executionScope/);
  assert.match(agentTurnSource, /executionScope:\s*options\.executionScope/);
});

test('ToolExecutionContext exposes executionScope for future ToolGateway checks', () => {
  assert.match(toolTypesSource, /executionScope\?:\s*ExecutionScope/);
});
