#!/usr/bin/env node

/**
 * Read-only by default staging smoke for the seven CatsLog Agent-facing
 * Skills/session routes. Pass --write only with an explicit confirmation env:
 *
 *   CATSLOG_SMOKE_BASE_URL=https://logs.staging.example \
 *   CATSLOG_SMOKE_USER_TOKEN=... \
 *   CATSLOG_SMOKE_ALLOW_WRITES=true \
 *   node scripts/catslog-agent-memory-smoke.mjs --write
 *
 * The script never prints bearer values or response bodies. It intentionally
 * does not fall back to CATSCO_LOG_API_BASE_URL, so an accidental production
 * write cannot happen just because a normal XiaoBa environment is loaded.
 */

import os from 'node:os';

const args = new Set(process.argv.slice(2));
const DEFAULT_SKILLS_PATH = '/catsco/agent/skills';
if (args.has('--help') || args.has('-h')) {
  printUsage();
  process.exit(0);
}
const writeEnabled = args.has('--write');
const baseUrl = requireBaseUrl(process.env.CATSLOG_SMOKE_BASE_URL);
const userToken = requiredEnv('CATSLOG_SMOKE_USER_TOKEN');
const deviceId = process.env.CATSLOG_SMOKE_DEVICE_ID?.trim()
  || `xiaoba-smoke-${safeLabel(os.hostname())}-${process.pid}`;
const task = process.env.CATSLOG_SMOKE_TASK?.trim() || 'release';
const outcome = process.env.CATSLOG_SMOKE_OUTCOME?.trim() || 'succeeded';
const skillHandle = process.env.CATSLOG_SMOKE_SKILL_HANDLE?.trim();
const requestId = process.env.CATSLOG_SMOKE_REQUEST_ID?.trim()
  || `xiaoba-catslog-smoke-${Date.now()}`;

if (!/^(succeeded|failed|corrected)$/.test(outcome)) {
  fail('CATSLOG_SMOKE_OUTCOME must be succeeded, failed, or corrected');
}
if (writeEnabled && process.env.CATSLOG_SMOKE_ALLOW_WRITES !== 'true') {
  fail('Refusing --write without CATSLOG_SMOKE_ALLOW_WRITES=true');
}
if (isProductionHost(new URL(baseUrl).hostname) && process.env.CATSLOG_SMOKE_ALLOW_PRODUCTION !== 'true') {
  fail('Refusing to run against the production CatsLog host without CATSLOG_SMOKE_ALLOW_PRODUCTION=true');
}

const bootstrap = await call('bootstrap', '/catsco/agent/bootstrap', {
  method: 'POST',
  token: userToken,
  body: {
    device_id: deviceId,
    device_name: `XiaoBa CatsLog smoke (${deviceId})`,
    platform: `${process.platform} ${process.arch}`,
    hostname: os.hostname(),
  },
});

requiredResponseString(bootstrap, 'device_id');
const skillToken = requiredResponseString(bootstrap, 'skill_token');
requiredResponseString(bootstrap, 'skill_token_id');
const skillExpiry = Date.parse(String(bootstrap.skill_token_expires_at || ''));
if (!Number.isFinite(skillExpiry) || skillExpiry <= Date.now()) {
  fail('bootstrap did not return a live skill_token_expires_at');
}
const uploadToken = optionalResponseString(bootstrap, 'token');
if (uploadToken && skillToken === uploadToken) {
  fail('bootstrap returned the upload token as skill_token');
}
const writeToken = optionalResponseString(bootstrap, 'memory_write_token');
if (writeToken && (writeToken === skillToken || writeToken === uploadToken)) {
  fail('bootstrap returned a reused token for memory_write_token');
}

const paths = {
  skills: safeCapabilityPath(bootstrap.skills_url, DEFAULT_SKILLS_PATH),
  skillGraph: safeCapabilityPath(bootstrap.skill_graph_url, '/catsco/agent/skill-graph'),
  sessions: safeCapabilityPath(bootstrap.sessions_url, '/catsco/agent/query/v1/sessions'),
  memory: safeCapabilityPath(bootstrap.memory_url, '/catsco/agent/memory/retrieve'),
  memoryRecall: safeCapabilityPath(bootstrap.memory_recall_url, '/catsco/agent/memory/recall'),
  memoryNotes: safeCapabilityPath(bootstrap.memory_notes_url, '/catsco/agent/memory/notes'),
};

const results = [];
results.push(await readSkills(paths.skills, skillToken));
results.push(await readSkillGraph(paths.skillGraph, skillToken));
const memory = await call('skill memory', paths.memory, {
  method: 'POST',
  token: skillToken,
  body: buildSkillMemoryRequest(task, skillHandle, false),
});
requireContentTrust('skill memory', memory, 'untrusted_runtime_memory');
requireArray('skill memory', memory.items, 'items');
requireETag('skill memory', memory);
results.push({ name: 'skill memory', status: memory.status });

