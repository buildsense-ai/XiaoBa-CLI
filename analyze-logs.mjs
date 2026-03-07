#!/usr/bin/env node
import * as fs from 'fs';

const logFile = '/tmp/bot.log';
const logs = fs.readFileSync(logFile, 'utf-8');
const lines = logs.split('\n');

const metrics = {
  aiCalls: [],
  toolCalls: [],
  compressions: [],
  autoForwards: [],
  errors: [],
};

for (const line of lines) {
  // AI token usage
  const aiMatch = line.match(/AI返回 tokens: (\d+)\+(\d+)=(\d+)/);
  if (aiMatch) {
    metrics.aiCalls.push({
      prompt: parseInt(aiMatch[1]),
      completion: parseInt(aiMatch[2]),
      total: parseInt(aiMatch[3]),
    });
  }

  // Tool calls
  const toolMatch = line.match(/工具完成: (\w+) \| 耗时: (\d+)ms/);
  if (toolMatch) {
    metrics.toolCalls.push({
      name: toolMatch[1],
      duration: parseInt(toolMatch[2]),
    });
  }

  // Compression
  const compressMatch = line.match(/\[压缩\] (\d+) 条 → (\d+) 条，(\d+) tokens → (\d+) tokens/);
  if (compressMatch) {
    metrics.compressions.push({
      msgBefore: parseInt(compressMatch[1]),
      msgAfter: parseInt(compressMatch[2]),
      tokensBefore: parseInt(compressMatch[3]),
      tokensAfter: parseInt(compressMatch[4]),
    });
  }

  // Auto forwards
  const forwardMatch = line.match(/Message模式：已自动转发 "(.+?)"/);
  if (forwardMatch) {
    metrics.autoForwards.push(forwardMatch[1]);
  }

  // Errors
  if (line.includes('ERROR') || line.includes('Error:')) {
    metrics.errors.push(line.trim());
  }
}

console.log('📊 性能分析报告\n');
console.log('='.repeat(60));

if (metrics.aiCalls.length > 0) {
  const totalTokens = metrics.aiCalls.reduce((s, c) => s + c.total, 0);
  const avgTokens = totalTokens / metrics.aiCalls.length;
  console.log(`\n🤖 AI 调用: ${metrics.aiCalls.length} 次`);
  console.log(`   总 tokens: ${totalTokens}`);
  console.log(`   平均: ${avgTokens.toFixed(0)} tokens/次`);
}

if (metrics.toolCalls.length > 0) {
  const totalDuration = metrics.toolCalls.reduce((s, t) => s + t.duration, 0);
  const avgDuration = totalDuration / metrics.toolCalls.length;
  console.log(`\n⚙️  工具调用: ${metrics.toolCalls.length} 次`);
  console.log(`   总耗时: ${totalDuration}ms`);
  console.log(`   平均: ${avgDuration.toFixed(0)}ms/次`);

  const toolStats = {};
  metrics.toolCalls.forEach(t => {
    if (!toolStats[t.name]) toolStats[t.name] = { count: 0, total: 0 };
    toolStats[t.name].count++;
    toolStats[t.name].total += t.duration;
  });

  console.log('\n   工具统计:');
  Object.entries(toolStats).forEach(([name, stats]) => {
    console.log(`     ${name}: ${stats.count}次, 平均${(stats.total/stats.count).toFixed(0)}ms`);
  });
}

if (metrics.compressions.length > 0) {
  console.log(`\n🗜️  上下文压缩: ${metrics.compressions.length} 次`);
  metrics.compressions.forEach((c, i) => {
    const reduction = ((c.tokensBefore - c.tokensAfter) / c.tokensBefore * 100).toFixed(1);
    console.log(`   [${i+1}] ${c.msgBefore}→${c.msgAfter}条, ${c.tokensBefore}→${c.tokensAfter} tokens (-${reduction}%)`);
  });
}

if (metrics.autoForwards.length > 0) {
  console.log(`\n✉️  自动转发: ${metrics.autoForwards.length} 次`);
}

if (metrics.errors.length > 0) {
  console.log(`\n❌ 错误: ${metrics.errors.length} 个`);
  metrics.errors.slice(0, 5).forEach(e => console.log(`   ${e}`));
}

const reportPath = `/Users/zhuhanyuan/Desktop/performance-${Date.now()}.json`;
fs.writeFileSync(reportPath, JSON.stringify(metrics, null, 2));
console.log(`\n📄 详细报告: ${reportPath}\n`);
