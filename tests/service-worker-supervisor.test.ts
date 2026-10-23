import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  buildServiceRunResult,
  createServiceWorkerSupervisor,
  defaultServiceWorkerInstanceId,
  expandServiceRunCommand,
  serviceRunCommandFor,
  type ClaimedRun,
  type ExecCommand,
  type ExecCommandOptions,
} from '../src/catscompany/service-worker-supervisor';

/**
 * 内嵌 service worker：用户不该看见任何「凭证」，所以这里重点覆盖
 * 「拿账号态换券 → 认领 → 执行 → 回填」以及各种失败/边界。
 */

interface RecordedRequest {
  path: string;
  auth: string;
  body: any;
}

const createFakeServer = (handlers: Record<string, (body: any) => { status?: number; body?: any }>) => {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: any, init: any) => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ path, auth: String(init?.headers?.Authorization ?? ''), body });
    // 按「结尾匹配」路由：/session、/claim、/runs/<id>/complete ...
    const key = Object.keys(handlers).find((candidate) => path.endsWith(candidate));
    const handler = key ? handlers[key] : () => ({ status: 404, body: { error: 'not_found' } });
    const result = handler(body);
    const status = result.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(result.body ?? {}),
    } as any;
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
};

const silentLogger = { info: () => {}, warning: () => {} };

const authOk = () => ({ token: 'user-jwt', httpBaseUrl: 'https://app.example.com', uid: '38' });

/** 平台认领下来的 run 一定带 definition.runner.command，这里统一补上。 */
const withCommand = (run: Partial<ClaimedRun> & { run_id: string; agent_slug: string; session_id: string }): ClaimedRun => ({
  ...run,
  definition: run.definition ?? { runner: { type: 'worker', command: 'agents/run.sh {input_file}' } },
});

test('用账号态换短期券，并用券认领与回填（用户全程看不到密钥）', async () => {
  const { fetchImpl, requests } = createFakeServer({
    '/session': () => ({
      body: { token: 'ticket-1', expires_at: new Date(Date.now() + 12 * 3600_000).toISOString(), scope: 'service_worker' },
    }),
    '/claim': () => ({
      body: {
        runs: [
          withCommand({ run_id: 'run_1', session_id: 'sess_1', agent_slug: 'my-agent', input: { text: 'hi' } }),
        ],
      },
    }),
    '/complete': () => ({ body: { ok: true } }),
  });

  const exec: ExecCommand = async (_command, options: ExecCommandOptions) => ({
    stdout: JSON.stringify({ output: { text: 'done' }, usage: { prompt_tokens: 7 } }),
    stderr: '',
    exitCode: 0,
  });

  const supervisor = createServiceWorkerSupervisor({
    resolveAuth: authOk,
    instanceId: 'w1',
    fetchImpl,
    execImpl: exec,
    logger: silentLogger,
  });

  const executed = await supervisor.runOnce();
  assert.equal(executed, 1);

  // 换券用账号态；业务请求用券（账号 JWT 不会出现在 worker 面）。
  const session = requests.find((r) => r.path.endsWith('/session'));
  assert.equal(session?.auth, 'Bearer user-jwt');
  const claim = requests.find((r) => r.path.endsWith('/claim'));
  assert.equal(claim?.auth, 'Bearer ticket-1');
  assert.equal(claim?.body.instance_id, 'w1');

  const complete = requests.find((r) => r.path.endsWith('/runs/run_1/complete'));
  assert.equal(complete?.auth, 'Bearer ticket-1');
  assert.equal(complete?.body.result_id, 'res_run_1');
  assert.equal(complete?.body.result.contract_version, 'catsco.service-run-result.v1');
  assert.deepEqual(complete?.body.result.output, { text: 'done' });
  assert.deepEqual(complete?.body.usage, { prompt_tokens: 7 });

  supervisor.stop();
});

