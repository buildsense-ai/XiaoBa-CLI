/**
 * Cache Trace Dashboard
 *   npx tsx scripts/cache-dashboard.ts
 *   打开 http://127.0.0.1:3456
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

const PORT = parseInt(process.env.CACHE_DASHBOARD_PORT || '3456', 10);
const TRACE_DIR = path.resolve(process.env.CACHE_TRACE_DIR || 'logs/cache-trace');
const POLL_MS = parseInt(process.env.CACHE_POLLING_SECONDS || '5', 10) * 1000;

// --- types ------------------------------------------------------------

interface Entry {
  schema: string;
  session: { session_id: string; session_type: string; surface: string };
  turn: { turn_number: number; run_id: string };
  request: {
    timestamp: string;
    provider: string;
    model: string;
    system_prompt: any;
    message_count: number;
    estimated_tokens: number;
    tools_count: number;
    tools_sha256: string;
  };
  request_provider: any;
  response: { timestamp: string; duration_ms: number; stop_reason?: string };
  response_usage: {
    input_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    output_tokens: number;
    cache_hit_ratio: number;
  };
  diff: any;
}

// get turn number from entry (compat: old "turn" vs new "episode")
function tn(e: any): number { return e.episode?.episode_number ?? e.turn?.turn_number ?? 0; }

function sessionCategory(id: string): 'group' | 'subagent' | 'branch' | 'other' {
  if (id.startsWith('cc_group_')) return 'group';
  if (id.startsWith('subagent_')) return 'subagent';
  if (id.startsWith('branch_')) return 'branch';
  return 'other';
}

function loadSessions(): Map<string, string> {
  const m = new Map<string, string>();
  if (!fs.existsSync(TRACE_DIR)) return m;
  for (const date of fs.readdirSync(TRACE_DIR)) {
    const dp = path.join(TRACE_DIR, date);
    if (!fs.statSync(dp).isDirectory()) continue;
    for (const sid of fs.readdirSync(dp)) {
      const sp = path.join(dp, sid);
      if (fs.statSync(sp).isDirectory()) m.set(sid, sp);
    }
  }
  return m;
}

function entriesFrom(sessionPath: string): Entry[] {
  const out: Entry[] = [];
  for (const f of fs.readdirSync(sessionPath).sort()) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(sessionPath, f), 'utf-8'))); }
    catch { /* skip */ }
  }
  // Filenames are episode-based and restart after a model switch. The actual
  // conversation order is the request/response timestamp order.
  return out.sort((a, b) => {
    const at = a.response?.timestamp || a.request?.timestamp || '';
    const bt = b.response?.timestamp || b.request?.timestamp || '';
    return at.localeCompare(bt);
  });
}

// group by conversation episode (one user message -> AI answer)
function episodes(entries: Entry[]): { episodes: Entry[]; subCalls: number[] } {
  const m = new Map<number, Entry[]>();
  for (const e of entries) {
    const tn = tn(e);
    if (!m.has(tn)) m.set(tn, []);
    m.get(tn)!.push(e);
  }
  const nums = Array.from(m.keys()).sort((a, b) => a - b);
  return {
    episodes: nums.map(n => m.get(n)!.reduce((a, b) => a.response.timestamp > b.response.timestamp ? a : b)),
    subCalls: nums.map(n => m.get(n)!.length),
  };
}

// --- server -----------------------------------------------------------

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const u = new URL(req.url!, `http://localhost:${PORT}`);

  try {
    if (u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page());
      return;
    }
    if (u.pathname === '/api/sessions') {
      const sessions = loadSessions();
      const list: any[] = [];
      for (const [id, sp] of sessions) {
        const all = entriesFrom(sp);
        if (all.length === 0) continue;
        const last = all[all.length - 1];
        let totalHit = 0, totalIn = 0, totalCache = 0;
        for (const e of all) {
          totalHit += e.response_usage.cache_hit_ratio;
          totalIn += e.response_usage.input_tokens;
          totalCache += e.response_usage.cache_read_tokens;
        }
        const models = Array.from(new Set(all.map(e => e.request.provider + '/' + e.request.model)));
        const segments = models.length;
        list.push({
          id,
          type: last.session.session_type,
          surface: last.session.surface,
          turns: all.length,
          episodes: new Set(all.map(e => tn(e))).size,
          provider: last.request.provider,
          model: last.request.model,
          models,
          segments,
          avgCacheHitRatio: Math.round((totalHit / all.length) * 1000) / 1000,
          totalInputTokens: totalIn,
          totalCacheReadTokens: totalCache,
          lastUpdated: last.response?.timestamp || last.request?.timestamp || '',
          category: sessionCategory(id),
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list.sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated))));
      return;
    }
    const m = u.pathname.match(/^\/api\/session\/(.+)$/);
    if (m) {
      const sessions = loadSessions();
      const sp = sessions.get(decodeURIComponent(m[1]));
      if (!sp) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(entriesFrom(sp)));
      return;
    }
    res.writeHead(404); res.end('not found');
  } catch (e: any) {
    res.writeHead(500); res.end(e.message);
  }
});

