import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID, type Hash } from 'crypto';
import { glob } from 'glob';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { CatsCoLocalConfigService } from '../catscompany/local-config';
import { Logger } from './logger';

type Lane = 'backfill' | 'incremental';
interface Cursor { offset: number; hash: string }
interface FileState {
  bot_uid: string;
  generation: string;
  baseline: number;
  backfill: Cursor;
  incremental: Cursor;
  error?: string;
}
interface FilePlan { path: string; stream_id: string; start: number; end: number; base: number }
interface Manifest {
  bot_uid: string;
  manifest_id: string;
  session_key: string;
  lane: Lane;
  files: FilePlan[];
  registered: boolean;
}
interface State {
  version: 2;
  endpoint: string;
  dataset: string;
  source_id: string;
  last_discovery: number;
  files: Record<string, FileState>;
  manifests: Manifest[];
  discovery_errors: Record<string, { message: string; historical: boolean }>;
}
export interface MemoryBot { uid: string; name?: string }
export interface MondayMemoryConfig { endpoint: string; root: string; bot: () => MemoryBot | undefined }
const digest = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
const MAX_BODY = 3 * 1024 * 1024;
const READ_BYTES = 1024 * 1024;
const MAX_RECORD = 64 * READ_BYTES;
const safePath = (p: string) => /^sessions\/(chat|cli|catscompany|feishu|weixin)\/\d{4}-\d{2}-\d{2}\/[^/\\]+\.jsonl$/.test(p);
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function valid(condition: unknown): asserts condition { if (!condition) throw Error('invalid Monday memory state; review before resetting'); }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function identity(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256; }
function parseState(value: unknown, config: MondayMemoryConfig): State {
  valid(object(value) && value.version === 2 && value.endpoint === config.endpoint && typeof value.dataset === 'string' && identity(value.source_id) && integer(value.last_discovery) && object(value.files) && Array.isArray(value.manifests));
  const files: State['files'] = {};
  const cursor = (v: unknown): Cursor => { valid(object(v) && integer(v.offset) && typeof v.hash === 'string' && /^[a-f0-9]{64}$/.test(v.hash)); return { offset: v.offset, hash: v.hash }; };
  for (const [key, item] of Object.entries(value.files)) {
    valid(safePath(key) && object(item) && typeof item.bot_uid === 'string' && /^[1-9][0-9]{0,18}$/.test(item.bot_uid) && identity(item.generation) && integer(item.baseline) && (item.error === undefined || typeof item.error === 'string'));
    const backfill = cursor(item.backfill), incremental = cursor(item.incremental);
    valid(backfill.offset <= item.baseline && incremental.offset >= item.baseline);
    files[key] = { bot_uid: item.bot_uid, generation: item.generation, baseline: item.baseline, backfill, incremental, ...(typeof item.error === 'string' ? { error: item.error } : {}) };
  }
  const manifests = value.manifests.map((m: unknown): Manifest => {
    valid(object(m) && typeof m.bot_uid === 'string' && /^[1-9][0-9]{0,18}$/.test(m.bot_uid) && identity(m.manifest_id) && typeof m.session_key === 'string' && (m.lane === 'backfill' || m.lane === 'incremental') && typeof m.registered === 'boolean' && Array.isArray(m.files) && m.files.length > 0);
    const lane = m.lane, session = m.session_key;
    const plans = m.files.map((f: unknown): FilePlan => {
      valid(object(f) && typeof f.path === 'string' && safePath(f.path) && identity(f.stream_id) && integer(f.start) && integer(f.end) && integer(f.base));
      const file = files[f.path];
      valid(file && file.bot_uid === m.bot_uid);
      valid(file && f.base === (lane === 'backfill' ? 0 : file.baseline) && f.start >= f.base && f.end > f.start && (lane !== 'backfill' || f.end <= file.baseline));
      valid(f.path.split('/')[1] + '/' + path.basename(f.path) === session && f.stream_id === digest(file.generation + ':' + lane));
      return { path: f.path, stream_id: f.stream_id, start: f.start, end: f.end, base: f.base };
    });
    valid(new Set(plans.map(f => f.path)).size === plans.length);
    return { bot_uid: m.bot_uid, manifest_id: m.manifest_id, session_key: session, lane, registered: m.registered, files: plans };
  });
  valid(new Set(manifests.map(m => m.manifest_id)).size === manifests.length);
  const errors: State['discovery_errors'] = {};
  if (value.discovery_errors !== undefined) {
    valid(object(value.discovery_errors));
    for (const [key, error] of Object.entries(value.discovery_errors)) {
      valid(safePath(key) && object(error) && typeof error.message === 'string' && typeof error.historical === 'boolean');
      errors[key] = { message: error.message, historical: error.historical };
    }
  }
  return { version: 2, endpoint: config.endpoint, dataset: value.dataset, source_id: value.source_id, last_discovery: value.last_discovery, files, manifests, discovery_errors: errors };
}

