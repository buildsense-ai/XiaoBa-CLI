import test from 'node:test';
import assert from 'node:assert/strict';
import { SubAgentManager } from '../src/core/sub-agent-manager';
import { AgentManager } from '../src/agents/agent-manager';

test('subagent manager enforces parent session ownership', () => {
  const manager = SubAgentManager.getInstance() as any;
  manager.subAgents.clear();
  manager.parentMap.clear();

  let stopped = false;
  let status = 'running';
  const fake = {
    status,
    stop: () => {
      stopped = true;
      status = 'stopped';
      fake.status = status;
    },
    getInfo: () => ({
      id: 'sub-test',
      skillName: 'paper-analysis',
      taskDescription: 'test task',
      status,
      createdAt: Date.now(),
      progressLog: [],
    }),
  };

  manager.subAgents.set('sub-test', fake);
  manager.parentMap.set('sub-test', 'session-a');

  assert.equal(manager.getInfoForParent('session-b', 'sub-test'), undefined);
  assert.equal(manager.stopForParent('session-b', 'sub-test'), 'forbidden');
  assert.equal(stopped, false);

  assert.equal(manager.stopForParent('session-a', 'sub-test'), 'stopped');
  assert.equal(stopped, true);

  manager.subAgents.clear();
  manager.parentMap.clear();
});

test('agent manager enforces owner session isolation', () => {
  const manager = AgentManager.getInstance() as any;
  manager.agents.clear();
  manager.ownerByAgentId.clear();

  const fakeAgent = {
    id: 'agent-test',
    type: 'general-purpose',
    status: 'running',
    config: {},
    execute: async () => ({ agentId: 'agent-test', status: 'completed', output: '' }),
    stop: async () => {},
    getOutput: () => 'ok',
  };

  manager.agents.set('agent-test', fakeAgent);
  manager.ownerByAgentId.set('agent-test', 'session-a');

  assert.equal(manager.getAgentForOwner('agent-test', 'session-b'), undefined);
  assert.equal(manager.getAgentForOwner('agent-test', 'session-a'), fakeAgent);

  manager.agents.clear();
  manager.ownerByAgentId.clear();
});

