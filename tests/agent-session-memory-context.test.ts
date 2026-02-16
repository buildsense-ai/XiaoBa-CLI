import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession, AgentServices } from '../src/core/agent-session';
import { SkillManager } from '../src/skills/skill-manager';
import { GauzMemService } from '../src/utils/gauzmem-service';

test('agent session should not persist transient memory context into history', async () => {
  const capturedMessageBatches: any[][] = [];

  const aiService = {
    async chat() {
      return { content: 'ok' };
    },
    async chatStream(messages: any[]) {
      capturedMessageBatches.push([...messages]);
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

  // Mock GauzMem 单例：recall 返回记忆文本，writeMessage 静默成功
  const gauzMem = GauzMemService.getInstance();
  const origIsAvailable = gauzMem.isAvailable.bind(gauzMem);
  const origRecall = gauzMem.recall.bind(gauzMem);
  const origWrite = gauzMem.writeMessage.bind(gauzMem);

  (gauzMem as any).isAvailable = () => true;
  (gauzMem as any).recall = async () => '之前讨论过 Engram 的核心贡献';
  (gauzMem as any).writeMessage = async () => {};

  const services: AgentServices = {
    aiService,
    toolManager,
    skillManager: new SkillManager(),
  };

  try {
    const session = new AgentSession('user:test', services);
    await session.handleMessage('帮我继续完善精读PPT');

    assert.equal(capturedMessageBatches.length, 1);

    // 验证 recall 结果被注入到了发给 AI 的消息中
    const injectedInRequest = capturedMessageBatches[0].some(
      (msg) => msg.role === 'system' && typeof msg.content === 'string' && msg.content.includes('[long_term_memory]'),
    );
    assert.equal(injectedInRequest, true, 'recall 结果应被注入到 AI 请求中');

    // 验证 transient 消息不会持久化到历史
    const persistedInHistory = session.getMessages().some(
      (msg) => msg.role === 'system' && typeof msg.content === 'string' && msg.content.includes('[long_term_memory]'),
    );
    assert.equal(persistedInHistory, false, 'transient 记忆不应持久化到历史');
  } finally {
    // 恢复原始方法
    (gauzMem as any).isAvailable = origIsAvailable;
    (gauzMem as any).recall = origRecall;
    (gauzMem as any).writeMessage = origWrite;
  }
});