export function mondayMemoryConfig(root: string, env = process.env): MondayMemoryConfig | undefined {
  if (env.XIAOBA_MEMORY_UPLOAD_ENABLED === 'false' || env.XIAOBA_ROLE === 'inspector-cat') return;
  const endpoint = (env.XIAOBA_MEMORY_UPLOAD_URL || 'http://121.11.233.41').replace(/\/$/, '');
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('invalid Monday memory URL');
  const local = new CatsCoLocalConfigService({ runtimeRoot: root, env });
  return { endpoint, root, bot: () => {
    const current = local.load().currentBot;
    const uid = String(local.getAuthState().botUid || '').replace(/^usr/, '').trim();
    if (!/^[1-9][0-9]{0,18}$/.test(uid)) return;
    const matching = String(current?.uid || '').replace(/^usr/, '') === uid ? current : undefined;
    return { uid, name: matching?.name || matching?.username || env.CURRENT_AGENT_DISPLAY_NAME || undefined };
  } };
}

async function recordedBot(file: string, end: number): Promise<string | undefined> {
  if (!end) return;
  const input = createReadStream(file, { end: end - 1 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const value: unknown = JSON.parse(line);
      if (!object(value) || !object(value.agent_identity)) continue;
      const uid = String(value.agent_identity.agent_id || '').replace(/^usr/, '');
      if (/^[1-9][0-9]{0,18}$/.test(uid)) return uid;
    }
  } finally { lines.close(); input.destroy(); }
}

/** Beijing 03:00/15:00, independent of the host's timezone. */
export function nextMemoryScan(now: number): number {
  const shifted = now + 8 * 3600000;
  const day = Math.floor(shifted / 86400000) * 86400000;
  const next = [3, 15, 27].map(hour => day + hour * 3600000).find(t => t > shifted)!;
  return next - 8 * 3600000;
}

async function completeEnd(file: string): Promise<number> {
  const h = await fs.open(file, 'r');
  try {
    const { size } = await h.stat();
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - 65536), buffer = Buffer.alloc(end - start);
      const { bytesRead } = await h.read(buffer, 0, buffer.length, start);
      const i = buffer.subarray(0, bytesRead).lastIndexOf(10);
      if (i >= 0) return start + i + 1;
      end = start;
    }
    return 0;
  } finally { await h.close(); }
}

async function prefixHasher(file: string, end: number) {
  const hash = createHash('sha256'), h = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(65536);
    for (let offset = 0; offset < end;) {
      const { bytesRead } = await h.read(buffer, 0, Math.min(buffer.length, end - offset), offset);
      if (!bytesRead) throw Error('source truncated');
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    return hash;
  } finally { await h.close(); }
}

