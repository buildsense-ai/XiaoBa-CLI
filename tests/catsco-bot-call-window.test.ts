import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { BotCallWindow, isSelfAuthoredBotCallPrompt } from '../src/mcp/bot-call-window';
import {
  CatsCoMcpToolBridge,
  type McpBridgeCallResult,
  type McpBridgeClient,
  type McpBridgeEndpoint,
  type McpBridgeToolInfo,
} from '../src/mcp/mcp-tool-bridge';
import { ToolManager } from '../src/tools/tool-manager';

describe('BotCallWindow', () => {
  test('进入窗口后处于调用中，释放后仍在余韵里，余韵过了才放行', () => {
    let now = 1_000;
    const window = new BotCallWindow(10_000, () => now);

    const leave = window.enter('p2p_982_1619');
    assert.equal(window.isInCall('p2p_982_1619'), true);

    leave();
    now += 5_000; // 还在余韵里：目标 bot 的最后一句常和工具返回几乎同时落库
    assert.equal(window.isInCall('p2p_982_1619'), true);

    now += 6_000; // 超过 10s
    assert.equal(window.isInCall('p2p_982_1619'), false);
  });

  test('同一会话并发两次调用：最后一个释放才关窗', () => {
    const window = new BotCallWindow(0, () => 0);
    const first = window.enter('p2p_1_2');
    const second = window.enter('p2p_1_2');

    first();
    assert.equal(window.isInCall('p2p_1_2'), true, '还有一单在跑，不能关窗');
    second();
    assert.equal(window.isInCall('p2p_1_2'), false);
  });

  test('释放函数幂等：重复调用不会把计数减成负数', () => {
    const window = new BotCallWindow(0, () => 0);
    const leave = window.enter('p2p_1_2');
    const other = window.enter('p2p_1_2');
    leave();
    leave();
    leave();
    assert.equal(window.isInCall('p2p_1_2'), true, '另一单还在，窗口必须还开着');
    other();
    assert.equal(window.isInCall('p2p_1_2'), false);
  });

  test('不同会话互不影响；空 topic 不算窗口', () => {
    const window = new BotCallWindow(0, () => 0);
    const leave = window.enter('p2p_1_2');
    assert.equal(window.isInCall('p2p_3_4'), false);
    assert.equal(window.isInCall(''), false);
    assert.deepEqual(window.activeTopics(), ['p2p_1_2']);
    leave();
    assert.deepEqual(window.activeTopics(), []);
  });
});

class StubClient implements McpBridgeClient {
  constructor(private readonly onCall: (name: string) => McpBridgeCallResult) {}
  async listTools(): Promise<McpBridgeToolInfo[]> {
    return [];
  }
  async callTool(name: string): Promise<McpBridgeCallResult> {
    return this.onCall(name);
  }
  async close(): Promise<void> {
    /* no-op */
  }
}

function createBridge(window: BotCallWindow, onCall: (name: string) => McpBridgeCallResult): CatsCoMcpToolBridge {
  return new CatsCoMcpToolBridge({
    toolManager: new ToolManager(process.cwd(), {}, { enabledToolNames: [] }),
    createClient: () => new StubClient(onCall),
    resolveEndpoint: (): McpBridgeEndpoint => ({ url: 'https://app.catsco.cc/api/mcp', token: 'test-token' }),
    refreshIntervalMs: 0,
    runPollTimeoutMs: 0,
    callWindow: window,
  });
}

describe('CatsCoMcpToolBridge 的调用窗口', () => {
  test('调用期间窗口打开，结束后关闭', async () => {
    const window = new BotCallWindow(0, () => 0);
    let openDuringCall = false;
    const bridge = createBridge(window, () => {
      openDuringCall = window.isInCall('p2p_982_1619');
      return { isError: false, contentText: 'ok' };
    });

    await bridge.executeRemoteTool('catsco_demo', {}, { conversationTopic: 'p2p_982_1619' });

    assert.equal(openDuringCall, true, '调用进行中，这个会话必须处于调用窗口');
    assert.equal(window.isInCall('p2p_982_1619'), false, '调用结束要关窗');
  });

  test('调用抛错也要关窗（否则这个会话永远收不到消息）', async () => {
    const window = new BotCallWindow(0, () => 0);
    const bridge = createBridge(window, () => {
      throw new Error('boom');
    });

    await bridge.executeRemoteTool('catsco_demo', {}, { conversationTopic: 'p2p_982_1619' });

    assert.equal(window.isInCall('p2p_982_1619'), false);
  });

  test('系统工具（catsco_run_status）不开窗', async () => {
    const window = new BotCallWindow(0, () => 0);
    let openDuringCall = true;
    const bridge = createBridge(window, () => {
      openDuringCall = window.isInCall('p2p_982_1619');
      return { isError: false, contentText: 'ok' };
    });

    await bridge.executeRemoteTool('catsco_run_status', { run_id: 'run_x' }, { conversationTopic: 'p2p_982_1619' });

    assert.equal(openDuringCall, false);
  });

  test('没有会话 topic 的调用不开窗', async () => {
    const window = new BotCallWindow(0, () => 0);
    const bridge = createBridge(window, () => ({ isError: false, contentText: 'ok' }));

    await bridge.executeRemoteTool('catsco_demo', {}, {});

    assert.deepEqual(window.activeTopics(), []);
  });
});

describe('isSelfAuthoredBotCallPrompt', () => {
  test('平台代我写的 prompt：标记为真且 caller 就是我', () => {
    assert.equal(
      isSelfAuthoredBotCallPrompt({ catsco_bot_call: true, catsco_caller_uid: 1619 }, 1619),
      true,
    );
    // uid 可能带前缀/是字符串，按数字比较
    assert.equal(
      isSelfAuthoredBotCallPrompt({ catsco_bot_call: 'true', catsco_caller_uid: 'usr1619' }, 1619),
      true,
    );
  });

  test('目标是别人（我是被调用的 bot）：不能标记，否则这个会话再也收不到任务', () => {
    assert.equal(
      isSelfAuthoredBotCallPrompt({ catsco_bot_call: true, catsco_caller_uid: 1619 }, 982),
      false,
    );
  });

  test('没有标记 / 没有 caller / 不知道自己是谁：一律不标记', () => {
    assert.equal(isSelfAuthoredBotCallPrompt({ catsco_caller_uid: 1619 }, 1619), false);
    assert.equal(isSelfAuthoredBotCallPrompt({ catsco_bot_call: true }, 1619), false);
    assert.equal(isSelfAuthoredBotCallPrompt({ catsco_bot_call: true, catsco_caller_uid: 1619 }, undefined), false);
    assert.equal(isSelfAuthoredBotCallPrompt(undefined, 1619), false);
  });
});

describe('BotCallWindow.mark', () => {
  test('标记在 TTL 内有效，过期自动失效', () => {
    let now = 0;
    const window = new BotCallWindow(0, () => now);
    window.mark('p2p_982_1619', 1000);
    assert.equal(window.isInCall('p2p_982_1619'), true);
    now = 999;
    assert.equal(window.isInCall('p2p_982_1619'), true);
    now = 1001;
    assert.equal(window.isInCall('p2p_982_1619'), false);
  });
});
