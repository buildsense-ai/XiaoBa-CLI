/**
 * Shared deterministic fake xURL for the official `agents://` rendered-Timeline
 * reader contract (ADR-0043). Used by the xURL continuous, backfill, and
 * operations-recovery tests so they never depend on real provider credentials,
 * user logs, or a network. The fake speaks only the documented official
 * commands (`--version`, `agents://<provider>?limit=...`, `agents://<thread>`,
 * `-I agents://<thread>`) and emits strict rendered Markdown.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ThreadSummarySpec {
  readonly threadId: string;
  readonly branch: string;
  readonly ordinal: number;
  readonly fingerprint: string;
  readonly revision?: string;
}

export interface CatalogPageSpec {
  readonly provider: string;
  readonly next?: string | null;
  readonly threads: readonly ThreadSummarySpec[];
}

export type TimelineRole = 'User' | 'Assistant' | 'Context Compacted';

export interface TimelineEntrySpec {
  readonly ordinal: number;
  readonly role: TimelineRole;
  readonly content: string;
}

export interface TimelineSpec {
  readonly provider: string;
  readonly threadId: string;
  readonly branch: string;
  readonly ordinal: number;
  readonly fingerprint: string;
  readonly revision?: string;
  readonly queriedAt?: string;
  readonly entries: readonly TimelineEntrySpec[];
}

export interface HeadOverrideSpec {
  readonly ordinal: number;
  readonly fingerprint: string;
}

export interface ThreadReadSpec {
  readonly timeline?: TimelineSpec;
  readonly head?: HeadOverrideSpec;
  readonly rawStdout?: string;
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly delayMs?: number;
}

export interface DiscoverSpec {
  readonly pages?: Record<string, CatalogPageSpec>;
  readonly byLimit?: Record<string, CatalogPageSpec>;
  readonly catalog?: CatalogPageSpec;
  readonly response?: CatalogPageSpec;
  readonly rawStdout?: string;
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly delayMs?: number;
}

export interface FakeXurlScenario {
  readonly version?: string;
  readonly discover?: DiscoverSpec;
  readonly read?: Record<string, ThreadReadSpec>;
  readonly defaultRead?: ThreadReadSpec;
}

export function writeFakeXurl(commandPath: string): void {
  fs.mkdirSync(path.dirname(commandPath), { recursive: true });
  fs.writeFileSync(commandPath, FAKE_XURL_CJS, 'utf8');
  fs.chmodSync(commandPath, 0o755);
}

export function writeScenario(scenarioPath: string, scenario: FakeXurlScenario): void {
  fs.mkdirSync(path.dirname(scenarioPath), { recursive: true });
  fs.writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2), 'utf8');
}

export function readInvocationLog(logPath: string): Array<{ action: string; args: string[] }> {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as { action: string; args: string[] });
}

export function timeline(spec: TimelineSpec): TimelineSpec {
  return spec;
}

export function catalogPage(spec: CatalogPageSpec): CatalogPageSpec {
  return spec;
}

// Inline rendering helpers are duplicated inside the CJS fake below so the fake
// is fully self-contained at runtime. Keep these TS render helpers in sync with
// the CJS implementation when changing the rendered format.
export function renderCatalog(spec: CatalogPageSpec, requestedUri: string): string {
  const next = spec.next == null ? '' : String(spec.next);
  const lines = [
    '---',
    `uri: ${requestedUri}`,
    `provider: ${spec.provider}`,
    'version: xurl-test 0.0.0',
    `queried_at: 2026-01-01T00:00:00.000Z`,
    `limit: 100`,
    `next: ${next}`,
    `threads: ${spec.threads.length}`,
    '---',
    '',
    '## Threads',
    '',
  ];
  for (const thread of spec.threads) {
    lines.push(`## Thread ${thread.threadId}`);
    lines.push(`uri: agents://${spec.provider}/${thread.threadId}`);
    lines.push(`branch: ${thread.branch}`);
    lines.push(`ordinal: ${thread.ordinal}`);
    lines.push(`fingerprint: ${thread.fingerprint}`);
    if (thread.revision) lines.push(`revision: ${thread.revision}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export function renderTimeline(spec: TimelineSpec, requestedUri: string): string {
  const lines = [
    '---',
    `uri: ${requestedUri}`,
    `provider: ${spec.provider}`,
    `thread: ${spec.threadId}`,
    `branch: ${spec.branch}`,
    'version: xurl-test 0.0.0',
    `queried_at: ${spec.queriedAt ?? '2026-01-01T00:05:00.000Z'}`,
    `ordinal: ${spec.ordinal}`,
    `fingerprint: ${spec.fingerprint}`,
  ];
  if (spec.revision) lines.push(`revision: ${spec.revision}`);
  lines.push('---', '', '## Timeline', '');
  for (const entry of spec.entries) {
    lines.push(`### ${entry.ordinal} ${entry.role}`);
    lines.push(entry.content);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export function renderHead(spec: TimelineSpec, head: HeadOverrideSpec | undefined, requestedUri: string): string {
  const ordinal = head?.ordinal ?? spec.ordinal;
  const fingerprint = head?.fingerprint ?? spec.fingerprint;
  const lines = [
    '---',
    `uri: ${requestedUri}`,
    `provider: ${spec.provider}`,
    `thread: ${spec.threadId}`,
    `branch: ${spec.branch}`,
    'version: xurl-test 0.0.0',
    `queried_at: ${spec.queriedAt ?? '2026-01-01T00:05:00.000Z'}`,
    `ordinal: ${ordinal}`,
    `fingerprint: ${fingerprint}`,
  ];
  if (spec.revision) lines.push(`revision: ${spec.revision}`);
  lines.push('---', '');
  return `${lines.join('\n')}\n`;
}

const FAKE_XURL_CJS = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const scenarioPath = process.env.XURL_SCENARIO_PATH;
const logPath = process.env.XURL_LOG_PATH;
const scenario = scenarioPath ? JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) : {};
if (logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify({ action: actionOf(args), args }) + '\\n', 'utf8');
}

function actionOf(argv) {
  if (argv[0] === '--version') return 'version';
  if (argv[0] === '-I') return 'head';
  if (argv[0] && argv[0].startsWith('agents://') && argv[0].includes('?')) return 'query';
  return 'read';
}

function parseUri(uri) {
  // agents://<provider>/<thread>
  // agents://<provider>?limit=...[&cursor=...]
  // agents:///abs/path?providers=<provider>&limit=...[&cursor=...]
  const threadMatch = /^agents:\\/\\/([^?\\/]+)\\/(.+)$/.exec(uri);
  if (threadMatch) {
    return { provider: threadMatch[1], cursor: null, threadId: threadMatch[2], scopePath: null };
  }

  const queryMatch = /^agents:\\/\\/(.+)\\?(.+)$/.exec(uri);
  if (!queryMatch) throw new Error('fake-xurl: unrecognized uri ' + uri);

  const target = queryMatch[1] || '';
  const params = new URLSearchParams(queryMatch[2]);
  const cursor = params.get('cursor');

  if (target.startsWith('/') || target.startsWith('.') || target.startsWith('~')) {
    const providers = (params.get('providers') || '').split(',').map(v => v.trim()).filter(Boolean);
    const provider = providers[0] || null;
    if (!provider) throw new Error('fake-xurl: missing providers=... in scoped query ' + uri);
    return { provider, cursor, limit: Number(params.get('limit')), threadId: null, scopePath: target };
  }

  return { provider: target, cursor, limit: Number(params.get('limit')), threadId: null, scopePath: null };
}

function renderCatalog(spec, requestedUri) {
  const next = spec.next == null ? '' : String(spec.next);
  const lines = [
    '---',
    'uri: ' + requestedUri,
    'provider: ' + spec.provider,
    'version: xurl-test 0.0.0',
    'queried_at: 2026-01-01T00:00:00.000Z',
    'limit: 100',
    'next: ' + next,
    'threads: ' + spec.threads.length,
    '---',
    '',
    '## Threads',
    '',
  ];
  for (const t of spec.threads) {
    lines.push('## Thread ' + t.threadId);
    lines.push('uri: agents://' + spec.provider + '/' + t.threadId);
    lines.push('branch: ' + t.branch);
    lines.push('ordinal: ' + t.ordinal);
    lines.push('fingerprint: ' + t.fingerprint);
    if (t.revision) lines.push('revision: ' + t.revision);
    lines.push('');
  }
  return lines.join('\\n') + '\\n';
}

function renderTimeline(spec, requestedUri) {
  const lines = [
    '---',
    'uri: ' + requestedUri,
    'provider: ' + spec.provider,
    'thread: ' + spec.threadId,
    'branch: ' + spec.branch,
    'version: xurl-test 0.0.0',
    'queried_at: ' + (spec.queriedAt || '2026-01-01T00:05:00.000Z'),
    'ordinal: ' + spec.ordinal,
    'fingerprint: ' + spec.fingerprint,
  ];
  if (spec.revision) lines.push('revision: ' + spec.revision);
  lines.push('---', '', '## Timeline', '');
  for (const e of spec.entries) {
    lines.push('### ' + e.ordinal + ' ' + e.role);
    lines.push(e.content);
    lines.push('');
  }
  return lines.join('\\n') + '\\n';
}

function renderHead(spec, head, requestedUri) {
  const ordinal = head ? head.ordinal : spec.ordinal;
  const fingerprint = head ? head.fingerprint : spec.fingerprint;
  const lines = [
    '---',
    'uri: ' + requestedUri,
    'provider: ' + spec.provider,
    'thread: ' + spec.threadId,
    'branch: ' + spec.branch,
    'version: xurl-test 0.0.0',
    'queried_at: ' + (spec.queriedAt || '2026-01-01T00:05:00.000Z'),
    'ordinal: ' + ordinal,
    'fingerprint: ' + fingerprint,
  ];
  if (spec.revision) lines.push('revision: ' + spec.revision);
  lines.push('---', '');
  return lines.join('\\n') + '\\n';
}

function respond(spec, render) {
  if (spec.delayMs) { setTimeout(() => respondNow(spec, render), Number(spec.delayMs)); }
  else respondNow(spec, render);
}

function respondNow(spec, render) {
  if (spec.stderr) process.stderr.write(String(spec.stderr));
  if (spec.rawStdout !== undefined) { process.stdout.write(String(spec.rawStdout)); }
  else if (spec.timeline || spec.threads || spec.catalog || spec.response || spec.pages) {
    // handled by caller via render
  }
  process.exit(Number(spec.exitCode || 0));
}

const action = actionOf(args);
let selected = null;
let render = null;

if (action === 'version') {
  process.stdout.write(String(scenario.version || 'xurl-test 0.0.0') + '\\n');
  process.exit(0);
}

if (action === 'query') {
  const parsed = parseUri(args[0]);
  const token = parsed.cursor || 'start';
  const discover = scenario.discover || {};
  let page = null;
  if (discover.byLimit && discover.byLimit[String(parsed.limit)]) page = discover.byLimit[String(parsed.limit)];
  else if (discover.pages && discover.pages[token]) page = discover.pages[token];
  else if (token === 'start' && (discover.catalog || discover.response)) page = discover.catalog || discover.response;
  else if (discover.pages && discover.pages.start) page = discover.pages.start;
  else if (discover.catalog || discover.response) page = discover.catalog || discover.response;
  if (discover.rawStdout !== undefined || discover.exitCode !== undefined || discover.stderr !== undefined) {
    if (discover.stderr) process.stderr.write(String(discover.stderr));
    if (discover.rawStdout !== undefined) process.stdout.write(String(discover.rawStdout));
    if (!page) process.exit(Number(discover.exitCode || 0));
    if (discover.rawStdout !== undefined || Number(discover.exitCode || 0) !== 0) process.exit(Number(discover.exitCode || 0));
  }
  if (discover.delayMs) { setTimeout(() => emitQuery(page), Number(discover.delayMs)); }
  else emitQuery(page);
} else if (action === 'read') {
  const parsed = parseUri(args[0]);
  const threadId = parsed.threadId;
  const readSpec = (scenario.read && scenario.read[threadId]) || scenario.defaultRead || {};
  if (readSpec.rawStdout !== undefined || (!readSpec.timeline && (readSpec.exitCode !== undefined || readSpec.stderr !== undefined))) {
    if (readSpec.stderr) process.stderr.write(String(readSpec.stderr));
    if (readSpec.rawStdout !== undefined) process.stdout.write(String(readSpec.rawStdout));
    process.exit(Number(readSpec.exitCode || 0));
  }
  if (readSpec.delayMs) { setTimeout(() => emitRead(readSpec), Number(readSpec.delayMs)); }
  else emitRead(readSpec);
} else if (action === 'head') {
  const parsed = parseUri(args[1]);
  const threadId = parsed.threadId;
  const readSpec = (scenario.read && scenario.read[threadId]) || scenario.defaultRead || {};
  if (!readSpec.timeline) {
    if (readSpec.stderr) process.stderr.write(String(readSpec.stderr));
    else process.stderr.write('fake-xurl: no timeline for thread ' + threadId + '\\n');
    process.exit(Number(readSpec.exitCode || 1));
  }
  process.stdout.write(renderHead(readSpec.timeline, readSpec.head, args[1]));
  process.exit(Number(readSpec.exitCode || 0));
}

function emitQuery(page) {
  if (!page) { process.stderr.write('fake-xurl: missing catalog page\\n'); process.exit(1); }
  process.stdout.write(renderCatalog(page, args[0]));
  process.exit(0);
}

function emitRead(readSpec) {
  if (!readSpec.timeline) { process.stderr.write('fake-xurl: missing timeline\\n'); process.exit(1); }
  process.stdout.write(renderTimeline(readSpec.timeline, args[0]));
  process.exit(Number(readSpec.exitCode || 0));
}
`;