const sessions = await call('session query', paths.sessions, {
  method: 'POST',
  token: skillToken,
  body: { latest: true, limit: 1 },
});
requireContentTrust('session query', sessions, 'untrusted_log_data');
requireArray('session query', sessions.records, 'records');
requireETag('session query', sessions);
results.push({ name: 'session query', status: sessions.status });

const recall = await call('memory recall', paths.memoryRecall, {
  method: 'POST',
  token: skillToken,
  body: { latest: true, limit: 1, note_limit: 1, include_notes: true },
});
requireContentTrust('memory recall', recall, 'untrusted_agent_memory');
if (typeof recall.session_available !== 'boolean') {
  fail('memory recall returned an invalid session_available flag');
}
if (!isRecord(recall.session)) fail('memory recall returned an invalid session envelope');
requireContentTrust('memory recall session', recall.session, 'untrusted_log_data');
requireArray('memory recall session', recall.session.records, 'records');
// CatsLog omits an empty notes collection because the response field is
// `omitempty`; normalize that valid envelope shape for the smoke assertion.
const recallNotes = recall.notes === undefined ? [] : recall.notes;
requireArray('memory recall', recallNotes, 'notes');
requireETag('memory recall', recall);
results.push({ name: 'memory recall', status: recall.status });

if (!writeEnabled) {
  results.push({ name: 'skill outcome', status: 'skipped (--write required)' });
  results.push({ name: 'memory note', status: 'skipped (--write required)' });
} else {
  if (!writeToken) fail('bootstrap did not return memory_write_token for --write');
  requiredResponseString(bootstrap, 'memory_write_token_id');
  const writeExpiry = Date.parse(String(bootstrap.memory_write_token_expires_at || ''));
  if (!Number.isFinite(writeExpiry) || writeExpiry <= Date.now()) {
    fail('bootstrap did not return a live memory_write_token_expires_at');
  }

  const retrieval = await call('skill memory body for receipt', paths.memory, {
    method: 'POST',
    token: skillToken,
    body: buildSkillMemoryRequest(task, skillHandle, true),
  });
  requireContentTrust('skill memory body for receipt', retrieval, 'untrusted_runtime_memory');
  requireArray('skill memory body for receipt', retrieval.items, 'items');
  const item = firstObject(retrieval.items);
  const receipt = item && stringValue(item.retrieval_receipt);
  const handle = item && safeSkillHandle(item.handle);
  const revision = item && positiveInteger(item.revision);
  if (!receipt || !handle || !revision || !stringValue(item?.content)) {
    fail(
      'write smoke needs a Skill Memory fixture with handle, revision, and retrieval_receipt '
      + `and body content (items=${Array.isArray(retrieval.items) ? retrieval.items.length : 0})`,
    );
  }

  const outcomeResult = await call(
    'skill outcome',
    `${DEFAULT_SKILLS_PATH}/${encodeURIComponent(handle)}/outcomes`,
    {
      method: 'POST',
      token: skillToken,
      body: {
        revision,
        outcome,
        retrieval_receipt: receipt,
        feedback: {
          code: 'other',
          summary: 'XiaoBa staging smoke test',
          tags: ['xiaoba-smoke'],
        },
      },
    },
  );
  results.push({ name: 'skill outcome', status: outcomeResult.status });

  const note = await call('memory note', paths.memoryNotes, {
    method: 'POST',
    token: writeToken,
    body: {
      kind: 'episode',
      title: 'XiaoBa CatsLog staging smoke',
      content: `XiaoBa CatsLog Agent Memory smoke ${new Date().toISOString()}`,
      source_refs: ['xiaoba-catslog-smoke'],
      request_id: requestId,
      include_content: false,
    },
  });
  requireMemoryNoteEnvelope(note);
  results.push({ name: 'memory note', status: note.status });
}

console.log(`[catslog-smoke] base=${baseUrl} device=${deviceId} writes=${writeEnabled}`);
for (const result of results) {
  console.log(`[catslog-smoke] ${result.name}: ${result.status}`);
}
console.log('[catslog-smoke] passed');

async function readSkills(path, token) {
  const response = await call('Skills catalog', path, {
    method: 'GET',
    token,
    query: { limit: '1' },
  });
  requireContentTrust('Skills catalog', response, 'untrusted_runtime_skill');
  requireArray('Skills catalog', response.skills, 'skills');
  requireETag('Skills catalog', response);
  return { name: 'Skills catalog', status: response.status };
}

async function readSkillGraph(path, token) {
  const response = await call('Skill Graph', path, {
    method: 'GET',
    token,
    query: { limit: '1', depth: '1' },
  });
  requireContentTrust('Skill Graph', response, 'untrusted_runtime_skill_graph');
  requireArray('Skill Graph', response.nodes, 'nodes');
  requireArray('Skill Graph', response.edges, 'edges');
  requireETag('Skill Graph', response);
  return { name: 'Skill Graph', status: response.status };
}

function buildSkillMemoryRequest(task, handle, includeContent) {
  return {
    task,
    ...(handle ? { handle } : {}),
    limit: 1,
    include_content: includeContent,
  };
}

