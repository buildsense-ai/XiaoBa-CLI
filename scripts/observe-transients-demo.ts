/**
 * 模拟几轮对话，观测 transient injection 日志输出。
 * 用法: XIAOBA_TRANSIENT_OBSERVE=1 npx tsx scripts/observe-transients-demo.ts
 */
import { TurnContextBuilder } from '../src/core/turn-context-builder';
import { createTransientObserver, resetPreviousSystemHash } from '../src/utils/transient-observation';
import { SessionSkillRuntime, TRANSIENT_SKILLS_LIST_PREFIX } from '../src/skills/session-skill-runtime';
import { Message } from '../src/types';

// Force enable observation for this script
process.env.XIAOBA_TRANSIENT_OBSERVE = '1';

const mockSkillRuntime: SessionSkillRuntime = {
  reloadSkills: async () => {},
  buildSkillsListMessage: () => ({
    role: 'user' as const,
    content: `${TRANSIENT_SKILLS_LIST_PREFIX}\n- deep-research: 深度研究\n- code-review: 代码审查`,
    __injected: true,
  }),
  handleSkillsCommand: () => ({ handled: false }),
} as any;

const mockPlanRuntime = {
  formatForPrompt: () => '1. [x] 建立观测\n2. [ ] 跑测试\n3. [ ] 分析结果',
};

async function simulateTurn(turn: number, systemPrompt: string, userMessage: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Turn ${turn}`);
  console.log('='.repeat(60));

  const observer = createTransientObserver();
  const builder = new TurnContextBuilder();

  const durableMessages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  await builder.build({
    sessionKey: 'demo-session',
    durableMessages,
    runtimeFeedback: turn > 1 ? ['上一轮工具执行成功'] : [],
    skillRuntime: mockSkillRuntime,
    planRuntime: mockPlanRuntime as any,
    observer,
  });

  // Simulate an unrelated transient filtered by policy.
  observer.recordSuppressed('[transient_soft_check]', 'filtered_by_policy');
  if (turn > 2) {
    observer.recordInjected('[transient_runner_hint]', 'system', 'system', 120);
  }

  // Compute a fake system hash (in real code this comes from the assembled request)
  const { createHash } = await import('crypto');
  const systemHash = createHash('sha256').update(systemPrompt).digest('hex').slice(0, 16);

  observer.log({
    turn,
    sessionId: 'demo-session',
    provider: 'anthropic',
    model: 'minimax-m3',
    requestId: `ph_demo_${turn}`,
    systemHash,
    systemLen: systemPrompt.length,
  });
}

async function main() {
  resetPreviousSystemHash();

  const stableSystem = '你是 XiaoBa，一个 AI 开发助手。\n\n## 工具\n可以使用 execute_shell、read_file 等工具。';

  // Turn 1: 正常注入
  await simulateTurn(1, stableSystem, '帮我看看 src/index.ts 的结构');

  // Turn 2: system 不变，观测 systemHashChanged=false
  await simulateTurn(2, stableSystem, '继续分析');

  // Turn 3: system 不变，多了 soft_check 抑制
  await simulateTurn(3, stableSystem, '加一个新功能');

  // Turn 4: system 变了！（模拟 transient 意外进入 system）
  const changedSystem = stableSystem + '\n\n[transient_runner_hint]\n这是一个不该进 system 的内容';
  await simulateTurn(4, changedSystem, '继续');

  // Turn 5: system 恢复正常
  await simulateTurn(5, stableSystem, '好了');

  console.log('\n' + '='.repeat(60));
  console.log('Demo complete. Check [TRANSIENT_OBSERVE] logs above.');
  console.log('Turn 4 should show systemHashChanged=true (simulated contamination).');
  console.log('Turn 5 should also show systemHashChanged=true (recovered).');
}

main().catch(console.error);