test('没登录时不发任何请求（用户没登录就不该打扰平台）', async () => {
  const { fetchImpl, requests } = createFakeServer({});
  const supervisor = createServiceWorkerSupervisor({
    resolveAuth: () => null,
    instanceId: 'w1',
    fetchImpl,
    logger: silentLogger,
  });
  assert.equal(await supervisor.runOnce(), 0);
  assert.equal(requests.length, 0);
  supervisor.stop();
});

test('账号态失效（401）时停止认领而不是反复刷接口', async () => {
  let sessionCalls = 0;
  const { fetchImpl } = createFakeServer({
    '/session': () => {
      sessionCalls += 1;
      return { status: 401, body: { error: 'invalid or expired token' } };
    },
  });
  const supervisor = createServiceWorkerSupervisor({
    resolveAuth: authOk,
    instanceId: 'w1',
    fetchImpl,
    logger: silentLogger,
  });
  assert.equal(await supervisor.runOnce(), 0);
  assert.equal(await supervisor.runOnce(), 0);
  // 每轮都尝试换券（用户重新登录后自然恢复），但不会去调 claim。
  assert.equal(sessionCalls, 2);
  supervisor.stop();
});

test('券只用换一次（未过期时复用）', async () => {
  let sessionCalls = 0;
  const { fetchImpl } = createFakeServer({
    '/session': () => {
      sessionCalls += 1;
      return { body: { token: 'ticket-1', expires_at: new Date(Date.now() + 12 * 3600_000).toISOString() } };
    },
    '/claim': () => ({ body: { runs: [] } }),
  });
  const supervisor = createServiceWorkerSupervisor({
    resolveAuth: authOk,
    instanceId: 'w1',
    fetchImpl,
    logger: silentLogger,
  });
  await supervisor.runOnce();
  await supervisor.runOnce();
  await supervisor.runOnce();
  assert.equal(sessionCalls, 1);
  supervisor.stop();
});

test('命令非零退出 → fail(retryable=false) 且带上退出码与 stderr', async () => {
  const { fetchImpl, requests } = createFakeServer({
    '/session': () => ({ body: { token: 't', expires_at: new Date(Date.now() + 3600_000).toISOString() } }),
    '/claim': () => ({ body: { runs: [withCommand({ run_id: 'run_2', session_id: 's', agent_slug: 'a' })] } }),
    '/fail': () => ({ body: { ok: true } }),
  });
  const exec: ExecCommand = async () => ({ stdout: '', stderr: 'boom', exitCode: 3 });
  const supervisor = createServiceWorkerSupervisor({
    resolveAuth: authOk,
    instanceId: 'w1',
    fetchImpl,
    execImpl: exec,
    logger: silentLogger,
  });
  assert.equal(await supervisor.runOnce(), 1);
  const fail = requests.find((r) => r.path.endsWith('/runs/run_2/fail'));
  assert.equal(fail?.body.retryable, false);
  assert.match(String(fail?.body.error_text), /exit_3.*boom/);
  supervisor.stop();
});

test('超时 → fail(retryable=true)，让别的实例/重启后能重跑', async () => {
  const { fetchImpl, requests } = createFakeServer({
    '/session': () => ({ body: { token: 't', expires_at: new Date(Date.now() + 3600_000).toISOString() } }),
    '/claim': () => ({ body: { runs: [withCommand({ run_id: 'run_3', session_id: 's', agent_slug: 'a' })] } }),
    '/fail': () => ({ body: { ok: true } }),
  });
  const supervisor = createServiceWorkerSupervisor({
    resolveAuth: authOk,
    instanceId: 'w1',
    fetchImpl,
    execImpl: async () => ({ stdout: '', stderr: '', exitCode: -1 }),
    logger: silentLogger,
  });
  await supervisor.runOnce();
  const fail = requests.find((r) => r.path.endsWith('/runs/run_3/fail'));
  assert.equal(fail?.body.retryable, true);
  assert.match(String(fail?.body.error_text), /timeout/);
  supervisor.stop();
});