async function call(name, path, options = {}) {
  if (isRecord(options.body) && ('uid' in options.body || 'uids' in options.body)) {
    fail(`${name} request attempted to widen scope with uid/uids`);
  }
  const url = new URL(path, `${baseUrl}/`);
  for (const [key, value] of Object.entries(options.query || {})) {
    url.searchParams.set(key, value);
  }
  const headers = { Accept: 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    fail(`${name} request failed: ${error?.message || 'network error'}`);
  }
  if (!response.ok) {
    const code = await safeErrorCode(response);
    fail(`${name} returned HTTP ${response.status}${code ? ` (${code})` : ''}`);
  }
  let body = null;
  if (response.status !== 204) {
    try {
      body = await response.json();
    } catch {
      fail(`${name} returned a non-JSON success response`);
    }
    if (!isRecord(body)) fail(`${name} returned an invalid response envelope`);
  }
  return {
    ...(isRecord(body) ? body : {}),
    ...(response.headers.get('etag') ? { etag: response.headers.get('etag') } : {}),
    status: response.status,
  };
}

async function safeErrorCode(response) {
  try {
    const body = await response.clone().json();
    return typeof body?.code === 'string' ? body.code : undefined;
  } catch {
    return undefined;
  }
}

function requireBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) fail('CATSLOG_SMOKE_BASE_URL is required');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail('CATSLOG_SMOKE_BASE_URL must be an absolute URL');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalhost(parsed.hostname))) {
    fail('CATSLOG_SMOKE_BASE_URL must use HTTPS (HTTP is allowed only for localhost)');
  }
  return parsed.origin;
}

function safeCapabilityPath(value, fallback) {
  const raw = typeof value === 'string' && value.length > 0 ? value : fallback;
  const path = raw.trim();
  if (
    raw !== path
    || path.length === 0
    || path.length > 512
    || !/^\/[A-Za-z0-9._~\/-]*$/.test(path)
    || path.includes('//')
    || path === '/'
    || path.split('/').some(segment => segment === '.' || segment === '..')
  ) {
    fail(`bootstrap returned an unsafe capability path: ${fallback}`);
  }
  return path;
}

function requireContentTrust(name, body, expected) {
  if (body.content_trust !== expected) {
    fail(`${name} returned content_trust=${String(body.content_trust || '(missing)')}; expected ${expected}`);
  }
}

function requireArray(name, value, field) {
  if (!Array.isArray(value)) fail(`${name} returned an invalid ${field} array`);
}

function requireETag(name, body) {
  if (!stringValue(body.etag)) fail(`${name} response did not include an ETag`);
}

function requireMemoryNoteEnvelope(body) {
  if (!stringValue(body.id) || body.kind !== 'episode' || 'content' in body) {
    fail('memory note returned an invalid metadata envelope');
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function requiredResponseString(body, key) {
  const value = optionalResponseString(body, key);
  if (!value) fail(`bootstrap did not return ${key}`);
  return value;
}

function optionalResponseString(body, key) {
  return typeof body?.[key] === 'string' && body[key].trim() ? body[key].trim() : undefined;
}

function firstObject(value) {
  return Array.isArray(value) ? value.find(item => item && typeof item === 'object' && !Array.isArray(item)) : undefined;
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function safeSkillHandle(value) {
  const handle = stringValue(value);
  if (
    !handle
    || Buffer.byteLength(handle, 'utf8') > 256
    || !/^[A-Za-z0-9._:@#-]+$/.test(handle)
    || handle.includes('..')
    || /[%~$]/.test(handle)
    || /^(file|http|https|ssh):/i.test(handle)
  ) {
    return undefined;
  }
  return handle;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function safeLabel(value) {
  return String(value || 'device').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 48) || 'device';
}

function isProductionHost(hostname) {
  return hostname === 'logs.catsco.fun' || hostname.endsWith('.catsco.fun');
}

function isLocalhost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function fail(message) {
  console.error(`[catslog-smoke] failed: ${message}`);
  process.exit(1);
}

function printUsage() {
  console.log([
    'CatsLog Agent Memory staging smoke (read-only unless --write is passed).',
    '',
    'Required:',
    '  CATSLOG_SMOKE_BASE_URL=https://logs.staging.example',
    '  CATSLOG_SMOKE_USER_TOKEN=<CatsCompany user bearer>',
    '',
    'Optional:',
    '  CATSLOG_SMOKE_DEVICE_ID=...  CATSLOG_SMOKE_TASK=release',
    '  CATSLOG_SMOKE_SKILL_HANDLE=...  CATSLOG_SMOKE_OUTCOME=succeeded|failed|corrected',
    '  CATSLOG_SMOKE_REQUEST_ID=... ',
    '',
    'Write mode additionally requires:',
    '  --write CATSLOG_SMOKE_ALLOW_WRITES=true',
    '  (and CATSLOG_SMOKE_ALLOW_PRODUCTION=true for *.catsco.fun hosts)',
  ].join('\n'));
}
