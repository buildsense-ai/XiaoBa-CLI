import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { CatsCompanyBot } from '../src/catscompany';
import { Logger } from '../src/utils/logger';
import type { CatsDeviceRpcMessage, CatsThinToolRpcMessage } from '../src/catscompany/client';
import {
  RPC_TELEMETRY_TRACKED_TOOLS,
  RpcToolTelemetrySpan,
  encodeRpcTelemetryFieldValue,
  normalizeRpcTelemetryTool,
  sanitizeRpcTelemetryErrorCode,
  sanitizeRpcTelemetryLabel,
  sanitizeRpcTelemetryRequestId,
  toolResultContentChars,
} from '../src/catscompany/rpc-tool-telemetry';

/** 临时替换 Logger.info 捕获日志行（telemetry 断言用），测试结束恢复。 */
function captureLoggerInfo(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const original = Logger.info;
  (Logger as unknown as { info: (message: string) => void }).info = (message: string) => {
    lines.push(String(message));
  };
  return {
    lines,
    restore: () => {
      (Logger as unknown as { info: (message: string) => void }).info = original;
    },
  };
}

function telemetryLines(lines: string[]): string[] {
  return lines.filter(line => line.includes('[telemetry]'));
}

function localDeviceGrant(): Record<string, unknown> {
  return {
    kind: 'catscompany_body',
    source: 'catscompany',
    ownerUserId: 'usr7',
    bodyId: 'body-device',
    installationId: 'install-device',
    deviceId: 'install-device',
    createdAt: Date.now(),
  };
}

function deviceGrepRequest(overrides: Partial<CatsDeviceRpcMessage> = {}): CatsDeviceRpcMessage {
  return {
    type: 'request',
    request_id: 'rpc-grep-1',
    grant_id: 'grant-grep-1',
    session_key: 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43',
    topic_id: 'p2p_7_43',
    topic_type: 'p2p',
    actor_user_id: 'usr7',
    owner_user_id: 'usr7',
    identity_source: 'metadata.catsco_identity',
    agent_id: 'usr43',
    device_id: 'install-device',
    device_body_id: 'body-device',
    device_installation_id: 'install-device',
    operation: 'grep',
    tool_name: 'grep',
    created_at: Date.now(),
    expires_at: Date.now() + 60_000,
    payload: { args: { pattern: 'TOPSECRET-pattern-xyz', path: '/secret/path/x' } },
    ...overrides,
  };
}

function thinGrepRequest(overrides: Partial<CatsThinToolRpcMessage> = {}): CatsThinToolRpcMessage {
  return {
    type: 'request',
    request_id: 'thin-grep-1',
    target_owner_user_id: 'usr7',
    target_device_id: 'install-device',
    device_id: 'install-device',
    tool_name: 'grep',
    payload: { args: { pattern: 'TOPSECRET-pattern-xyz', path: '/secret/path/x' } },
    ...overrides,
  };
}