test('应用没声明命令且没有兜底 → no_command，不静默乱跑', async () => {
  const { fetchImpl, requests } = createFakeServer({
    '/session': () => ({ body: { token: 't', expires_at: new Date(Date.now() + 3600_000).toISOString() } }),
    '/claim': () => ({ body: { runs: [{ run_id: 'run_4', session_id: 's', agent_slug: 'a' }] } }),
    '/fail': () => ({ body: { ok: true } }),
  });
  const supervisor = createServiceWorkerSupervisor({
    resolveAuth: authOk,
    instanceId: 'w1',
    fetchImpl,
    execImpl: async () => {
      throw new Error('must not execute without a command');
    },
    logger: silentLogger,
  });
  await supervisor.runOnce();
  const fail = requests.find((r) => r.path.endsWith('/runs/run_4/fail'));
  assert.match(String(fail?.body.error_text), /no_command/);
  assert.equal(fail?.body.retryable, false);
  supervisor.stop();
});

test('应用声明了 runner.command 时优先用它，并展开占位符 + 传环境变量', async () => {
  const { fetchImpl } = createFakeServer({
    '/session': () => ({ body: { token: 't', expires_at: new Date(Date.now() + 3600_000).toISOString() } }),
    '/claim': () => ({
      body: {
        runs: [{
          run_id: 'run_5',
          session_id: 'sess_5',
          agent_slug: 'claude-helper',
          input: { text: 'x' },
          service_token: 'svc',
          threshold_seconds: 60,
          definition: { runner: { type: 'worker', command: 'claude -p {input_file} --slug {slug}' } },
        }],
      },
    }),
    '/complete': () => ({ body: { ok: true } }),
  });

  let seenCommand = '';
  let seenEnv: Record<string, string> = {};
  let seenInput = '';
  const supervisor = createServiceWorkerSupervisor({
    resolveAuth: authOk,
    instanceId: 'w1',
    // 兜底命令不该被用到
    fallbackCommand: 'should-not-run',
    fetchImpl,
    execImpl: async (command, options) => {
      seenCommand = command;
      seenEnv = options.env;
      seenInput = options.inputJson;
      return { stdout: 'plain text output', stderr: '', exitCode: 0 };
    },
    logger: silentLogger,
  });

  await supervisor.runOnce();
  assert.match(seenCommand, /^claude -p .+input\.json --slug claude-helper$/);
  assert.equal(seenEnv.CATSCO_RUN_ID, 'run_5');
  assert.equal(seenEnv.CATSCO_SESSION_ID, 'sess_5');
  assert.equal(seenEnv.CATSCO_AGENT, 'claude-helper');
  assert.equal(seenEnv.CATSCO_SERVICE_TOKEN, 'svc');
  assert.equal(seenEnv.CATSCO_THRESHOLD_SECONDS, '60');
  assert.equal(seenInput, JSON.stringify({ text: 'x' }));
  supervisor.stop();
});

test('-agents 之外的应用不领，立刻退回（可重试）', async () => {
  const { fetchImpl, requests } = createFakeServer({
    '/session': () => ({ body: { token: 't', expires_at: new Date(Date.now() + 3600_000).toISOString() } }),
    '/claim': () => ({
      body: {
        runs: [
          withCommand({ run_id: 'run_mine', session_id: 's', agent_slug: 'mine' }),
          withCommand({ run_id: 'run_other', session_id: 's', agent_slug: 'other' }),
        ],
      },
    }),
    '/complete': () => ({ body: { ok: true } }),
    '/fail': () => ({ body: { ok: true } }),
  });
  const executed: string[] = [];
  const supervisor = createServiceWorkerSupervisor({
    resolveAuth: authOk,
    instanceId: 'w1',
    agentSlugs: ['mine'],
    fetchImpl,
    execImpl: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    logger: silentLogger,
  });
  // 记录执行了哪些命令（用 command 里没法区分，这里改为看 complete 的目标）
  await supervisor.runOnce();
  const completes = requests.filter((r) => r.path.endsWith('/complete')).map((r) => r.path);
  assert.deepEqual(completes, ['/api/service-worker/runs/run_mine/complete']);
  const fail = requests.find((r) => r.path.endsWith('/runs/run_other/fail'));
  assert.equal(fail?.body.error_text, 'not_served_by_this_worker');
  assert.equal(fail?.body.retryable, true);
  void executed;
  supervisor.stop();
});