server.listen(PORT, () => {
  console.log(`\nCache Trace Dashboard → http://localhost:${PORT}`);
  console.log(`Logs: ${TRACE_DIR}\n`);
});

// --- page -------------------------------------------------------------

function page(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cache Trace Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d1117;color:#c9d1d9;padding:20px}
h1{font-size:22px;margin-bottom:4px;color:#58a6ff}
.sub{font-size:13px;color:#8b949e;margin-bottom:16px}
.ctls{display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap}
select,button{padding:6px 12px;border-radius:6px;border:1px solid #30363d;background:#161b22;color:#c9d1d9;font-size:14px;cursor:pointer}
button:hover{background:#21262d}
.session-picker{min-width:420px;max-width:650px;flex:1;background:linear-gradient(135deg,#161b22,#111a26);border:1px solid #30363d;border-radius:9px;padding:9px 10px;box-shadow:inset 0 1px 0 rgba(255,255,255,.03)}
.session-picker-head{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:6px;font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.06em}.session-picker-head b{color:#79c0ff;font-size:12px;letter-spacing:0}.session-picker select{width:100%;min-width:0;border-color:#3b4858;background:#0d1117}.session-picker optgroup{color:#79c0ff;font-style:normal;font-weight:600}.session-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:7px;color:#8b949e;font-size:11px}@media(max-width:620px){.session-picker{min-width:100%}}
#anomaly{background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.3);border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:13px;color:#f85149;display:none}
#anomaly.show{display:block}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:16px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}
.card .lbl{font-size:12px;color:#8b949e;margin-bottom:4px}
.card .val{font-size:22px;font-weight:600;color:#58a6ff}
.card .val.g{color:#3fb950}
.card .val.y{color:#d2991d}
.card .val.r{color:#f85149}
.charts{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px}
@media(max-width:900px){.charts{grid-template-columns:1fr}}
.cc{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}
.cc h3{font-size:14px;color:#8b949e;margin-bottom:10px}
.cw{position:relative;height:260px}
.cw canvas{width:100%!important;height:100%!important}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:7px 10px;text-align:left;border-bottom:1px solid #21262d}
th{color:#8b949e;font-weight:500}
.collapse-toggle{cursor:pointer;color:#58a6ff;font-size:13px;margin-left:8px;user-select:none}
.collapse-toggle:hover{color:#79c0ff}
.diff-wrap{overflow:hidden;transition:max-height .3s}
.diff-wrap.open{max-height:9999px}
.diff-wrap.closed{max-height:0}
.hit{color:#3fb950;font-weight:600}
.miss{color:#f85149;font-weight:600}
.help-tip{display:inline-block;width:15px;height:15px;line-height:15px;text-align:center;font-size:10px;font-weight:700;background:#21262d;color:#8b949e;border-radius:50%;cursor:help;margin-left:3px}
.help-tip:hover{background:#30363d;color:#c9d1d9}
.help-tip:hover::after{content:attr(data-tip);position:absolute;bottom:130%;left:50%;transform:translateX(-50%);background:#30363d;color:#c9d1d9;padding:6px 10px;border-radius:6px;font-size:12px;font-weight:400;white-space:nowrap;z-index:10;pointer-events:none}
tr.anomaly{background:rgba(248,81,73,0.08)!important}
tbody.closed tr{display:none}
.ep-row:hover{background:rgba(88,166,255,0.06)}
.copy-btn{cursor:pointer;opacity:0.4;font-size:12px}
.copy-btn:hover{opacity:0.9}
.note{font-size:12px;color:#8b949e;margin-top:8px}
.segment-note{grid-column:1/-1;line-height:1.5;padding:2px 4px}
.segment-row td{background:#0f1924;color:#79c0ff;font-weight:600;border-top:1px solid #30363d}
.segment-row span,.base{color:#8b949e;font-weight:400;font-size:11px;margin-left:6px}
.overview-wrap{overflow:hidden;transition:max-height .3s}.overview-wrap.open{max-height:1800px}.overview-wrap.closed{max-height:0}
.turn-row{cursor:pointer}.turn-row:hover{background:rgba(88,166,255,.06)!important}.turn-diff.closed{display:none}.turn-diff td{padding:0;border-bottom:1px solid #30363d}.turn-diff-content{padding:12px 16px 16px;background:#0d1117}.diff-summary{font-size:13px;margin-bottom:10px;color:#c9d1d9}.snapshot-meta{font-size:11px;color:#8b949e;margin:5px 0 10px;word-break:break-all}.suffix-impact{margin:10px 0;padding:9px 10px;border:1px solid rgba(210,153,29,.45);border-radius:7px;background:rgba(210,153,29,.08);color:#e3b341;font-size:12px;line-height:1.55}.suffix-impact b{color:#f2cc60}.payload-diff{border:1px solid #30363d;border-radius:7px;overflow:hidden;background:#161b22}.payload-diff-head{padding:8px 10px;background:#0f1924;color:#c9d1d9;font-size:12px}.payload-diff-head b{color:#79c0ff}.payload-diff-body{padding:10px}.diff-context,.diff-removed,.diff-added{display:grid;grid-template-columns:82px minmax(0,1fr);gap:8px;padding:7px 9px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word}.diff-context{color:#8b949e;background:#0d1117}.diff-removed{color:#ffb4b4;background:rgba(248,81,73,.12);border-left:3px solid #f85149}.diff-added{color:#a7f3ba;background:rgba(63,185,80,.12);border-left:3px solid #3fb950}.diff-tag{font-weight:700;color:#8b949e}.diff-removed .diff-tag{color:#f85149}.diff-added .diff-tag{color:#3fb950}.diff-empty{color:#d2991d;padding:8px 0;font-size:12px}.raw-payload{margin-top:9px;font-size:11px;color:#8b949e}.raw-payload summary{cursor:pointer;color:#58a6ff}.raw-payload pre{margin-top:8px;max-height:280px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:9px;color:#c9d1d9}.snapshot-empty{color:#d2991d;font-size:12px}@media(max-width:900px){.diff-context,.diff-removed,.diff-added{grid-template-columns:1fr}.diff-tag{margin-bottom:2px}}
</style>
</head>
<body>
<h1>Cache Trace Dashboard</h1>
<div class="sub" id="dataDir">${TRACE_DIR}</div>
<div class="ctls">
  <div class="session-picker">
    <div class="session-picker-head"><span>Session</span><b id="sessionCount">loading</b></div>
    <select id="sel"><option value="">loading sessions…</option></select>
    <div class="session-meta" id="sessionMeta">Fetching latest session activity…</div>
  </div>
  <button id="refreshBtn">refresh</button>
  <label style="font-size:13px;color:#8b949e;display:flex;align-items:center;gap:4px">
    <input type="checkbox" id="auto" checked> auto (${POLL_MS / 1000}s)
  </label>
</div>
<div id="anomaly"></div>
<div class="cc" style="margin-top:16px"><h3>Session overview <span class="collapse-toggle" id="overviewBtn" onclick="toggleOverview()">hide</span></h3>
  <div class="overview-wrap open" id="overviewBody">
    <div class="charts">
      <div class="cc"><h3>Hit Rate</h3><div class="cw"><canvas id="chartHit"></canvas></div></div>
      <div class="cc"><h3>Tokens</h3><div class="cw"><canvas id="chartTokens"></canvas></div></div>
    </div>
    <div class="grid" id="stats"></div>
  </div>
</div>
<div id="diff"></div>
<div id="copy-feedback" style="display:none;position:fixed;bottom:20px;right:20px;background:#161b22;border:1px solid #30363d;padding:8px 14px;border-radius:6px;font-size:13px;color:#58a6ff;z-index:100"></div>
<div class="note" id="lastRefresh"></div>

<script>
const API = '/api/';
let chartHit = null, chartTokens = null;
let timer = null, currentId = '', lastRenderFingerprint = '', sessionListFingerprint = '';
let turnByKey = {}, turnByRun = {};

async function j(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw Error('HTTP ' + r.status);
    return r.json();
  } catch(e) {
    document.getElementById('anomaly').innerHTML = 'Fetch error: ' + e.message + ' — ' + url;
    document.getElementById('anomaly').classList.add('show');
    throw e;
  }
}
function clz(r) { return r >= 0.8 ? 'g' : r >= 0.4 ? 'y' : 'r'; }
function fmt(n) { return n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(n); }
function gtn(e) { return e.episode?.episode_number ?? e.turn?.turn_number ?? 0; }

function modelKey(e) { return (e.request?.provider || 'unknown') + '/' + (e.request?.model || 'unknown'); }
function apiType(e) {
  const type = e.request_provider?.api_type;
  if (type === 'anthropic-messages') return 'Anthropic Messages';
  if (type === 'openai-chat-completions') return 'OpenAI Chat Completions';
  if (type === 'openai-responses') return 'OpenAI Responses';
  return 'API not recorded';
}
function requestKey(e) { return modelKey(e) + ' · ' + apiType(e); }
function fmtUpdated(iso) { if (!iso) return 'time unknown'; const d=new Date(iso); return isNaN(d)?'time unknown':d.toLocaleString([], {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}); }
const SESSION_GROUPS=[
  ['group','群聊'], ['subagent','子智能体'], ['branch','分支智能体'], ['other','其他']
];
function sessionMeta(s) { return s ? s.categoryLabel+' · updated '+fmtUpdated(s.lastUpdated)+' · '+s.turns+' turns · '+(s.avgCacheHitRatio*100).toFixed(0)+'% cache hit' : 'Choose a session'; }
function splitModelSegments(entries) {
  const out = [];
  for (const e of entries) {
    const key = requestKey(e);
    const last = out[out.length - 1];
    if (!last || last.key !== key) out.push({ key, entries: [e] });
    else last.entries.push(e);
  }
  return out;
}

async function loadSessions() {
  const list = await j(API + 'sessions');
  list.forEach(s => { s.categoryLabel=(SESSION_GROUPS.find(g=>g[0]===s.category)||SESSION_GROUPS[3])[1]; });
  const signature = list.map(s => s.id+':'+s.lastUpdated+':'+s.turns).join('|');
  if (signature === sessionListFingerprint) return list;
  sessionListFingerprint = signature;
  const sel = document.getElementById('sel');
  const selected = sel.value;
  sel.innerHTML = '<option value="">Choose a session · '+list.length+' total</option>';
  SESSION_GROUPS.forEach(([key,label]) => {
    const group=list.filter(s=>s.category===key);
    if (!group.length) return;
    const og=document.createElement('optgroup');
    og.label=label+' · '+group.length;
    group.forEach(s => {
      const o=document.createElement('option');
      o.value=s.id;
      const modelText=s.models?.length>1?s.models.length+' model segments':s.provider+'/'+s.model;
      o.textContent=s.id+'  ·  '+fmtUpdated(s.lastUpdated)+'  ·  '+s.turns+' turns  ·  '+(s.avgCacheHitRatio*100).toFixed(0)+'%  ·  '+modelText;
      og.appendChild(o);
    });
    sel.appendChild(og);
  });
  document.getElementById('sessionCount').textContent=list.length+' sessions · newest first';
  const active=list.find(s=>s.id===selected) || null;
  if (active) sel.value=active.id;
  document.getElementById('sessionMeta').textContent=sessionMeta(active);
  window.sessionList=list;
  return list;
}

function toggleOverview() {
  const d = document.getElementById('overviewBody');
  const t = document.getElementById('overviewBtn');
  if (d.classList.contains('open')) { d.classList.replace('open','closed'); t.textContent='show'; }
  else { d.classList.replace('closed','open'); t.textContent='hide'; }
}
function toggleEp(n) {
  const el = document.getElementById('turns-ep'+n);
  const ar = document.getElementById('arr-ep'+n);
  if (el.classList.contains('closed')) { el.classList.remove('closed'); ar.textContent = '▼'; }
  else { el.classList.add('closed'); ar.textContent = '▶'; }
}
function copyMeta(sid, ep, ti, rid) {
  const txt = 'session='+sid+' episode='+ep+' turn='+ti+' run='+rid;
  navigator.clipboard.writeText(txt).then(() => {
    const el = document.getElementById('copy-feedback');
    if (el) { el.textContent = 'copied: '+txt; el.style.display='block'; setTimeout(() => el.style.display='none', 2000); }
  });
}
function esc(v) { return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;'); }
function payloadMessages(e) {
  const p=e?.request_provider?.request_snapshot?.payload;
  if (Array.isArray(p?.messages)) return p.messages;
  if (Array.isArray(p?.input)) return p.input;
  return null;
}
function pretty(v) { const t=JSON.stringify(v,null,2); return t.length>6000?t.slice(0,6000)+'\\n… truncated at 6,000 chars':t; }
function payloadSignature(v) { try { return JSON.stringify(v); } catch { return String(v); } }
function payloadText(v, depth=0) {
  if (v == null || depth > 6) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(x=>payloadText(x,depth+1)).filter(Boolean).join('\\n');
  if (typeof v !== 'object') return '';
  for (const key of ['text','content','output_text','input_text','output','arguments']) {
    if (v[key] != null) { const text=payloadText(v[key],depth+1); if (text) return text; }
  }
  return '';
}
function payloadKind(v) { return v?.role || v?.type || 'structured payload item'; }
function clipText(v, limit=3200) { return v.length>limit ? v.slice(0,limit)+'\\n… truncated at '+limit.toLocaleString()+' chars' : v; }
function payloadChange(before, after) {
  const bs=before.map(payloadSignature), as=after.map(payloadSignature);
  let prefix=0; while(prefix<bs.length && prefix<as.length && bs[prefix]===as[prefix]) prefix++;
  let suffix=0; while(suffix<bs.length-prefix && suffix<as.length-prefix && bs[bs.length-1-suffix]===as[as.length-1-suffix]) suffix++;
  return {prefix,suffix,before:before.slice(prefix,before.length-suffix),after:after.slice(prefix,after.length-suffix)};
}
function textDiffHtml(before, after) {
  let head=0; const maxHead=Math.min(before.length,after.length);
  while(head<maxHead && before[head]===after[head]) head++;
  let tail=0; const maxTail=Math.min(before.length-head,after.length-head);
  while(tail<maxTail && before[before.length-1-tail]===after[after.length-1-tail]) tail++;
  const sameBefore=before.slice(Math.max(0,head-360),head);
  const removed=clipText(before.slice(head,before.length-tail));
  const added=clipText(after.slice(head,after.length-tail));
  const sameAfter=before.slice(before.length-tail,Math.min(before.length-tail+360,before.length));
  let h='<div class="payload-diff-body">';
  if (sameBefore) h+='<div class="diff-context"><span class="diff-tag">context</span><span>…'+esc(sameBefore)+'</span></div>';
  if (removed) h+='<div class="diff-removed"><span class="diff-tag">− removed</span><span>'+esc(removed)+'</span></div>';
  if (added) h+='<div class="diff-added"><span class="diff-tag">+ added</span><span>'+esc(added)+'</span></div>';
  if (sameAfter) h+='<div class="diff-context"><span class="diff-tag">context</span><span>'+esc(sameAfter)+'…</span></div>';
  if (!removed && !added) h+='<div class="diff-empty">The payload items differ structurally, but no displayable text changed.</div>';
  return h+'</div>';
}
function changedItemText(items) {
  return items.slice(0,1).map(v=>'['+payloadKind(v)+']\\n'+(payloadText(v)||'(no displayable text in this payload item)')).join('\\n');
}
function suffixImpactHtml(e, change, after) {
  const suffix=after.slice(change.prefix), totalChars=payloadSignature(after).length, suffixChars=payloadSignature(suffix).length;
  if (!suffix.length) return '<div class="suffix-impact"><b>缓存失效后缀</b> · 当前 payload 在首次分叉处结束，没有后续消息。</div>';
  const first=change.prefix+1, last=after.length, ratio=totalChars ? suffixChars/totalChars : 0;
  const inputTokens=Number(e.response_usage?.input_tokens)||0;
  const estimatedTokens=inputTokens ? Math.round(inputTokens*ratio) : 0;
  let h='<div class="suffix-impact"><b>缓存失效后缀</b> · 当前 payload M'+first+'–M'+last+'：'+suffix.length+' 项，'+fmt(suffixChars)+' chars，占当前消息 payload '+(ratio*100).toFixed(1)+'%';
  if (estimatedTokens) h+='；约 '+fmt(estimatedTokens)+' / '+fmt(inputTokens)+' input tokens（按消息 payload 字符占比估算）';
  return h+'。内容没有被改坏；即使尾部文本相同，首个分叉后也不能回到同一连续缓存前缀。</div>';
}
function turnDiffHtml(e, previous) {
  const d=e.diff||{}, snap=e.request_provider?.request_snapshot, previousSnap=previous?.request_provider?.request_snapshot;
  const prefix=Number.isInteger(d.message_prefix_identical_until_index)?d.message_prefix_identical_until_index:null;
  const run=e.episode?.run_id??e.turn?.run_id??'';
  let h='<div class="diff-summary"><b>Current run</b> '+esc(run)+' · <b>previous</b> '+esc(d.previous_run_id||'none')+' · ';
  h+=prefix===null?'No earlier request baseline.':'Trace first fork: M'+(prefix+1)+'; '+(d.message_changed_count||0)+' message(s) changed.';
  h+='</div>';
  if (!previous) return h+'<div class="snapshot-empty">No previous run in this model/API segment, so there is no cache Diff baseline.</div>';
  if (!snap || !previousSnap) return h+'<div class="snapshot-empty">Request text was not recorded for one or both runs. This old trace can show hashes only; restart with the current trace logger to inspect SDK-final text.</div>';
  const before=payloadMessages(previous), after=payloadMessages(e);
  if (!before || !after) return h+'<div class="snapshot-empty">SDK payload is recorded, but this provider shape has no comparable messages/input array.</div>';
  const change=payloadChange(before,after);
  const beforeText=changedItemText(change.before), afterText=changedItemText(change.after);
  h+='<div class="snapshot-meta">Final payload: '+before.length+' → '+after.length+' items · first payload fork '+(change.prefix+1)+' · shared suffix '+change.suffix+'. Cache reuse stops at this first payload fork; only its changed item is shown and the remaining changed tail is collapsed.</div>';
  h+=suffixImpactHtml(e,change,after);
  h+='<div class="payload-diff"><div class="payload-diff-head"><b>SDK-final text Diff</b> · payload item '+(change.prefix+1)+' · '+esc(payloadKind(change.before[0]))+' → '+esc(payloadKind(change.after[0]))+'</div>';
  h+=textDiffHtml(beforeText,afterText)+'</div>';
  h+='<details class="raw-payload"><summary>Show sanitized raw payload items</summary><pre>Previous\\n'+esc(pretty(change.before[0]))+'\\n\\nCurrent\\n'+esc(pretty(change.after[0]))+'</pre></details>';
  return h;
}
function toggleTurn(key) {
  const row=document.getElementById('turn-diff-'+key), box=document.getElementById('turn-diff-content-'+key);
  if (!row || !box) return;
  if (row.classList.contains('closed')) { box.innerHTML=turnDiffHtml(turnByKey[key],turnByRun[(turnByKey[key].diff||{}).previous_run_id]); row.classList.remove('closed'); }
  else row.classList.add('closed');
}

async function render(id, force = false) {
  if (!id) return;
  currentId = id;
  const all = await j(API + 'session/' + encodeURIComponent(id));
  if (!all.length) return;
  const newest = all[all.length - 1];
  const newestRunId = newest.episode?.run_id ?? newest.turn?.run_id ?? '';
  const fingerprint = id + '|' + all.length + '|' + newestRunId + '|' + (newest.response?.timestamp ?? '');
  if (!force && fingerprint === lastRenderFingerprint) {
    document.getElementById('lastRefresh').textContent = 'checked: ' + new Date().toLocaleTimeString() + ' · no new trace data';
    return;
  }
  lastRenderFingerprint = fingerprint;

  // Entries are chronological. A provider/model change starts a fresh cache
  // namespace, so never aggregate or compare across this boundary.
  const segments = splitModelSegments(all);
  const rows = [];
  segments.forEach((seg, si) => {
    const groups = {};
    for (const e of seg.entries) {
      const n = gtn(e);
      if (!groups[n]) groups[n] = [];
      groups[n].push(e);
    }
    Object.keys(groups).map(Number).sort((a,b)=>a-b).forEach(n => {
      const turns = groups[n];
      const best = turns.reduce((a,b)=>(a.response.timestamp > b.response.timestamp ? a : b));
      rows.push({si, key:seg.key, n, turns, best, id:'s'+si+'-e'+n, firstInSegment: rows.filter(r=>r.si===si).length===0});
    });
  });
  // Keep overview charts chronological, but render investigation rows newest first.
  // Segments are contiguous in time, so reversing segments and their episodes preserves
  // a true newest-to-oldest order even when episode numbering restarts after a model switch.
  const displayRows = [];
  [...segments].reverse().forEach(seg => {
    const si = segments.indexOf(seg);
    const segmentRows = rows.filter(r => r.si === si)
      .sort((a,b) => b.best.response.timestamp.localeCompare(a.best.response.timestamp));
    segmentRows.forEach((row, index) => displayRows.push({...row, displayFirstInSegment: index === 0}));
  });
  const last = all[all.length-1];
  const eps = rows.map(r=>r.best);

  let totalIn=0, totalCache=0, totalOut=0;
  for (const e of eps) { totalIn+=e.response_usage.input_tokens; totalCache+=e.response_usage.cache_read_tokens; totalOut+=e.response_usage.output_tokens; }
  const avgHit = eps.reduce((sum,e)=>sum+e.response_usage.cache_hit_ratio,0)/eps.length;
  const segmentSummaries = segments.map((seg,si) => {
    const rs=rows.filter(r=>r.si===si), avg=rs.reduce((sum,r)=>sum+r.best.response_usage.cache_hit_ratio,0)/rs.length;
    return 'S'+(si+1)+' '+seg.key+' · '+rs.length+' episodes · '+(avg*100).toFixed(0)+'%';
  });

  // Detect drops only inside the same model segment. A cross-model zero is
  // expected and must never be presented as a cache anomaly.
  const anomalies = [];
  segments.forEach((seg,si) => {
    const rs=rows.filter(r=>r.si===si);
    for (let i=1;i<rs.length;i++) {
      const d=rs[i-1].best.response_usage.cache_hit_ratio-rs[i].best.response_usage.cache_hit_ratio;
      if (d>0.4) anomalies.push({from:rs[i-1],to:rs[i],drop:d});
    }
  });
  const anoRows = new Set(anomalies.map(a=>a.to.id));
  const adiv=document.getElementById('anomaly');
  if (anomalies.length) {
    adiv.innerHTML='Same-model drops >40%: '+anomalies.map(a=>'S'+(a.to.si+1)+' E'+a.from.n+'→E'+a.to.n+' ('+(a.from.best.response_usage.cache_hit_ratio*100).toFixed(0)+'%→'+(a.to.best.response_usage.cache_hit_ratio*100).toFixed(0)+'%)').join('  ');
    adiv.classList.add('show');
  } else adiv.classList.remove('show');

  document.getElementById('stats').innerHTML=
    '<div class="card"><div class="lbl">Model Segments</div><div class="val">'+segments.length+'</div></div>'+
    '<div class="card"><div class="lbl">Episodes (calls)</div><div class="val">'+rows.length+' <span style="font-size:14px;color:#8b949e">/ '+all.length+'</span></div></div>'+
    '<div class="card"><div class="lbl">Session Avg Hit</div><div class="val '+clz(avgHit)+'">'+(avgHit*100).toFixed(1)+'%</div></div>'+
    '<div class="card"><div class="lbl">Input Tokens</div><div class="val">'+fmt(totalIn)+'</div></div>'+
    '<div class="card"><div class="lbl">Cache Read</div><div class="val g">'+fmt(totalCache)+'</div></div>'+
    '<div class="card"><div class="lbl">Current Model</div><div class="val" style="font-size:15px">'+modelKey(last)+'</div></div>'+
    '<div class="note segment-note">'+segmentSummaries.join('<br>')+'<br>Each model segment has an independent cache baseline; no cross-model anomaly or diff is implied.</div>';

  if (chartHit) chartHit.destroy();
  if (chartTokens) chartTokens.destroy();
  const labels=rows.map(r=>'S'+(r.si+1)+':E'+r.n+(r.turns.length>1?'×'+r.turns.length:''));
  const palette=['#58a6ff','#a371f7','#d29922','#39c5cf','#f778ba'];
  const hitSets=segments.map((seg,si)=>({label:'S'+(si+1)+' '+seg.key,data:rows.map(r=>r.si===si?r.best.response_usage.cache_hit_ratio*100:null),borderColor:palette[si%palette.length],backgroundColor:palette[si%palette.length]+'22',fill:false,tension:.3,spanGaps:false,pointRadius:5,pointBackgroundColor:rows.map(r=>r.si===si?(anoRows.has(r.id)?'#f85149':palette[si%palette.length]):'transparent')}));
  chartHit=new Chart(document.getElementById('chartHit').getContext('2d'),{type:'line',data:{labels,datasets:hitSets},options:{responsive:true,maintainAspectRatio:false,scales:{y:{min:0,max:105,ticks:{callback:v=>v+'%',color:'#8b949e'},grid:{color:'#21262d'},title:{display:true,text:'Hit Rate %',color:'#8b949e'}},x:{ticks:{color:'#8b949e',maxRotation:0},grid:{color:'#21262d'},title:{display:true,text:'Model segment : Episode',color:'#8b949e'}}},plugins:{legend:{labels:{color:'#8b949e'}}}}});
  chartTokens=new Chart(document.getElementById('chartTokens').getContext('2d'),{type:'bar',data:{labels,datasets:[{label:'Cache Read',data:rows.map(r=>r.best.response_usage.cache_read_tokens),backgroundColor:'#3fb950',stack:'in'},{label:'Fresh',data:rows.map(r=>r.best.response_usage.input_tokens-r.best.response_usage.cache_read_tokens),backgroundColor:'#30363d',stack:'in'},{label:'Output',data:rows.map(r=>r.best.response_usage.output_tokens),backgroundColor:'#58a6ff'}]},options:{responsive:true,maintainAspectRatio:false,scales:{y:{stacked:false,ticks:{color:'#8b949e'},grid:{color:'#21262d'},title:{display:true,text:'Tokens',color:'#8b949e'}},x:{ticks:{color:'#8b949e',maxRotation:0},grid:{color:'#21262d'},title:{display:true,text:'Model segment : Episode',color:'#8b949e'}}},plugins:{legend:{labels:{color:'#8b949e'}}}}});

  const expandedBefore=new Set();
  document.querySelectorAll('[id^="arr-ep"]').forEach(el=>{if(el.textContent==='▼') expandedBefore.add(el.id.replace('arr-ep',''));});
  turnByKey={}; turnByRun={}; all.forEach(e=>{const rid=e.episode?.run_id??e.turn?.run_id??''; if(rid) turnByRun[rid]=e;});
  let dh='<div class="cc"><h3>Cache Diff</h3><div class="note" style="margin:0 0 10px">Newest first. Open an Episode, then a Turn, to inspect its previous request against the current SDK-final payload.</div><table><thead><tr><th>Model / API · Segment / Episode / Turn</th><th>Hit %</th><th>Stable<span class="help-tip" data-tip="System prompt stable part same as previous same-model turn?">?</span></th><th>Tools<span class="help-tip" data-tip="Tool list same as previous same-model turn?">?</span></th><th>Prefix before fork<span class="help-tip" data-tip="Messages matching before the first difference.">?</span></th><th>Same Msgs</th><th>Changed</th><th>Duration</th></tr></thead>';
  displayRows.forEach(row=>{
    if (row.displayFirstInSegment) dh+='<tbody><tr class="segment-row"><td colspan="8">S'+(row.si+1)+' · '+row.key+' <span>latest → oldest</span></td></tr></tbody>';
    const best=row.best, bd=best.diff||{}, wasOpen=expandedBefore.has(row.id), an=anoRows.has(row.id);
    dh+='<tbody><tr class="ep-row'+(an?' anomaly':'')+'" data-ep="'+row.id+'" style="cursor:pointer" onclick="toggleEp(this.dataset.ep)">';
    dh+='<td><span id="arr-ep'+row.id+'">'+(wasOpen?'▼':'▶')+'</span> '+(an?'! ':'')+'S'+(row.si+1)+' · E'+row.n+' ('+row.turns.length+' turns)<br><span class="base">'+modelKey(best)+' · '+apiType(best)+'</span></td>';
    dh+='<td><span class="'+(best.response_usage.cache_hit_ratio<0.4?'miss':'hit')+'">'+(best.response_usage.cache_hit_ratio*100).toFixed(0)+'%</span></td>';
    dh+='<td>'+(row.firstInSegment?'<span class="base">baseline</span>':(bd.stable_system_identical?'<span class="hit">yes</span>':'<span class="miss">no</span>'))+'</td>';
    dh+='<td>'+(row.firstInSegment?'<span class="base">baseline</span>':(bd.tools_identical?'<span class="hit">yes</span>':'<span class="miss">no</span>'))+'</td>';
    dh+='<td>'+(row.firstInSegment?'<span class="base">—</span>':(bd.message_prefix_identical_until_index!=null?bd.message_prefix_identical_until_index:'-'))+'</td>';
    dh+='<td>'+(row.firstInSegment?'<span class="base">—</span>':(bd.message_identical_count||0))+'</td>';
    dh+='<td>'+(row.firstInSegment?'<span class="base">—</span>':(bd.message_changed_count||0))+'</td>';
    dh+='<td>'+best.response.duration_ms+'ms</td></tr></tbody>';
    dh+='<tbody id="turns-ep'+row.id+'" class="'+(wasOpen?'':'closed')+'">';
    const displayTurns=[...row.turns].sort((a,b)=>b.response.timestamp.localeCompare(a.response.timestamp));
    displayTurns.forEach((t,ti)=>{
      const originalTi=row.turns.indexOf(t), actualTurn=originalTi+1;
      const td=t.diff||{}, isFirst=row.firstInSegment&&originalTi===0, isLast=t===best, rid=t.episode?.run_id??t.turn?.run_id??'', key=row.id+'-t'+originalTi;
      turnByKey[key]=t;
      const cell=(value)=>isFirst?'<span class="base">baseline</span>':value;
      dh+='<tr class="turn-row" style="font-size:12px;'+(isLast?'background:rgba(88,166,255,0.06)':'')+'" onclick="event.stopPropagation();toggleTurn(&quot;'+key+'&quot;)"><td style="padding-left:30px">↳ T'+actualTurn+(isLast?' (latest)':'')+' <span class="base">click for request diff</span> <span class="copy-btn" data-sid="'+currentId+'" data-ep="'+row.n+'" data-ti="'+actualTurn+'" data-rid="'+rid+'" onclick="event.stopPropagation();var e=this;copyMeta(e.dataset.sid,parseInt(e.dataset.ep),parseInt(e.dataset.ti),e.dataset.rid)" title="copy meta">📋</span></td>';
      dh+='<td><span class="'+(t.response_usage.cache_hit_ratio<0.4?'miss':'hit')+'">'+(t.response_usage.cache_hit_ratio*100).toFixed(0)+'%</span></td>';
      dh+='<td>'+cell(td.stable_system_identical?'<span class="hit">yes</span>':'<span class="miss">no</span>')+'</td><td>'+cell(td.tools_identical?'<span class="hit">yes</span>':'<span class="miss">no</span>')+'</td><td>'+cell(td.message_prefix_identical_until_index!=null?td.message_prefix_identical_until_index:'-')+'</td><td>'+cell(td.message_identical_count||0)+'</td><td>'+cell(td.message_changed_count||0)+'</td><td>'+t.response.duration_ms+'ms</td></tr>';
      dh+='<tr id="turn-diff-'+key+'" class="turn-diff closed"><td colspan="8"><div class="turn-diff-content" id="turn-diff-content-'+key+'"></div></td></tr>';
    });
    dh+='</tbody>';
  });
  dh+='</table></div>';
  document.getElementById('diff').innerHTML=dh;
  document.getElementById('lastRefresh').textContent='refreshed: '+new Date().toLocaleTimeString();
}
async function init() {
  await loadSessions();
  document.getElementById('sel').addEventListener('change', e => {
    const active=(window.sessionList||[]).find(s=>s.id===e.target.value) || null;
    document.getElementById('sessionMeta').textContent=sessionMeta(active);
    if (e.target.value) render(e.target.value, true);
  });
  document.getElementById('refreshBtn').addEventListener('click', async () => { await loadSessions(); if (currentId) render(currentId, true); });
  document.getElementById('auto').addEventListener('change', () => {
    if (timer) clearInterval(timer);
    if (document.getElementById('auto').checked) timer = setInterval(async () => { await loadSessions(); if (currentId) render(currentId); }, ${POLL_MS});
  });
  timer = setInterval(async () => { await loadSessions(); if (currentId) render(currentId); }, ${POLL_MS});
  const sel = document.getElementById('sel');
  if (sel.options.length > 1) {
    sel.selectedIndex = 1;
    const active=(window.sessionList||[]).find(s=>s.id===sel.value) || null;
    document.getElementById('sessionMeta').textContent=sessionMeta(active);
    render(sel.value);
  }
}
document.addEventListener('DOMContentLoaded', init);
</script>
</body>
</html>`;
}