describe('rpc-tool-telemetry pure helpers', () => {
  test('normalizes tool names onto the receiver enum without leaking raw strings', () => {
    assert.equal(normalizeRpcTelemetryTool('grep'), 'grep');
    assert.equal(normalizeRpcTelemetryTool(' GREP '), 'grep');
    assert.equal(normalizeRpcTelemetryTool('import_file'), 'send_file');
    assert.equal(normalizeRpcTelemetryTool('read_file'), 'read_file');
    assert.equal(normalizeRpcTelemetryTool(''), 'unknown');
    assert.equal(normalizeRpcTelemetryTool('skillhub.localWorkspace.get'), 'unknown');
    // 不可信工具名不透传原始字符串
    assert.equal(normalizeRpcTelemetryTool('grep --pattern /etc/passwd'), 'unknown');
  });

  test('sanitizes untrusted labels: control chars removed, whitespace collapsed, length capped', () => {
    assert.equal(sanitizeRpcTelemetryLabel('a\nb\u0000c', 20), 'a b c');
    assert.equal(sanitizeRpcTelemetryRequestId('rpc-ok'), 'rpc-ok');
    assert.equal(sanitizeRpcTelemetryRequestId('rpc-g\nFAKE-LOG-LINE').includes('\n'), false);
    assert.ok(sanitizeRpcTelemetryRequestId('z'.repeat(500)).length <= 80);
    assert.ok(sanitizeRpcTelemetryErrorCode('e'.repeat(500)).length <= 48);
    assert.equal(sanitizeRpcTelemetryLabel(undefined as unknown as string, 10), '');
    // \u2028/\u2029 与 C1 控制区同样被清洗
    assert.equal(sanitizeRpcTelemetryLabel('a\u2028b\u009fc', 20), 'a b c');
  });

  test('begin only tracks configured tools with a correlate-able request id', () => {
    assert.equal(RPC_TELEMETRY_TRACKED_TOOLS.has('grep'), true);
    assert.equal(RPC_TELEMETRY_TRACKED_TOOLS.has('read_file'), false);
    assert.equal(RpcToolTelemetrySpan.begin({ channel: 'device_rpc', requestId: 'r1', toolName: 'read_file' }), undefined);
    assert.equal(RpcToolTelemetrySpan.begin({ channel: 'device_rpc', requestId: '', toolName: 'grep' }), undefined);
    const span = RpcToolTelemetrySpan.begin({ channel: 'device_rpc', requestId: 'rpc-1', toolName: 'grep', now: 1_000 });
    assert.ok(span);
    assert.equal(span!.tool, 'grep');
    assert.equal(span!.requestId, 'rpc-1');
  });

  test('span timeline: received → execute_end → result_sent separates execution from return transport', () => {
    const span = RpcToolTelemetrySpan.begin({ channel: 'device_rpc', requestId: 'rpc-1', toolName: 'grep', now: 1_000 });
    assert.ok(span);
    assert.equal(span!.received(1_000), '[CatsCompany][device_rpc][telemetry] request=rpc-1 tool=grep phase=received at=1000');
    assert.equal(
      span!.executeEnd({ ok: true }, 3_500),
      '[CatsCompany][device_rpc][telemetry] request=rpc-1 tool=grep phase=execute_end ok=true durationMs=2500',
    );
    assert.equal(
      span!.resultSent({ ok: true, resultChars: 71_355 }, 3_800),
      '[CatsCompany][device_rpc][telemetry] request=rpc-1 tool=grep phase=result_sent ok=true durationMs=2800 transportMs=300 resultChars=71355',
    );
  });

  test('rejected RPC logs ok=false with sanitized errorCode and never ok=true', () => {
    const span = RpcToolTelemetrySpan.begin({ channel: 'device_rpc', requestId: 'rpc-2', toolName: 'grep', now: 1_000 });
    assert.ok(span);
    const line = span!.executeEnd({ ok: false, errorCode: 'target_device_mismatch' }, 1_004);
    assert.ok(line.includes('ok=false'));
    assert.ok(line.includes('errorCode=target_device_mismatch'));
    assert.ok(!line.includes('ok=true'));
    // 不可信/空 errorCode 收敛为 unknown_error，控制字符被清洗并百分号编码
    assert.ok(span!.executeEnd({ ok: false, errorCode: 'bad\n scheme\u0000' }, 1_005).includes('errorCode=bad%20scheme'));
    assert.ok(span!.executeEnd({ ok: false }, 1_006).includes('errorCode=unknown_error'));
    // 发送失败仍然保持 ok=false 且带 sendFailed 标记
    const sentLine = span!.resultSent({ ok: false, errorCode: 'target_device_mismatch', sendFailed: true }, 1_010);
    assert.ok(sentLine.includes('phase=result_sent'));
    assert.ok(sentLine.includes('ok=false'));
    assert.ok(sentLine.includes('sendFailed=true'));
    assert.ok(!sentLine.includes('resultChars='));
  });

  test('shutdown drop pairs the timeline without a result_sent phase', () => {
    const span = RpcToolTelemetrySpan.begin({ channel: 'thin_tool_rpc', requestId: 'rpc-3', toolName: 'grep', now: 5_000 });
    assert.ok(span);
    assert.equal(span!.executeEnd({ ok: true }, 6_000).includes('durationMs=1000'), true);
    assert.equal(
      span!.dropped(6_100),
      '[CatsCompany][thin_tool_rpc][telemetry] request=rpc-3 tool=grep phase=dropped_shutdown durationMs=1100',
    );
  });

  test('toolResultContentChars aggregates length only', () => {
    assert.equal(toolResultContentChars({ content: 'abc' }), 3);
    assert.equal(toolResultContentChars({ content: ['block'] }), undefined);
    assert.equal(toolResultContentChars(undefined), undefined);
  });

  test('label type fence: objects/toString hooks are never invoked and never throw', () => {
    let hookRan = false;
    const hookObject = { toString: () => { hookRan = true; return 'pwned'; } } as unknown as string;
    assert.equal(sanitizeRpcTelemetryLabel(hookObject, 10), '');
    assert.equal(hookRan, false, 'custom toString must never execute');

    // String({toString: null}) 会抛 TypeError；类型门必须先行拦截
    assert.equal(sanitizeRpcTelemetryLabel({ toString: null }, 10), '');
    const getterBomb = { get toString(): string { throw new Error('getter bomb'); } } as unknown as string;
    assert.equal(sanitizeRpcTelemetryLabel(getterBomb, 10), '');

    // 其余非 string / 非有限 number 标量一律为空
    assert.equal(sanitizeRpcTelemetryLabel(['tool=write_file'], 10), '');
    assert.equal(sanitizeRpcTelemetryLabel(null, 10), '');
    assert.equal(sanitizeRpcTelemetryLabel(Symbol('x'), 10), '');
    assert.equal(sanitizeRpcTelemetryLabel(BigInt(10), 10), '');
    assert.equal(sanitizeRpcTelemetryLabel(true, 10), '');
    assert.equal(sanitizeRpcTelemetryLabel(NaN, 10), '');
    assert.equal(sanitizeRpcTelemetryLabel(Infinity, 10), '');
    // 有限 number 走固定 coercion，允许保留
    assert.equal(sanitizeRpcTelemetryLabel(42, 10), '42');
    assert.equal(sanitizeRpcTelemetryLabel(3.5, 10), '3.5');

    // 同样的 fence 覆盖 request id / 工具名入口
    assert.equal(sanitizeRpcTelemetryRequestId(hookObject), '');
    assert.equal(normalizeRpcTelemetryTool({ toString: null }), 'unknown');
    assert.equal(
      RpcToolTelemetrySpan.begin({ channel: 'device_rpc', requestId: hookObject, toolName: 'grep' }),
      undefined,
    );
    assert.equal(normalizeRpcTelemetryTool(7), 'unknown');
  });

  test('field encoding keeps nonce ids readable and defuses kv/control injection', () => {
    // 常规 nonce 请求 ID：unreserved 集合原样保留、可读可关联
    assert.equal(encodeRpcTelemetryFieldValue('thin_tool_rpc_ab12-cd34.ef56_7890'), 'thin_tool_rpc_ab12-cd34.ef56_7890');
    assert.equal(encodeRpcTelemetryFieldValue('TOOL_EXECUTION_ERROR'), 'TOOL_EXECUTION_ERROR');
    assert.equal(encodeRpcTelemetryFieldValue('target_device_mismatch'), 'target_device_mismatch');
    // 危险字符（含 UTF-8 多字节）转标准百分号编码
    assert.equal(encodeRpcTelemetryFieldValue('a b'), 'a%20b');
    assert.equal(encodeRpcTelemetryFieldValue('a=b'), 'a%3Db');
    assert.equal(encodeRpcTelemetryFieldValue('"x"[y]{z}'), '%22x%22%5By%5D%7Bz%7D');
    assert.equal(encodeRpcTelemetryFieldValue('emoji😀'), 'emoji%F0%9F%98%80');
    assert.equal(encodeRpcTelemetryFieldValue(''), '');
  });

  test('kv-injected request id cannot forge phase/tool/ok/errorCode fields in any timeline line', () => {
    const span = RpcToolTelemetrySpan.begin({
      channel: 'device_rpc',
      requestId: 'x tool=write_file phase=result_sent ok=true errorCode=PWNED',
      toolName: 'grep',
      now: 1_000,
    });
    assert.ok(span);
    const lines = [
      span!.received(1_000),
      span!.executeEnd({ ok: true }, 1_500),
      span!.resultSent({ ok: true, resultChars: 5 }, 1_800),
    ];
    for (const line of lines) {
      assert.equal(line.match(/tool=/g)?.length, 1, `exactly one tool= field: ${line}`);
      assert.equal(line.match(/phase=/g)?.length, 1, `exactly one phase= field: ${line}`);
      assert.ok(line.includes('tool=grep'), `real tool preserved: ${line}`);
      // 注入片段只能以编码形式出现（原始 key=value 伪造不可见）
      assert.ok(line.includes('%20tool%3Dwrite_file'), `injection percent-encoded: ${line}`);
      assert.ok(!line.includes(' tool=write_file'));
      assert.ok(!line.includes('errorCode=PWNED'));
    }
    assert.ok(lines[1].includes('ok=true') && !lines[0].includes('ok='), 'received phase has no ok field');
    assert.ok(lines[2].includes('phase=result_sent'));

    // errorCode 注入同样只能编码出现
    const errSpan = RpcToolTelemetrySpan.begin({ channel: 'thin_tool_rpc', requestId: 'rpc-e', toolName: 'grep', now: 1_000 });
    assert.ok(errSpan);
    const errLine = errSpan!.executeEnd({ ok: false, errorCode: 'y phase=execute_end ok=true' }, 1_100);
    assert.equal(errLine.match(/phase=/g)?.length, 1);
    assert.equal(errLine.match(/ok=/g)?.length, 1);
    assert.ok(errLine.includes('ok=false'));
    assert.ok(errLine.includes('errorCode=y%20phase%3Dexecute_end%20ok%3Dtrue'));
  });
});