test('实例心跳带上本机服务的应用范围（平台据此判断在线可接单）', async () => {
  // 有限定 -agents
  {
    const { fetchImpl, requests } = createFakeServer({
      '/session': () => ({ body: { token: 't', expires_at: new Date(Date.now() + 3600_000).toISOString() } }),
      '/heartbeat': () => ({ body: { ok: true } }),
      '/claim': () => ({ body: { runs: [] } }),
    });
    const supervisor = createServiceWorkerSupervisor({
      resolveAuth: authOk,
      instanceId: 'w1',
      agentSlugs: ['a', 'b'],
      fetchImpl,
      logger: silentLogger,
    });
    supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    supervisor.stop();
    const hb = requests.find((r) => r.path.includes('/instances/w1/heartbeat'));
    assert.deepEqual(hb?.body.metrics.agents, ['a', 'b']);
    assert.equal(hb?.body.metrics.serve_all, false);
    assert.equal(hb?.body.metrics.worker, 'xiaoba-embedded-worker');
  }
  // 没限定 = 本账号所有应用都接
  {
    const { fetchImpl, requests } = createFakeServer({
      '/session': () => ({ body: { token: 't', expires_at: new Date(Date.now() + 3600_000).toISOString() } }),
      '/heartbeat': () => ({ body: { ok: true } }),
      '/claim': () => ({ body: { runs: [] } }),
    });
    const supervisor = createServiceWorkerSupervisor({
      resolveAuth: authOk,
      instanceId: 'w2',
      fetchImpl,
      logger: silentLogger,
    });
    supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    supervisor.stop();
    const hb = requests.find((r) => r.path.includes('/instances/w2/heartbeat'));
    assert.deepEqual(hb?.body.metrics.agents, []);
    assert.equal(hb?.body.metrics.serve_all, true);
  }
});

test('回填失败按可重试上报（租约到期后能重跑）', async () => {
  const { fetchImpl, requests } = createFakeServer({
    '/session': () => ({ body: { token: 't', expires_at: new Date(Date.now() + 3600_000).toISOString() } }),
    '/claim': () => ({ body: { runs: [withCommand({ run_id: 'run_6', session_id: 's', agent_slug: 'a' })] } }),
    '/complete': () => ({ status: 500, body: { error: 'boom' } }),
    '/fail': () => ({ body: { ok: true } }),
  });
  const supervisor = createServiceWorkerSupervisor({
    resolveAuth: authOk,
    instanceId: 'w1',
    fetchImpl,
    execImpl: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    logger: silentLogger,
  });
  await supervisor.runOnce();
  const fail = requests.find((r) => r.path.endsWith('/runs/run_6/fail'));
  assert.equal(fail?.body.retryable, true);
  assert.match(String(fail?.body.error_text), /complete_failed/);
  supervisor.stop();
});

