import { EvalResult } from './eval-types';

export function generateMarkdownReport(result: EvalResult): string {
  const lines: string[] = [
    `# Eval 报告: ${result.specName}`,
    '',
    `评估时间: ${result.timestamp}`,
    `总轮次: ${result.turns.length}`,
    '',
    '---',
    '',
  ];

  // 逐轮对话
  for (const log of result.turns) {
    lines.push(`## Turn ${log.turn}`, '');
    lines.push(`**Tester**: ${log.testerMessage}`, '');

    if (log.targetToolCalls.length > 0) {
      lines.push('**工具调用**:');
      for (const tc of log.targetToolCalls) {
        lines.push(`- \`${tc.name}\`: \`${JSON.stringify(tc.arguments).slice(0, 200)}\``);
      }
      lines.push('');
    }

    if (log.targetVisibleReply.length > 0) {
      lines.push('**可见回复**:', '');
      for (const msg of log.targetVisibleReply) {
        lines.push(`> ${msg.replace(/\n/g, '\n> ')}`);
      }
      lines.push('');
    }

    lines.push(`**Final Answer**: ${log.targetFinalAnswer.slice(0, 500)}`, '', '---', '');
  }

  // 断言结果
  if (result.assertions.length > 0) {
    lines.push('## 断言结果', '');
    for (const a of result.assertions) {
      lines.push(`- ${a.passed ? '✅' : '❌'} \`${a.spec.type}\` ${a.detail}`);
    }
    lines.push('');
  }

  // Judge 评分
  if (result.judgeScores) {
    lines.push('## Judge 评分', '');
    for (const s of result.judgeScores) {
      lines.push(`- **${s.dimension}**: ${s.score}/10 — ${s.reasoning}`);
    }
    if (result.weightedScore !== null) {
      lines.push('', `**加权总分: ${result.weightedScore.toFixed(2)}/10**`);
    }
    lines.push('');
  }

  // 工具统计
  const allTools = result.turns.flatMap(t => t.targetToolCalls.map(c => c.name));
  const freq: Record<string, number> = {};
  for (const t of allTools) freq[t] = (freq[t] || 0) + 1;

  lines.push('## 统计', '');
  lines.push(`- 总轮次: ${result.turns.length}`);
  lines.push(`- 总工具调用: ${allTools.length}`);
  lines.push('', '**工具使用频率**:');
  for (const [name, count] of Object.entries(freq).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${name}: ${count}次`);
  }

  return lines.join('\n');
}