describe('receiver grep telemetry (device_rpc + thin_tool_rpc)', () => {
  test('device_rpc grep: received → execute_end ok=true → result_sent with transport and length aggregates', async () => {
    const captured: { result?: any } = {};
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.shuttingDown = false;
    bot.localDeviceGrant = localDeviceGrant();
    bot.bot = { sendDeviceRpcResult: async (result: any) => { captured.result = result; } };
    bot.executeLocalDeviceRpcTool = async () => ({ ok: true, content: 'g'.repeat(123) });

    const capture = captureLoggerInfo();
    try {
      await bot.handleDeviceRpcRequest(deviceGrepRequest({
        request_id: 'rpc-g\rfake',
      }));
    } finally {
      capture.restore();
    }

    const telemetry = telemetryLines(capture.lines);
    assert.equal(telemetry.length, 3, `expected 3 telemetry lines, got: ${JSON.stringify(telemetry)}`);
    assert.match(telemetry[0], /phase=received/);
    assert.match(telemetry[1], /phase=execute_end ok=true durationMs=\d+/);
    assert.match(telemetry[2], /phase=result_sent ok=true durationMs=\d+ transportMs=\d+ resultChars=123$/);
    // 每条 telemetry 都是单行（控制字符已清洗），且不泄露 pattern/路径
    for (const line of telemetry) {
      assert.equal(line.includes('\n') || line.includes('\r'), false);
      assert.equal(line.includes('TOPSECRET-pattern-xyz'), false);
      assert.equal(line.includes('/secret/path/x'), false);
    }
    // telemetry 清洗不改变传输形状：原始 request_id 原样回传
    assert.ok(captured.result);
    assert.equal(captured.result.request_id, 'rpc-g\rfake');
    assert.equal(captured.result.error, undefined);
  });

  test('device_rpc rejected grep (target mismatch): execute_end ok=false, never counted as executed', async () => {
    const captured: { result?: any } = {};
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.shuttingDown = false;
    bot.localDeviceGrant = localDeviceGrant();
    bot.bot = { sendDeviceRpcResult: async (result: any) => { captured.result = result; } };
    let executed = 0;
    bot.executeLocalDeviceRpcTool = async () => { executed += 1; return { ok: true, content: 'should-not-run' }; };

    const capture = captureLoggerInfo();
    try {
      await bot.handleDeviceRpcRequest(deviceGrepRequest({
        request_id: 'rpc-grep-reject',
        device_id: 'install-other',
        device_body_id: 'body-other',
        device_installation_id: 'install-other',
      }));
    } finally {
      capture.restore();
    }

    assert.equal(executed, 0, 'rejected RPC must not execute the tool');
    const telemetry = telemetryLines(capture.lines);
    assert.equal(telemetry.length, 3);
    assert.match(telemetry[1], /phase=execute_end ok=false errorCode=target_device_mismatch/);
    assert.match(telemetry[2], /phase=result_sent ok=false/);
    assert.ok(!telemetry.some(line => line.includes('ok=true')), 'rejected RPC must not be logged as executed ok');
    // 传输形状不变：错误结果照常回传
    assert.ok(captured.result?.error);
    assert.equal(captured.result.error.code, 'target_device_mismatch');
  });

  test('device_rpc grep execution throw: timeline still pairs with ok=false execute_end', async () => {
    const captured: { result?: any } = {};
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.shuttingDown = false;
    bot.localDeviceGrant = localDeviceGrant();
    bot.bot = { sendDeviceRpcResult: async (result: any) => { captured.result = result; } };
    bot.executeLocalDeviceRpcTool = async () => { throw new Error('rg exploded'); };

    const capture = captureLoggerInfo();
    try {
      await bot.handleDeviceRpcRequest(deviceGrepRequest({ request_id: 'rpc-grep-throw' }));
    } finally {
      capture.restore();
    }

    const telemetry = telemetryLines(capture.lines);
    assert.equal(telemetry.length, 3);
    assert.match(telemetry[1], /phase=execute_end ok=false errorCode=TOOL_EXECUTION_ERROR/);
    assert.match(telemetry[2], /phase=result_sent ok=false/);
    // 错误 message 不进入 telemetry
    assert.ok(!telemetry.some(line => line.includes('rg exploded')));
    assert.ok(captured.result?.error);
  });

  test('device_rpc grep send failure: result_sent carries sendFailed=true', async () => {
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.shuttingDown = false;
    bot.localDeviceGrant = localDeviceGrant();
    bot.bot = { sendDeviceRpcResult: async () => { throw new Error('transport down'); } };
    bot.executeLocalDeviceRpcTool = async () => ({ ok: true, content: 'ok-content' });

    const capture = captureLoggerInfo();
    try {
      await bot.handleDeviceRpcRequest(deviceGrepRequest({ request_id: 'rpc-grep-sendfail' }));
    } finally {
      capture.restore();
    }

    const telemetry = telemetryLines(capture.lines);
    assert.equal(telemetry.length, 3);
    assert.match(telemetry[1], /phase=execute_end ok=true/);
    // resultChars 是已产出的结果长度聚合（执行产物），sendFailed 标记回传失败
    assert.match(telemetry[2], /phase=result_sent ok=true .*resultChars=10 sendFailed=true$/);
  });

  test('device_rpc grep shutdown drop: dropped_shutdown pairs the timeline, no result_sent', async () => {
    const captured: { result?: any } = {};
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.shuttingDown = false;
    bot.localDeviceGrant = localDeviceGrant();
    bot.bot = { sendDeviceRpcResult: async (result: any) => { captured.result = result; } };
    bot.executeLocalDeviceRpcTool = async () => {
      bot.shuttingDown = true; // destroy() 在执行期间开始
      return { ok: true, content: 'late' };
    };

    const capture = captureLoggerInfo();
    try {
      await bot.handleDeviceRpcRequest(deviceGrepRequest({ request_id: 'rpc-grep-late' }));
    } finally {
      capture.restore();
    }

    const telemetry = telemetryLines(capture.lines);
    assert.equal(telemetry.length, 3);
    assert.match(telemetry[1], /phase=execute_end ok=true/);
    assert.match(telemetry[2], /phase=dropped_shutdown/);
    assert.ok(!telemetry.some(line => line.includes('phase=result_sent')));
    assert.equal(captured.result, undefined);
  });

  test('thin_tool_rpc grep: same correlated timeline on the thin channel', async () => {
    const captured: { result?: any } = {};
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.shuttingDown = false;
    bot.localDeviceGrant = localDeviceGrant();
    bot.skillHubThinRpc = { supports: () => false };
    bot.bot = { sendThinToolRpcResult: async (result: any) => { captured.result = result; } };
    bot.executeLocalThinToolRpcTool = async () => ({ ok: true, content: 't'.repeat(77) });

    const capture = captureLoggerInfo();
    try {
      await bot.handleThinToolRpcRequest(thinGrepRequest({ request_id: 'thin-grep-ok' }));
    } finally {
      capture.restore();
    }

    const telemetry = telemetryLines(capture.lines);
    assert.equal(telemetry.length, 3);
    assert.ok(telemetry.every(line => line.startsWith('[CatsCompany][thin_tool_rpc][telemetry]')));
    assert.match(telemetry[0], /request=thin-grep-ok tool=grep phase=received/);
    assert.match(telemetry[1], /phase=execute_end ok=true durationMs=\d+/);
    assert.match(telemetry[2], /phase=result_sent ok=true durationMs=\d+ transportMs=\d+ resultChars=77$/);
    assert.ok(!telemetry.some(line => line.includes('TOPSECRET-pattern-xyz')));
    assert.equal(captured.result?.result?.ok, true);
  });

  test('thin_tool_rpc grep execution throw: paired ok=false execute_end and error transport unchanged', async () => {
    const captured: { result?: any } = {};
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.shuttingDown = false;
    bot.skillHubThinRpc = { supports: () => false };
    bot.bot = { sendThinToolRpcResult: async (result: any) => { captured.result = result; } };
    bot.executeLocalThinToolRpcTool = async () => { throw new Error('grep fell over'); };

    const capture = captureLoggerInfo();
    try {
      await bot.handleThinToolRpcRequest(thinGrepRequest({ request_id: 'thin-grep-throw' }));
    } finally {
      capture.restore();
    }

    const telemetry = telemetryLines(capture.lines);
    assert.equal(telemetry.length, 3);
    assert.match(telemetry[1], /phase=execute_end ok=false errorCode=TOOL_EXECUTION_ERROR/);
    assert.match(telemetry[2], /phase=result_sent ok=false/);
    assert.ok(!telemetry.some(line => line.includes('grep fell over')));
    assert.ok(captured.result?.error);
    assert.equal(captured.result.error.code, 'TOOL_EXECUTION_ERROR');
  });

  test('non-grep tools stay silent: no telemetry lines for read_file on either channel', async () => {
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.shuttingDown = false;
    bot.localDeviceGrant = localDeviceGrant();
    bot.skillHubThinRpc = { supports: () => false };
    bot.bot = {
      sendDeviceRpcResult: async () => {},
      sendThinToolRpcResult: async () => {},
    };
    bot.executeLocalDeviceRpcTool = async () => ({ ok: true, content: 'file body' });
    bot.executeLocalThinToolRpcTool = async () => ({ ok: true, content: 'file body' });

    const capture = captureLoggerInfo();
    try {
      await bot.handleDeviceRpcRequest(deviceGrepRequest({ request_id: 'rpc-read-1', operation: 'read_file', tool_name: 'read_file' }));
      await bot.handleThinToolRpcRequest(thinGrepRequest({ request_id: 'thin-read-1', tool_name: 'read_file' }));
    } finally {
      capture.restore();
    }

    assert.deepEqual(telemetryLines(capture.lines), []);
  });

  test('import_file alias normalizes to send_file enum and stays untracked like other non-grep tools', async () => {
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.shuttingDown = false;
    bot.localDeviceGrant = localDeviceGrant();
    bot.bot = { sendDeviceRpcResult: async () => {} };
    bot.executeLocalDeviceRpcTool = async () => ({ ok: true, content: '' });

    const capture = captureLoggerInfo();
    try {
      await bot.handleDeviceRpcRequest(deviceGrepRequest({ request_id: 'rpc-alias-1', operation: 'import_file', tool_name: 'import_file' }));
    } finally {
      capture.restore();
    }

    assert.deepEqual(telemetryLines(capture.lines), []);
  });

  test('device_rpc hostile request id: encoded in telemetry, raw id unchanged on the wire', async () => {
    const captured: { result?: any } = {};
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.shuttingDown = false;
    bot.localDeviceGrant = localDeviceGrant();
    bot.bot = { sendDeviceRpcResult: async (result: any) => { captured.result = result; } };
    bot.executeLocalDeviceRpcTool = async () => ({ ok: true, content: 'ok' });
    const hostileId = 'rpc fake tool=read_file ok=true\n';

    const capture = captureLoggerInfo();
    try {
      await bot.handleDeviceRpcRequest(deviceGrepRequest({ request_id: hostileId }));
    } finally {
      capture.restore();
    }

    const telemetry = telemetryLines(capture.lines);
    assert.equal(telemetry.length, 3);
    assert.equal(telemetry[0].match(/ok=/g)?.length ?? 0, 0, 'received phase has no ok field');
    for (const line of telemetry) {
      assert.equal(line.match(/tool=/g)?.length, 1);
      assert.ok(!line.includes(' tool=read_file'));
      assert.ok(!line.includes('\n'));
    }
    assert.equal(telemetry[1].match(/ok=/g)?.length, 1);
    assert.equal(telemetry[2].match(/ok=/g)?.length, 1);
    assert.ok(telemetry[0].includes('request=rpc%20fake%20tool%3Dread_file'));
    // 传输形状不变：原始 request_id 原样回传
    assert.equal(captured.result.request_id, hostileId);
  });
});
