/**
 * 多平台会话 + 安全控制测试套件
 *
 * 覆盖：
 * 1. Session key 路由（CLI / 飞书 / CatsCompany / bridge）
 * 2. 并发保护（busy 状态）
 * 3. 会话生命周期（clear / summarizeAndDestroy）
 * 4. 内置命令处理（/clear / /skills / /history / /exit）
 * 5. 工具别名映射
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession, AgentServices, BUSY_MESSAGE } from '../src/core/agent-session';
import { SkillManager } from '../src/skills/skill-manager';
import { GauzMemService } from '../src/utils/gauzmem-service';

// ─── 辅助 ──────────────────────────────────────────────

function disableGauzMem() {
  const gauzMem = GauzMemService.getInstance();
  const orig = gauzMem.isAvailable.bind(gauzMem);
  (gauzMem as any).isAvailable = () => false;
  return () => { (gauzMem as any).isAvailable = orig; };
}

function buildServices(opts?: {
  onChatStream?: (messages: any[]) => void;
  chatDelay?: number;
}): AgentServices {
  return {
    aiService: {
      async chat() { return { content: 'ok' }; },
      async chatStream(messages: any[]) {
        opts?.onChatStream?.(messages);
        if (opts?.chatDelay) {
          await new Promise(r => setTimeout(r, opts.chatDelay));
        }
        return { content: 'ok' };
      },
    } as any,
    toolManager: {
      getToolDefinitions() { return []; },
      async executeTool() { throw new Error('should not be called'); },
    } as any,
    skillManager: new SkillManager(),
  };
}

// ═══════════════════════════════════════════════════════
// 1. Session key → platformId 路由
// ═══════════════════════════════════════════════════════

test('session derives platformId=cli for cli key', () => {
  const restore = disableGauzMem();
  try {
    const session = new AgentSession('cli', buildServices());
    assert.equal(session.platformId, 'cli');
  } finally {
    restore();
  }
});

test('session derives platformId=feishu for user: key', () => {
  const restore = disableGauzMem();
  try {
    const session = new AgentSession('user:ou_abc123', buildServices());
    assert.equal(session.platformId, 'feishu');
  } finally {
    restore();
  }
});

test('session derives platformId=feishu for group: key', () => {
  const restore = disableGauzMem();
  try {
    const session = new AgentSession('group:oc_xyz789', buildServices());
    assert.equal(session.platformId, 'feishu');
  } finally {
    restore();
  }
});

test('session derives platformId=catscompany for cc_user: key', () => {
  const restore = disableGauzMem();
  try {
    const session = new AgentSession('cc_user:cats123', buildServices());
    assert.equal(session.platformId, 'catscompany');
  } finally {
    restore();
  }
});

test('session derives platformId=catscompany for cc_group: key', () => {
  const restore = disableGauzMem();
  try {
    const session = new AgentSession('cc_group:cats456', buildServices());
    assert.equal(session.platformId, 'catscompany');
  } finally {
    restore();
  }
});

test('session derives platformId=bridge for bridge: key', () => {
  const restore = disableGauzMem();
  try {
    const session = new AgentSession('bridge:ext-001', buildServices());
    assert.equal(session.platformId, 'bridge');
  } finally {
    restore();
  }
});

test('session derives platformId=unknown for unrecognized key', () => {
  const restore = disableGauzMem();
  try {
    const session = new AgentSession('random:something', buildServices());
    assert.equal(session.platformId, 'unknown');
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════════════
// 2. 并发保护
// ═══════════════════════════════════════════════════════

test('session returns busy message when already processing', async () => {
  const restore = disableGauzMem();
  try {
    const session = new AgentSession('cli', buildServices({ chatDelay: 200 }));

    // 发起第一个请求（不 await）
    const first = session.handleMessage('first');

    // 立即发起第二个请求
    await new Promise(r => setTimeout(r, 10));
    const second = await session.handleMessage('second');

    assert.equal(second, BUSY_MESSAGE);

    // 等第一个完成
    const firstResult = await first;
    assert.equal(firstResult, 'ok');
  } finally {
    restore();
  }
});

test('session is not busy after message completes', async () => {
  const restore = disableGauzMem();
  try {
    const session = new AgentSession('cli', buildServices());
    await session.handleMessage('first');
    assert.equal(session.isBusy(), false);

    const second = await session.handleMessage('second');
    assert.equal(second, 'ok');
  } finally {
    restore();
  }
});

test('session is not busy after error', async () => {
  const restore = disableGauzMem();
  try {
    const services = buildServices();
    (services.aiService as any).chatStream = async () => { throw new Error('boom'); };

    const session = new AgentSession('cli', services);
    const result = await session.handleMessage('will fail');

    assert.ok(result.includes('出错'), '应返回错误消息');
    assert.equal(session.isBusy(), false, '错误后应释放 busy 锁');
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════════════
// 3. 会话生命周期
// ═══════════════════════════════════════════════════════

test('session clear resets all state', async () => {
  const restore = disableGauzMem();
  try {
    const session = new AgentSession('cli', buildServices());
    await session.handleMessage('hello');
    assert.ok(session.getHistoryLength() > 0);

    session.clear();
    assert.equal(session.getHistoryLength(), 0);
  } finally {
    restore();
  }
});

test('session summarizeAndDestroy clears messages', async () => {
  const restore = disableGauzMem();
  try {
    const session = new AgentSession('cli', buildServices());
    await session.handleMessage('hello');

    const hadMessages = await session.summarizeAndDestroy();
    assert.equal(hadMessages, true);
    assert.equal(session.getHistoryLength(), 0);
  } finally {
    restore();
  }
});

test('session summarizeAndDestroy returns false when empty', async () => {
  const restore = disableGauzMem();
  try {
    const session = new AgentSession('cli', buildServices());
    const hadMessages = await session.summarizeAndDestroy();
    assert.equal(hadMessages, false);
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════════════
// 4. 内置命令
// ═══════════════════════════════════════════════════════

test('session handles /clear command', async () => {
  const restore = disableGauzMem();
  try {
    const session = new AgentSession('cli', buildServices());
    await session.handleMessage('hello');

    const result = await session.handleCommand('clear', []);
    assert.equal(result.handled, true);
    assert.ok(result.reply?.includes('清空'));
    assert.equal(session.getHistoryLength(), 0);
  } finally {
    restore();
  }
});

test('session handles /history command', async () => {
  const restore = disableGauzMem();
  try {
    const session = new AgentSession('cli', buildServices());
    await session.handleMessage('hello');

    const result = await session.handleCommand('history', []);
    assert.equal(result.handled, true);
    assert.ok(result.reply?.includes('对话历史'));
  } finally {
    restore();
  }
});

test('session handles /skills command', async () => {
  const restore = disableGauzMem();
  try {
    const session = new AgentSession('cli', buildServices());
    const result = await session.handleCommand('skills', []);
    assert.equal(result.handled, true);
    // 可能有 skills 也可能没有，但命令应该被处理
    assert.ok(result.reply);
  } finally {
    restore();
  }
});

test('session handles /exit command', async () => {
  const restore = disableGauzMem();
  try {
    const session = new AgentSession('cli', buildServices());
    await session.handleMessage('hello');

    const result = await session.handleCommand('exit', []);
    assert.equal(result.handled, true);
    assert.ok(result.reply?.includes('再见'));
    assert.equal(session.getHistoryLength(), 0);
  } finally {
    restore();
  }
});

test('session returns handled=false for unknown command', async () => {
  const restore = disableGauzMem();
  try {
    const session = new AgentSession('cli', buildServices());
    const result = await session.handleCommand('nonexistent', []);
    assert.equal(result.handled, false);
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════════════
// 5. 飞书/CatsCompany 会话注入 surface 提示
// ═══════════════════════════════════════════════════════

test('feishu session injects surface:feishu system message', async () => {
  const restore = disableGauzMem();
  try {
    const capturedMessages: any[][] = [];
    const services = buildServices({
      onChatStream: (msgs) => capturedMessages.push([...msgs]),
    });
    const session = new AgentSession('user:feishu-user', services);
    await session.handleMessage('hello');

    const msgs = capturedMessages[0];
    const surfaceMsg = msgs.find(
      (m: any) => m.role === 'system' && m.content?.includes('[surface:feishu]'),
    );
    assert.ok(surfaceMsg, '飞书会话应注入 surface:feishu 系统消息');
    assert.ok(surfaceMsg.content.includes('send_message'), '应提示使用 send_message 工具');
  } finally {
    restore();
  }
});

test('catscompany session injects surface:catscompany system message', async () => {
  const restore = disableGauzMem();
  try {
    const capturedMessages: any[][] = [];
    const services = buildServices({
      onChatStream: (msgs) => capturedMessages.push([...msgs]),
    });
    const session = new AgentSession('cc_user:cats-user', services);
    await session.handleMessage('hello');

    const msgs = capturedMessages[0];
    const surfaceMsg = msgs.find(
      (m: any) => m.role === 'system' && m.content?.includes('[surface:catscompany]'),
    );
    assert.ok(surfaceMsg, 'CatsCompany 会话应注入 surface:catscompany 系统消息');
  } finally {
    restore();
  }
});

test('cli session does not inject surface system message', async () => {
  const restore = disableGauzMem();
  try {
    const capturedMessages: any[][] = [];
    const services = buildServices({
      onChatStream: (msgs) => capturedMessages.push([...msgs]),
    });
    const session = new AgentSession('cli', services);
    await session.handleMessage('hello');

    const msgs = capturedMessages[0];
    const surfaceMsg = msgs.find(
      (m: any) => m.role === 'system' && m.content?.includes('[surface:'),
    );
    assert.equal(surfaceMsg, undefined, 'CLI 会话不应注入 surface 系统消息');
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════════════
// 6. runId 正确传递
// ═══════════════════════════════════════════════════════

test('session runId equals session key', () => {
  const restore = disableGauzMem();
  try {
    const session = new AgentSession('group:oc_test', buildServices());
    assert.equal(session.runId, 'group:oc_test');
  } finally {
    restore();
  }
});
