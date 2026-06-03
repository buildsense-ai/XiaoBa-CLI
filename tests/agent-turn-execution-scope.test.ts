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
  assert.match(agentSessionSource, /localDeviceGrant\?:\s*ScopedLocalDeviceGrant/);
  assert.match(agentSessionSource, /localDeviceGrant\s*=\s*opts\.localDeviceGrant/);
  assert.match(agentSessionSource, /localFileGrants\?:\s*ScopedLocalFileGrant\[\]/);
  assert.match(agentSessionSource, /localFileGrants\s*=\s*opts\.localFileGrants/);
});

test('AgentTurnController forwards executionScope into ToolExecutionContext', () => {
  assert.match(agentTurnSource, /executionScope\?:\s*ExecutionScope/);
  assert.match(agentTurnSource, /localDeviceGrant\?:\s*ScopedLocalDeviceGrant/);
  assert.match(agentTurnSource, /localFileGrants\?:\s*ScopedLocalFileGrant\[\]/);
  assert.match(agentTurnSource, /executionScope:\s*params\.executionScope/);
  assert.match(agentTurnSource, /executionScope:\s*options\.executionScope/);
  assert.match(agentTurnSource, /localDeviceGrant:\s*params\.localDeviceGrant/);
  assert.match(agentTurnSource, /localDeviceGrant:\s*options\.localDeviceGrant/);
  assert.match(agentTurnSource, /localFileGrants:\s*params\.localFileGrants/);
  assert.match(agentTurnSource, /localFileGrants:\s*options\.localFileGrants/);
});

test('ToolExecutionContext exposes executionScope for future ToolGateway checks', () => {
  assert.match(toolTypesSource, /executionScope\?:\s*ExecutionScope/);
  assert.match(toolTypesSource, /localDeviceGrant\?:\s*ScopedLocalDeviceGrant/);
  assert.match(toolTypesSource, /localFileGrants\?:\s*ScopedLocalFileGrant\[\]/);
});