test('buildServiceRunResult：纯文本 / 结构化 / 非法 JSON 三种输入', () => {
  const run = { run_id: 'r', session_id: 's' };

  const plain = buildServiceRunResult(run, '  hello world  ');
  assert.deepEqual(plain.envelope.output, { text: 'hello world' });
  assert.equal(plain.usage, undefined);

  const structured = buildServiceRunResult(run, JSON.stringify({ output: { text: 'x' }, usage: { prompt_tokens: 1 }, files: ['a.txt'] }));
  assert.deepEqual(structured.envelope.output, { text: 'x' });
  assert.deepEqual(structured.envelope.files, ['a.txt']);
  assert.deepEqual(structured.usage, { prompt_tokens: 1 });

  // 是 JSON 但没有 output 字段：当作纯文本原样保留，不能丢结果。
  const noOutput = buildServiceRunResult(run, '{"foo":1}');
  assert.deepEqual(noOutput.envelope.output, { text: '{"foo":1}' });

  // 非法 JSON：也当纯文本。
  const broken = buildServiceRunResult(run, '{not json');
  assert.deepEqual(broken.envelope.output, { text: '{not json' });
});

test('expandServiceRunCommand 与 serviceRunCommandFor 的边界', () => {
  const run = { agent_slug: 'a', run_id: 'r', session_id: 's' } as ClaimedRun;
  assert.equal(
    expandServiceRunCommand('x {slug} {run_id} {session_id} {input_file}', run, '/tmp/in.json'),
    'x a r s /tmp/in.json',
  );
  // 未知占位符原样保留（不静默吞掉，便于用户排查）
  assert.equal(expandServiceRunCommand('x {unknown}', run, '/tmp/in.json'), 'x {unknown}');

  assert.equal(serviceRunCommandFor({ definition: { runner: { command: '  cli  ' } } }, 'fallback'), 'cli');
  assert.equal(serviceRunCommandFor({ definition: {} }, ' fallback '), 'fallback');
  assert.equal(serviceRunCommandFor({}, undefined), '');
  assert.equal(serviceRunCommandFor({ definition: { runner: { command: '   ' } } }, ''), '');
});

test('默认实例 id 带 xiaoba 前缀且不超过 64 字符', () => {
  const id = defaultServiceWorkerInstanceId();
  assert.match(id, /^xiaoba-/);
  assert.ok(id.length <= 64);
});

/**
 * 下面两条**不传 execImpl**：真的拉起子进程（Windows=cmd /c，其他=sh -c）。
 *
 * 为什么要单独有这两条：其余用例都把 exec 打桩了，只能证明「协议自洽」，
 * 证明不了「在用户那台机器上命令真的跑得起来」。跨平台的差异恰好全在
 * 这一层（cmd 与 sh 的引号/重定向、PATH 解析、环境变量继承、输入文件路径）。
 * 命令统一用 node -e，三个平台都必然存在，避免引入 shell 方言。
 */
test('真实拉起子进程：默认 exec 在 cmd/sh 下继承环境变量并读到输入文件', async () => {
  const command = `node -e "console.log(process.env.CATSCO_AGENT); console.log(require('fs').readFileSync(process.env.CATSCO_INPUT_FILE, 'utf8'))"`;
  const { fetchImpl, requests } = createFakeServer({
    '/session': () => ({ body: { token: 't', expires_at: new Date(Date.now() + 3600_000).toISOString() } }),
    '/claim': () => ({
      body: {
        runs: [withCommand({
          run_id: 'run_real',
          session_id: 'sess_real',
          agent_slug: 'real-exec-agent',
          input: { text: 'real-exec-marker' },
          definition: { runner: { type: 'worker', command } },
        })],
      },
    }),
    '/complete': () => ({ body: { ok: true } }),
    '/fail': () => ({ body: { ok: true } }),
  });

  const supervisor = createServiceWorkerSupervisor({
    resolveAuth: authOk,
    instanceId: 'w1',
    fetchImpl,
    logger: silentLogger,
  });

  assert.equal(await supervisor.runOnce(), 1);
  // 没有 fail（说明真的跑成功了，不是 no_command / exit_N）
  assert.equal(requests.filter((r) => r.path.endsWith('/fail')).length, 0);
  const complete = requests.find((r) => r.path.endsWith('/runs/run_real/complete'));
  assert.ok(complete, 'should complete through the real child process');
  const text = String((complete?.body.result.output as { text?: string })?.text ?? '');
  // 环境变量（CATSCO_AGENT）与输入文件（CATSCO_INPUT_FILE）都要真的到达子进程。
  assert.match(text, /real-exec-agent/);
  assert.match(text, /real-exec-marker/);
  supervisor.stop();
});

