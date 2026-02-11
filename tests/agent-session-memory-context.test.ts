import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession, AgentServices } from '../src/core/agent-session';
import { SkillManager } from '../src/skills/skill-manager';

test('agent session should not persist transient memory context into history', async () => {
  const capturedMessageBatches: any[][] = [];

  const aiService = {
    async chat() {
      return { content: 'ok' };
    },
    async chatStream(messages: any[]) {
      capturedMessageBatches.push(messages);
      return { content: 'ok' };
    },
  } as any;

  const toolManager = {
    getToolDefinitions() {
      return [];
    },
    async executeTool() {
      throw new Error('executeTool should not be called in this test');
    },
  } as any;

  const memoryService = {
    async searchMemory() {
      return [{ text: '之前讨论过 Engram 的核心贡献' }];
    },
    formatMemoriesAsContext() {
      return '=== 相关历史记忆 ===\n1. 之前讨论过 Engram 的核心贡献\n=== 记忆结束 ===\n';
    },
  } as any;

  const services: AgentServices = {
    aiService,
    toolManager,
    skillManager: new SkillManager(),
    memoryService,
  };

  const session = new AgentSession('user:test', services);
  await session.handleMessage('帮我继续完善精读PPT');

  assert.equal(capturedMessageBatches.length, 1);
  const injectedInRequest = capturedMessageBatches[0].some(
    (msg) => msg.role === 'system' && typeof msg.content === 'string' && msg.content.startsWith('[transient_memory_context]'),
  );
  assert.equal(injectedInRequest, true);

  const persistedInHistory = session.getMessages().some(
    (msg) => msg.role === 'system' && typeof msg.content === 'string' && msg.content.startsWith('[transient_memory_context]'),
  );
  assert.equal(persistedInHistory, false);
});