export class MondayMemoryUploader {
  private state?: State;
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopped = false;
  private lock?: fs.FileHandle;
  private hashes = new Map<string, { offset: number; mtime: number; size: number; hash: Hash }>();
  private readonly statePath: string;
  constructor(private readonly config: MondayMemoryConfig) {
    this.statePath = path.join(config.root, 'data', 'monday-memory-upload', 'state.json');
  }
  async start(): Promise<void> {
    await this.acquire();
    try { await this.load(); } catch (e) { await this.stop(); throw e; }
    this.stopped = false;
    this.tick();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.active;
    if (this.lock) {
      await this.lock.close(); this.lock = undefined;
      await fs.unlink(this.statePath + '.lock');
    }
  }
  private async acquire() {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    const lockPath = this.statePath + '.lock';
    try { this.lock = await fs.open(lockPath, 'wx', 0o600); }
    catch (e) {
      if (!(e instanceof Error) || !('code' in e) || e.code !== 'EEXIST') throw e;
      const owner = Number(await fs.readFile(lockPath, 'utf8'));
      if (!Number.isSafeInteger(owner) || owner <= 0) throw Error('invalid Monday memory lock; review before removing');
      try { process.kill(owner, 0); throw Error('Monday memory uploader already running'); }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
      }
      await fs.unlink(lockPath);
      this.lock = await fs.open(lockPath, 'wx', 0o600);
    }
    await this.lock.writeFile(String(process.pid));
  }
  private async load() {
    try {
      this.state = parseState(JSON.parse(await fs.readFile(this.statePath, 'utf8')), this.config);
    } catch (e) {
      if (!(e instanceof Error) || !('code' in e) || e.code !== 'ENOENT') throw e;
      this.state = { version: 2, endpoint: this.config.endpoint, dataset: '', source_id: 'bot_' + randomUUID(), last_discovery: 0, files: {}, manifests: [], discovery_errors: {} };
      await this.save();
    }
  }
  private async save() {
    const temp = this.statePath + '.tmp';
    const handle = await fs.open(temp, 'w', 0o600);
    try { await handle.writeFile(JSON.stringify(this.state)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temp, this.statePath);
  }
  private tick() {
    if (this.stopped) return;
    this.active = this.cycle().catch(error => {
      Logger.warning('[MondayMemory] cycle failed: ' + (error instanceof Error ? error.message : 'unknown'));
    }).finally(() => {
      this.active = undefined;
      if (!this.stopped) { this.timer = setTimeout(() => this.tick(), 30000); this.timer.unref(); }
    });
  }
  private async post(uid: string, route: string, body: Record<string, unknown>): Promise<unknown> {
    const current = this.config.bot();
    const text = JSON.stringify({ ...body, dataset_id: this.state!.dataset, ...(current?.uid === uid && current.name ? { bot_name: current.name } : {}) });
    if (Buffer.byteLength(text) > MAX_BODY) throw Error('Monday request exceeds transport budget');
    const response = await fetch(this.config.endpoint + '/v1/bots/' + uid + route, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: text, signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw Error('Monday HTTP ' + response.status);
    return response.json();
  }
  /** Public for manual runs/tests; normal startup uses the same persistent cycle. */
  async cycle(now = Date.now()): Promise<void> {
    if (!this.lock) { await this.acquire(); await this.load(); }
    const state = this.state!;
    if (!this.config.bot() && !Object.keys(state.files).length) return;
    const response = await fetch(this.config.endpoint + '/v1/bot-ingest/config', { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw Error('Monday config HTTP ' + response.status);
    const remote: unknown = await response.json();
    if (!object(remote) || !identity(remote.dataset_id)) throw Error('invalid Monday dataset');
    if (state.dataset && state.dataset !== remote.dataset_id) throw Error('Monday dataset changed; archive uploader state before a full rebuild');
    if (!state.dataset) { state.dataset = remote.dataset_id; await this.save(); }
    if (!state.last_discovery || now >= nextMemoryScan(state.last_discovery)) await this.discover(now);
    // One bounded chunk per file and lane before rotating, with new material first.
    for (const lane of ['incremental', 'backfill'] as const) {
      for (const manifest of state.manifests.filter(m => m.lane === lane)) {
        if (this.stopped) return;
        try {
          if (!manifest.registered) {
            await this.post(manifest.bot_uid, '/ingest/manifests', {
              source_id: state.source_id,
              manifest_id: manifest.manifest_id, session_key: manifest.session_key, lane,
              files: manifest.files.map(f => ({ stream_id: f.stream_id, end_offset: f.end - f.base, path: f.path })),
            });
            manifest.registered = true; await this.save();
          }
          for (const file of manifest.files) {
            if (state.discovery_errors[file.path]) continue;
            const cursor = state.files[file.path][lane];
            if (cursor.offset < file.end) {
              try { await this.send(file, lane); delete state.files[file.path].error; }
              catch (error) { state.files[file.path].error = error instanceof Error ? error.message : 'upload failed'; await this.save(); }
            }
          }
        } catch (error) {
          Logger.warning('[MondayMemory] manifest ' + manifest.manifest_id + ': ' + (error instanceof Error ? error.message : 'upload failed'));
        }
      }
    }
    state.manifests = state.manifests.filter(m => !m.registered || m.files.some(f => state.files[f.path][m.lane].offset < f.end));
    await this.save();
  }
  private async discover(now: number) {
    const state = this.state!, plans = new Map<string, Manifest>();
    const files = (await glob('sessions/*/*/*.jsonl', { cwd: path.join(this.config.root, 'logs'), nodir: true, follow: false })).map(p => p.split(path.sep).join('/')).sort();
    for (const relative of files.filter(safePath)) {
      const historical = state.discovery_errors[relative]?.historical ?? !state.last_discovery;
      try {
        const absolute = path.join(this.config.root, 'logs', relative), stat = await fs.lstat(absolute);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const end = await completeEnd(absolute);
        if (!state.files[relative]) {
          const uid = await recordedBot(absolute, end) ?? this.config.bot()?.uid;
          if (!uid) throw Error('awaiting bot uid');
          state.files[relative] = {
            bot_uid: uid,
            generation: randomUUID(), baseline: historical ? end : 0,
            backfill: { offset: 0, hash: digest('') }, incremental: { offset: historical ? end : 0, hash: historical ? (await prefixHasher(absolute, end)).digest('hex') : digest('') },
          };
        }
        const file = state.files[relative];
        if (end < Math.max(file.baseline, file.backfill.offset, file.incremental.offset)) throw Error('source rewritten: ' + relative);
        const session = relative.split('/')[1] + '/' + path.basename(relative);
        for (const lane of ['backfill', 'incremental'] as const) {
          const base = lane === 'backfill' ? 0 : file.baseline;
          const target = lane === 'backfill' ? file.baseline : end;
          const planned = Math.max(file[lane].offset, ...state.manifests.filter(m => m.lane === lane).flatMap(m => m.files.filter(f => f.path === relative).map(f => f.end)));
          if (target <= planned) continue;
          const key = file.bot_uid + ':' + session + ':' + lane;
          if (!plans.has(key)) plans.set(key, { bot_uid: file.bot_uid, manifest_id: 'scan_' + randomUUID(), session_key: session, lane, files: [], registered: false });
          plans.get(key)!.files.push({ path: relative, base, start: planned, end: target, stream_id: digest(file.generation + ':' + lane) });
        }
        delete state.discovery_errors[relative];
      } catch (error) {
        state.discovery_errors[relative] = { message: error instanceof Error ? error.message : 'discovery failed', historical };
      }
    }
    state.manifests.push(...plans.values()); state.last_discovery = now;
    await this.save();
  }
  private async send(plan: FilePlan, lane: Lane) {
    const cursor = this.state!.files[plan.path][lane], absolute = path.join(this.config.root, 'logs', plan.path);
    const stat = await fs.stat(absolute), cacheKey = plan.path + ':' + lane;
    const cached = this.hashes.get(cacheKey);
    const hasher = cached && cached.offset === cursor.offset && cached.mtime === stat.mtimeMs && cached.size === stat.size ? cached.hash.copy() : await prefixHasher(absolute, cursor.offset);
    if (hasher.copy().digest('hex') !== cursor.hash) throw Error('source prefix changed: ' + plan.path);
    const handle = await fs.open(absolute, 'r');
    const buffer = Buffer.alloc(Math.min(READ_BYTES, plan.end - cursor.offset));
    let bytes: Buffer;
    try {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor.offset);
      const end = buffer.subarray(0, bytesRead).lastIndexOf(10);
      if (end >= 0) bytes = buffer.subarray(0, end + 1);
      else {
        const chunks = [buffer.subarray(0, bytesRead)]; let length = bytesRead;
        for (;;) {
          if (length >= MAX_RECORD || cursor.offset + length >= plan.end) throw Error('record_too_large or incomplete at ' + plan.path + ':' + cursor.offset);
          const chunk = Buffer.alloc(Math.min(READ_BYTES, MAX_RECORD - length, plan.end - cursor.offset - length));
          const read = await handle.read(chunk, 0, chunk.length, cursor.offset + length);
          if (!read.bytesRead) throw Error('source truncated');
          const newline = chunk.subarray(0, read.bytesRead).indexOf(10);
          const data = chunk.subarray(0, newline < 0 ? read.bytesRead : newline + 1); chunks.push(data); length += data.length;
          if (newline >= 0) { bytes = Buffer.concat(chunks); break; }
        }
      }
    } finally { await handle.close(); }
    const records = [];
    let start = 0;
    for (let i = 0; bytes.length <= READ_BYTES && i < bytes.length; i++) if (bytes[i] === 10) {
      records.push({ offset: cursor.offset + start - plan.base, raw_base64: bytes.subarray(start, i + 1).toString('base64'), origin: { path: plan.path, offset: cursor.offset + start } });
      start = i + 1;
      if (records.length >= 10000) break;
    }
    if (bytes.length <= READ_BYTES) bytes = bytes.subarray(0, start);
    let result: unknown;
    if (bytes.length > READ_BYTES) {
      const hash = digest(bytes);
      for (let fragment = 0; fragment < bytes.length;) {
        const next = Math.min(bytes.length, fragment + READ_BYTES);
        result = await this.post(this.state!.files[plan.path].bot_uid, '/ingest/fragments', {
          source_id: this.state!.source_id, stream_id: plan.stream_id,
          record_offset: cursor.offset - plan.base, fragment_offset: fragment, total_bytes: bytes.length, record_hash: hash,
          origin: { path: plan.path, offset: cursor.offset }, raw_base64: bytes.subarray(fragment, next).toString('base64'),
        });
        if (!object(result) || !integer(result.next_fragment_offset) || result.next_fragment_offset < next || result.next_fragment_offset > bytes.length) throw Error('invalid Monday fragment ACK');
        fragment = result.next_fragment_offset;
      }
    } else result = await this.post(this.state!.files[plan.path].bot_uid, '/ingest/batches', {
      source_id: this.state!.source_id, stream_id: plan.stream_id, harness: 'xiaoba', records,
    });
    if (!result || typeof result !== 'object' || !('next_offset' in result) || result.next_offset !== cursor.offset + bytes.length - plan.base ||
        !('sha256' in result) || result.sha256 !== digest(bytes)) throw Error('invalid Monday ACK; cursor not advanced');
    // Recheck the actual source bytes before trusting this checkpoint.
    const check = await fs.open(absolute, 'r');
    try {
      const verify = Buffer.alloc(bytes.length);
      const read = await check.read(verify, 0, verify.length, cursor.offset);
      if (read.bytesRead !== bytes.length || !verify.equals(bytes)) throw Error('source changed during upload');
    } finally { await check.close(); }
    hasher.update(bytes);
    cursor.hash = hasher.copy().digest('hex'); cursor.offset += bytes.length;
    this.hashes.set(cacheKey, { offset: cursor.offset, mtime: stat.mtimeMs, size: stat.size, hash: hasher });
    await this.save();
  }
}
