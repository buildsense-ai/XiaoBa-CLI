import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentSession } from '../src/core/agent-session';

test('resume retries a blocked checkpoint without clearing history', async () => {
  const session = new AgentSession('user:resume-checkpoint', buildServices(), 'catscompany');
  const original = [{ role: 'user', content: '完整历史' }];
  (session as any).messages = original;
  (session as any).checkpointBlockedReason = 'checkpoint_authentication';
  (session as any).checkpointCompactionCoordinator.compactIfNeeded = async () => ({
    compacted: true,
    messages: [{ role: 'user', content: 'checkpoint summary' }],
  });
  (session as any).persistCheckpoint = () => true;

  assert.equal(await session.resumeCheckpoint(), true);
  assert.equal((session as any).checkpointBlockedReason, null);
  assert.equal((session as any).messages[0].content, 'checkpoint summary');
});

test('/resume command reports success and preserves the session history', async () => {
  const session = new AgentSession('user:resume-command', buildServices(), 'catscompany');
  (session as any).messages = [{ role: 'user', content: '命令恢复历史' }];
  (session as any).checkpointBlockedReason = 'checkpoint_authentication';
  (session as any).checkpointCompactionCoordinator.compactIfNeeded = async () => ({
    compacted: true,
    messages: [{ role: 'user', content: '命令恢复摘要' }],
  });
  (session as any).persistCheckpoint = () => true;
  const result = await session.handleCommand('resume', []);
  assert.equal(result.handled, true);
  assert.match(result.reply || '', /会话已恢复/);
  assert.equal((session as any).messages[0].content, '命令恢复摘要');
});

test('resume catches checkpoint exceptions and remains fail closed', async () => {
  const session = new AgentSession('user:resume-exception', buildServices(), 'catscompany');
  (session as any).messages = [{ role: 'user', content: '原始历史' }];
  (session as any).checkpointBlockedReason = 'checkpoint_authentication';
  (session as any).checkpointCompactionCoordinator.compactIfNeeded = async () => { throw new Error('provider down'); };
  assert.equal(await session.resumeCheckpoint(), false);
  assert.equal((session as any).checkpointBlockedReason, 'CONTEXT_CHECKPOINT_BLOCKED');
  assert.equal((session as any).messages[0].content, '原始历史');
});

test('resume clears the block and the next user turn reaches the main model', async () => {
  let mainCalls = 0;
  const services = buildServices();
  services.aiService = {
    async chatStream() { mainCalls++; return { content: '继续完成', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }; },
  };
  const session = new AgentSession('user:resume-continues', services, 'catscompany');
  (session as any).messages = [{ role: 'user', content: '原始历史' }];
  (session as any).checkpointBlockedReason = 'checkpoint_authentication';
  (session as any).checkpointCompactionCoordinator.compactIfNeeded = async () => ({ compacted: true, messages: [{ role: 'user', content: '恢复摘要' }] });
  (session as any).persistCheckpoint = () => true;
  assert.equal(await session.resumeCheckpoint(), true);
  const result = await session.handleMessage('继续执行');
  assert.equal(result.text, '继续完成');
  assert.equal(mainCalls, 1);
});

test('resume is invalidated by concurrent reset and cannot clear the lifecycle block', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const session = new AgentSession('user:resume-reset-race', buildServices(), 'catscompany');
  (session as any).messages = [{ role: 'user', content: '保留历史' }];
  (session as any).checkpointBlockedReason = 'checkpoint_authentication';
  (session as any).checkpointCompactionCoordinator.compactIfNeeded = async () => { await gate; return { compacted: true, messages: [{ role: 'user', content: '过期摘要' }] }; };
  (session as any).persistCheckpoint = () => true;
  const pending = session.resumeCheckpoint();
  await new Promise(resolve => setImmediate(resolve));
  session.reset();
  release();
  assert.equal(await pending, false);
  assert.equal((session as any).checkpointBlockedReason, null);
  assert.deepEqual((session as any).messages, []);
});

test('resume is invalidated by concurrent clear and does not restore stale messages', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const session = new AgentSession('user:resume-clear-race', buildServices(), 'catscompany');
  (session as any).messages = [{ role: 'user', content: '旧历史' }];
  (session as any).checkpointBlockedReason = 'checkpoint_authentication';
  (session as any).checkpointCompactionCoordinator.compactIfNeeded = async () => { await gate; return { compacted: true, messages: [{ role: 'user', content: '旧摘要' }] }; };
  (session as any).persistCheckpoint = () => true;
  const pending = session.resumeCheckpoint();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.clear(), true);
  release();
  assert.equal(await pending, false);
  assert.deepEqual((session as any).messages, []);
});

test('resume remains fail closed when checkpoint cannot be created', async () => {
  const session = new AgentSession('user:resume-failure', buildServices(), 'catscompany');
  (session as any).messages = [{ role: 'user', content: '保留我' }];
  (session as any).getContextUsageInfo = () => ({ usedTokens: 90, toolTokens: 0, maxTokens: 100, usagePercent: 90 });
  (session as any).checkpointBlockedReason = 'checkpoint_authentication';
  (session as any).checkpointCandidateCoordinator.compactIfNeeded = async () => ({ compacted: false, messages: (session as any).messages });

  assert.equal(await session.resumeCheckpoint(), false);
  assert.equal((session as any).checkpointBlockedReason, 'CONTEXT_CHECKPOINT_BLOCKED');
  assert.equal((session as any).messages[0].content, '保留我');
});

function buildServices(): any {
  return {
    aiService: {},
    toolManager: { getToolDefinitions() { return []; }, getWorkspaceRoot() { return process.cwd(); } },
    skillManager: {
      getSkill() { return undefined; }, getUserInvocableSkills() { return []; }, getAutoInvocableSkills() { return []; },
      findAutoInvocableSkillByText() { return undefined; }, loadSkills: async () => {},
    },
  };
}
