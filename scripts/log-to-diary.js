#!/usr/bin/env node
/**
 * Session Log 转工作日记
 * 用法: node scripts/log-to-diary.js [date] [--platform catscompany|chat|cli|all]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { readTurnSummaries } = require('./session-log-compat.cjs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const LOGS_DIR = path.join(__dirname, '../logs/sessions');
const OUTPUT_DIR = path.join(__dirname, '../logs/diaries');

// ─── 清洗工具 ────────────────────────────────────────────

const DEBUG_LINE_RE = /^\s*(\[DEBUG\]|ℹ|✓|✗|Tool use|Tool result|Text 已发送)/;
const MAX_RESULT_LEN = 500;

function cleanUserText(text) {
  if (!text) return '';
  // 过滤掉 ``` 包裹的调试日志块
  return text.replace(/```[\s\S]*?```/g, (block) => {
    const lines = block.split('\n').filter(l => !DEBUG_LINE_RE.test(l));
    return lines.length <= 2 ? '' : lines.join('\n');
  }).trim();
}

function simplifyResult(result, toolName) {
  if (!result || typeof result !== 'string') return String(result || '');
  // 过滤调试行
  const lines = result.split('\n').filter(l => !DEBUG_LINE_RE.test(l));
  const cleaned = lines.join('\n').trim();
  if (cleaned.length <= MAX_RESULT_LEN) return cleaned;
  // 截断：保留前后各5行
  const arr = cleaned.split('\n');
  if (arr.length > 12) {
    return [...arr.slice(0, 5), `... (${arr.length - 10} 行省略) ...`, ...arr.slice(-5)].join('\n');
  }
  return cleaned.slice(0, MAX_RESULT_LEN) + '...';
}

function cleanTurn(turn) {
  const userText = cleanUserText(turn.user?.text || '');
  const toolCalls = (turn.assistant?.tool_calls || []).map(tc => ({
    name: tc.name,
    args: (() => {
      try {
        const a = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
        // 只保留关键参数，截断长字符串
        const simplified = {};
        for (const [k, v] of Object.entries(a || {})) {
          simplified[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '...' : v;
        }
        return simplified;
      } catch { return tc.arguments; }
    })(),
    result: simplifyResult(tc.result, tc.name),
  }));

  return {
    turn: turn.turn,
    time: turn.timestamp,
    user: userText,
    tools: toolCalls,
    reply: turn.assistant?.text || '',
  };
}

// ─── 读取 & 组织 ─────────────────────────────────────────

function readSessionLogs(date, platform) {
  const sessions = [];
  const platforms = platform === 'all'
    ? fs.readdirSync(LOGS_DIR).filter(p => fs.statSync(path.join(LOGS_DIR, p)).isDirectory())
    : [platform];

  for (const plat of platforms) {
    const dateDir = path.join(LOGS_DIR, plat, date);
    if (!fs.existsSync(dateDir)) continue;

    const files = fs.readdirSync(dateDir).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const filePath = path.join(dateDir, file);
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      if (!content) continue;

      const turns = readTurnSummaries(content);

      if (turns.length === 0) continue;

      sessions.push({
        session_id: file.replace('.jsonl', ''),
        platform: plat,
        start_time: turns[0].timestamp,
        turns: turns.map(cleanTurn),
      });
    }
  }

  // 按开始时间排序
  return sessions.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
}

// ─── 格式化为 LLM 输入 ───────────────────────────────────

function formatForLLM(sessions, date) {
  const lines = [`# ${date} 工作记录（清洗后）\n`];

  for (const session of sessions) {
    lines.push(`## Session: ${session.session_id} [${session.platform}] (${session.turns.length} 轮)`);
    lines.push(`开始时间: ${session.start_time}\n`);

    for (const turn of session.turns) {
      const time = new Date(turn.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      if (turn.user) lines.push(`[${time}] 用户: ${turn.user}`);
      for (const tc of turn.tools) {
        lines.push(`  → 工具: ${tc.name}(${JSON.stringify(tc.args).slice(0, 100)})`);
        if (tc.result) lines.push(`    结果: ${tc.result.slice(0, 200)}`);
      }
      if (turn.reply) lines.push(`  AI: ${turn.reply}`);
      lines.push('');
    }
    lines.push('---\n');
  }

  return lines.join('\n');
}

// ─── 调用 LLM 生成日记 ───────────────────────────────────

async function generateDiary(cleanedContent, date) {
  const apiKey = process.env.GAUZ_LLM_API_KEY;
  const apiUrl = process.env.GAUZ_LLM_API_BASE || 'https://api.anthropic.com';
  const model = process.env.GAUZ_LLM_MODEL || 'claude-opus-4-5';

  const prompt = `你是一个工作日志助手。根据以下 AI Agent 的工作记录，生成一份自然的工作日记。

要求：
1. 用第一人称（"我"）叙述，以 agent 的视角
2. 突出：今天做了什么、遇到了什么问题、怎么解决的、关键决策
3. 忽略技术细节（工具调用、token 数量等），用自然语言描述
4. 格式：Markdown，包含"今日工作"、"遇到的问题"、"解决方案"、"待跟进"四个部分
5. 简洁，不超过 800 字

工作记录：
${cleanedContent}

请生成工作日记：`;

  return new Promise((resolve, reject) => {
    const isAnthropic = apiUrl.includes('anthropic') || model.includes('claude');
    const body = isAnthropic
      ? JSON.stringify({ model, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] })
      : JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] });

    const url = new URL(isAnthropic ? `${apiUrl}/v1/messages` : `${apiUrl}/chat/completions`);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(isAnthropic
          ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
          : { 'Authorization': `Bearer ${apiKey}` }),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const text = isAnthropic
            ? json.content?.[0]?.text
            : json.choices?.[0]?.message?.content;
          resolve(text || '生成失败');
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── 主函数 ──────────────────────────────────────────────

async function main() {
  const date = process.argv[2] || new Date().toISOString().slice(0, 10);
  const platformArg = process.argv.find(a => a.startsWith('--platform='))?.split('=')[1] || 'all';

  console.log(`处理日期: ${date}, 平台: ${platformArg}`);

  const sessions = readSessionLogs(date, platformArg);
  if (sessions.length === 0) {
    console.log('没有找到日志数据');
    return;
  }

  console.log(`找到 ${sessions.length} 个 session，共 ${sessions.reduce((s, x) => s + x.turns.length, 0)} 轮对话`);

  const cleanedContent = formatForLLM(sessions, date);

  // 保存清洗后的内容
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const cleanedPath = path.join(OUTPUT_DIR, `${date}-cleaned.txt`);
  fs.writeFileSync(cleanedPath, cleanedContent, 'utf-8');
  console.log(`清洗后内容已保存: ${cleanedPath}`);

  // 生成日记
  console.log('正在调用 LLM 生成工作日记...');
  const diary = await generateDiary(cleanedContent, date);

  const diaryPath = path.join(OUTPUT_DIR, `${date}-diary.md`);
  const output = `# ${date} 工作日记\n\n${diary}\n\n---\n*生成时间: ${new Date().toISOString()}*\n`;
  fs.writeFileSync(diaryPath, output, 'utf-8');
  console.log(`工作日记已生成: ${diaryPath}`);
  console.log('\n--- 预览 ---\n');
  console.log(diary.slice(0, 500) + '...');
}

main().catch(console.error);
