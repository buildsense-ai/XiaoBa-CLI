#!/usr/bin/env node
/**
 * xiaoba-diary - 独立的工作日记生成工具
 * 管理多个 agent runtime，汇总生成每日工作日记
 *
 * 用法:
 *   node xiaoba-diary.js scan          # 扫描发现新的 agent runtime
 *   node xiaoba-diary.js diary [date]  # 生成工作日记
 *   node xiaoba-diary.js list          # 列出已知的 agent
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { readTurnSummaries } = require('./session-log-compat.cjs');

const DIARY_HOME = path.join(os.homedir(), '.xiaoba-diary');
const AGENTS_FILE = path.join(DIARY_HOME, 'agents.json');
const DIARIES_DIR = path.join(DIARY_HOME, 'diaries');
const CLEANED_DIR = path.join(DIARY_HOME, 'cleaned');

// ─── agents.json 管理 ────────────────────────────────────

function loadAgents() {
  if (!fs.existsSync(AGENTS_FILE)) {
    return { agents: [], scan_dirs: [path.join(os.homedir(), 'Documents')], last_scan: null };
  }
  return JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf-8'));
}

function saveAgents(data) {
  fs.mkdirSync(DIARY_HOME, { recursive: true });
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(data, null, 2));
}

// ─── 扫描发现新 agent ────────────────────────────────────

function scanForAgents() {
  const config = loadAgents();
  const knownPaths = new Set(config.agents.map(a => a.path));
  let found = 0;

  for (const scanDir of config.scan_dirs) {
    if (!fs.existsSync(scanDir)) continue;
    const entries = fs.readdirSync(scanDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(scanDir, entry.name);
      const logsPath = path.join(fullPath, 'logs', 'sessions');
      if (fs.existsSync(logsPath) && !knownPaths.has(fullPath)) {
        const id = entry.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        config.agents.push({ id, path: fullPath, added: new Date().toISOString().slice(0, 10) });
        knownPaths.add(fullPath);
        console.log(`发现新 agent: ${id} (${fullPath})`);
        found++;
      }
    }
  }

  config.last_scan = new Date().toISOString();
  saveAgents(config);
  console.log(`扫描完成，发现 ${found} 个新 agent，共 ${config.agents.length} 个`);
}

// ─── 清洗逻辑（复用原有逻辑）────────────────────────────

const DEBUG_LINE_RE = /^\s*(\[DEBUG\]|ℹ|✓|✗|Tool use|Tool result|Text 已发送)/;
const MAX_RESULT_LEN = 500;

function cleanUserText(text) {
  if (!text) return '';
  return text.replace(/```[\s\S]*?```/g, (block) => {
    const lines = block.split('\n').filter(l => !DEBUG_LINE_RE.test(l));
    return lines.length <= 2 ? '' : lines.join('\n');
  }).trim();
}

function simplifyResult(result, toolName) {
  if (!result || typeof result !== 'string') return '';

  // send_text/send_file 的结果完全丢弃（内容已在 assistant.text 里）
  if (toolName === 'send_text' || toolName === 'send_file') return '';

  // read_file 只保留文件路径
  if (toolName === 'read_file') {
    const m = result.match(/文件: (.+)/);
    return m ? `已读取: ${m[1]}` : '已读取文件';
  }

  // 失败的命令只保留"失败"标记
  if (result.startsWith('命令执行失败') || result.startsWith('错误：')) {
    const firstLine = result.split('\n').find(l => l.trim()) || '';
    return firstLine.slice(0, 100);
  }

  // 成功的命令保留前2行有效输出
  const lines = result.split('\n')
    .filter(l => !DEBUG_LINE_RE.test(l) && l.trim())
    .slice(0, 2);
  return lines.join('\n');
}

function cleanTurn(turn) {
  return {
    turn: turn.turn,
    time: turn.timestamp,
    user: cleanUserText(turn.user?.text || ''),
    tools: (turn.assistant?.tool_calls || []).map(tc => ({
      name: tc.name,
      args: (() => {
        try {
          const a = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
          const simplified = {};
          for (const [k, v] of Object.entries(a || {})) {
            // write_file/edit_file 的 content 参数截断
            if ((tc.name === 'write_file' || tc.name === 'edit_file') && (k === 'content' || k === 'new_string' || k === 'old_string')) {
              simplified[k] = typeof v === 'string' && v.length > 50 ? v.slice(0, 50) + '...' : v;
            } else {
              simplified[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '...' : v;
            }
          }
          return simplified;
        } catch { return tc.arguments; }
      })(),
    result: simplifyResult(tc.result, tc.name),
    })),
    reply: turn.assistant?.text || '',
  };
}

function readAgentSessions(agentPath, agentId, date) {
  const sessions = [];
  const sessionsDir = path.join(agentPath, 'logs', 'sessions');
  if (!fs.existsSync(sessionsDir)) return sessions;

  const platforms = fs.readdirSync(sessionsDir).filter(p =>
    fs.statSync(path.join(sessionsDir, p)).isDirectory()
  );

  for (const platform of platforms) {
    const dateDir = path.join(sessionsDir, platform, date);
    if (!fs.existsSync(dateDir)) continue;

    const files = fs.readdirSync(dateDir).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(dateDir, file), 'utf-8').trim();
      if (!content) continue;
      const turns = readTurnSummaries(content);
      if (turns.length === 0) continue;
      sessions.push({
        agent_id: agentId,
        session_id: file.replace('.jsonl', ''),
        platform,
        start_time: turns[0].timestamp,
        turns: turns.map(cleanTurn),
      });
    }
  }
  return sessions;
}

// ─── 格式化 & 生成 ───────────────────────────────────────

function formatForLLM(sessions, date) {
  const lines = [`# ${date} 工作记录（多 agent 汇总）\n`];
  for (const s of sessions) {
    lines.push(`## [${s.agent_id}] Session: ${s.session_id} (${s.platform}, ${s.turns.length} 轮)`);
    lines.push(`开始时间: ${s.start_time}\n`);
    for (const turn of s.turns) {
      const time = new Date(turn.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      if (turn.user) lines.push(`[${time}] 用户: ${turn.user}`);
      for (const tc of turn.tools) {
        if (!tc.result) continue; // 跳过空 result（send_text 等）
        lines.push(`  → ${tc.name}(${JSON.stringify(tc.args).slice(0, 100)})`);
        lines.push(`    结果: ${tc.result.slice(0, 200)}`);
      }
      if (turn.reply) lines.push(`  AI: ${turn.reply}`);
      lines.push('');
    }
    lines.push('---\n');
  }
  return lines.join('\n');
}

async function generateDiary(cleanedContent, date) {
  // 读取 .env 配置
  const envPath = path.join(os.homedir(), 'Documents', 'xiaoba', '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim();
    });
  }

  const apiKey = process.env.GAUZ_LLM_API_KEY;
  const apiUrl = process.env.GAUZ_LLM_API_BASE || 'https://api.anthropic.com';
  const model = process.env.GAUZ_LLM_MODEL || 'claude-opus-4-5';

  if (!apiKey) throw new Error('未找到 API Key，请检查 .env 配置');

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
    const body = JSON.stringify(isAnthropic
      ? { model, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }
      : { model, messages: [{ role: 'user', content: prompt }] }
    );

    const url = new URL(isAnthropic ? `${apiUrl}/v1/messages` : `${apiUrl}/chat/completions`);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(isAnthropic
          ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
          : { 'Authorization': `Bearer ${apiKey}` }),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(isAnthropic ? json.content?.[0]?.text : json.choices?.[0]?.message?.content);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── 主命令 ──────────────────────────────────────────────

async function main() {
  const cmd = process.argv[2] || 'diary';
  fs.mkdirSync(DIARIES_DIR, { recursive: true });
  fs.mkdirSync(CLEANED_DIR, { recursive: true });

  if (cmd === 'scan') {
    scanForAgents();
    return;
  }

  if (cmd === 'list') {
    const config = loadAgents();
    console.log(`已知 agent (${config.agents.length} 个):`);
    config.agents.forEach(a => console.log(`  ${a.id}: ${a.path}`));
    return;
  }

  if (cmd === 'diary') {
    const date = process.argv[3] || new Date().toISOString().slice(0, 10);
    const config = loadAgents();

    if (config.agents.length === 0) {
      console.log('没有已知的 agent，请先运行: node xiaoba-diary.js scan');
      return;
    }

    // 收集所有 agent 的 session
    let allSessions = [];
    for (const agent of config.agents) {
      const sessions = readAgentSessions(agent.path, agent.id, date);
      allSessions.push(...sessions);
      console.log(`${agent.id}: ${sessions.length} 个 session`);
    }

    allSessions.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));

    if (allSessions.length === 0) {
      console.log(`${date} 没有找到任何日志`);
      return;
    }

    const totalTurns = allSessions.reduce((s, x) => s + x.turns.length, 0);
    console.log(`共 ${allSessions.length} 个 session，${totalTurns} 轮对话`);

    const cleaned = formatForLLM(allSessions, date);
    const cleanedPath = path.join(CLEANED_DIR, `${date}-cleaned.txt`);
    fs.writeFileSync(cleanedPath, cleaned, 'utf-8');
    console.log(`清洗后内容: ${cleanedPath}`);

    console.log('正在生成工作日记...');
    const diary = await generateDiary(cleaned, date);

    const diaryPath = path.join(DIARIES_DIR, `${date}-diary.md`);
    fs.writeFileSync(diaryPath, `# ${date} 工作日记\n\n${diary}\n\n---\n*生成时间: ${new Date().toISOString()}*\n`);
    console.log(`工作日记: ${diaryPath}`);
    console.log('\n--- 预览 ---\n');
    console.log(diary.slice(0, 500) + '...');
  }
}

main().catch(console.error);