test('真实超时：命令卡住时默认 exec 会杀掉子进程并回填 timeout', async () => {
  const command = `node -e "setTimeout(function(){}, 5000)"`;
  const { fetchImpl, requests } = createFakeServer({
    '/session': () => ({ body: { token: 't', expires_at: new Date(Date.now() + 3600_000).toISOString() } }),
    '/claim': () => ({
      body: {
        runs: [withCommand({
          run_id: 'run_stuck',
          session_id: 'sess_stuck',
          agent_slug: 'stuck-agent',
          definition: { runner: { type: 'worker', command } },
        })],
      },
    }),
    '/complete': () => ({ body: { ok: true } }),
    '/fail': () => ({ body: { ok: true } }),
  });

  const started = Date.now();
  const supervisor = createServiceWorkerSupervisor({
    resolveAuth: authOk,
    instanceId: 'w1',
    fetchImpl,
    runTimeoutMs: 1000,
    logger: silentLogger,
  });

  await supervisor.runOnce();
  const elapsed = Date.now() - started;
  const fail = requests.find((r) => r.path.endsWith('/runs/run_stuck/fail'));
  assert.ok(fail, 'timeout must be reported through /fail');
  assert.equal(fail?.body.retryable, true);
  assert.match(String(fail?.body.error_text), /^timeout/);
  // 真被杀掉了：不能等满命令自身的 5 秒。
  assert.ok(elapsed < 4000, `timeout should abort early, took ${elapsed}ms`);
  supervisor.stop();
});

/**
 * 只杀 shell 是不够的：真正干活的是孙进程。这条用例让命令在 2.5 秒后写一个
 * 标记文件——如果超时只结束了 shell、把孙进程留成孤儿，标记就会落盘。
 *
 * 打桩永远发现不了这个问题（实测：旧的 cmd-array 写法在 Windows 上会静默
 * 变成空输出，换成 shell:true 后又留下孤儿，两种都必须被这条用例挡住）。
 */
test('真实超时：整条命令的进程树被杀掉，不留孤儿继续跑', async () => {
  const marker = path.join(os.tmpdir(), `catsco-orphan-probe-${process.pid}-${Date.now()}.txt`);
  const markerURL = pathToFileURL(marker).href;
  const command = `node -e "setTimeout(function(){require('fs').writeFileSync(new URL('${markerURL}'), 'alive')}, 2500)"`;
  const { fetchImpl, requests } = createFakeServer({
    '/session': () => ({ body: { token: 't', expires_at: new Date(Date.now() + 3600_000).toISOString() } }),
    '/claim': () => ({
      body: {
        runs: [withCommand({
          run_id: 'run_orphan',
          session_id: 'sess_orphan',
          agent_slug: 'orphan-agent',
          definition: { runner: { type: 'worker', command } },
        })],
      },
    }),
    '/fail': () => ({ body: { ok: true } }),
    '/complete': () => ({ body: { ok: true } }),
  });

  const supervisor = createServiceWorkerSupervisor({
    resolveAuth: authOk,
    instanceId: 'w1',
    fetchImpl,
    runTimeoutMs: 1000,
    logger: silentLogger,
  });

  await supervisor.runOnce();
  assert.ok(
    requests.some((r) => r.path.endsWith('/runs/run_orphan/fail')),
    'timeout should be reported',
  );
  // 等过命令本来会写标记的时间点，再确认没有孤儿活下来。
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const survived = fs.existsSync(marker);
  if (survived) fs.rmSync(marker, { force: true });
  assert.equal(survived, false, 'the command process tree must be killed, not left running');
  supervisor.stop();
});
