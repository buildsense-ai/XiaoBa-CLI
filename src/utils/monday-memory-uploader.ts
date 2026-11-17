import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID, type Hash } from 'crypto';
import { glob } from 'glob';
import { Logger } from './logger';

type Lane = 'backfill' | 'incremental';
interface Cursor { offset: number; hash: string }
interface FileState {
  generation: string;
  baseline: number;
  backfill: Cursor;
  incremental: Cursor;
  error?: string;
}
interface FilePlan { path: string; stream_id: string; start: number; end: number; base: number }
interface Manifest {
  manifest_id: string;
  session_key: string;
  lane: Lane;
  files: FilePlan[];
  registered: boolean;
}
interface State {
  version: 1;
  endpoint: string;
  dataset: string;
  source_id: string;
  last_discovery: number;
  files: Record<string, FileState>;
  manifests: Manifest[];
}
export interface MondayMemoryConfig { endpoint: string; key: string; dataset: string; root: string }
const digest = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
const MAX_BODY = 3 * 1024 * 1024;
const READ_BYTES = 1024 * 1024;
const safePath = (p: string) => /^sessions\/(chat|cli|catscompany|feishu|weixin)\/\d{4}-\d{2}-\d{2}\/[^/\\]+\.jsonl$/.test(p);

export function mondayMemoryConfig(root: string, env = process.env): MondayMemoryConfig | undefined {
  if (env.MONDAY_MEMORY_ENABLED !== 'true' || env.XIAOBA_ROLE === 'inspector-cat') return;
  const endpoint = env.MONDAY_MEMORY_URL?.replace(/\/$/, '');
  if (!endpoint || !env.MONDAY_MEMORY_KEY || !env.MONDAY_MEMORY_DATASET) throw Error('Monday memory requires URL, KEY and DATASET');
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('invalid Monday memory URL');
  return { endpoint, key: env.MONDAY_MEMORY_KEY, dataset: env.MONDAY_MEMORY_DATASET, root };
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
    this.statePath = path.join(config.root, 'data', 'monday-memory-state.json');
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
      const value: State = JSON.parse(await fs.readFile(this.statePath, 'utf8'));
      if (value.version !== 1 || value.endpoint !== this.config.endpoint || value.dataset !== this.config.dataset ||
          typeof value.source_id !== 'string' || !value.files || !Array.isArray(value.manifests)) throw Error('Monday memory state mismatch; explicit reset required');
      this.state = value;
    } catch (e) {
      if (!(e instanceof Error) || !('code' in e) || e.code !== 'ENOENT') throw e;
      this.state = { version: 1, endpoint: this.config.endpoint, dataset: this.config.dataset, source_id: 'bot_' + randomUUID(), last_discovery: 0, files: {}, manifests: [] };
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
  private async post(route: string, body: unknown): Promise<unknown> {
    const text = JSON.stringify(body);
    if (Buffer.byteLength(text) > MAX_BODY) throw Error('Monday request exceeds transport budget');
    const response = await fetch(this.config.endpoint + '/v1' + route, {
      method: 'POST', headers: { authorization: 'Bearer ' + this.config.key, 'content-type': 'application/json' },
      body: text, signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw Error('Monday HTTP ' + response.status);
    return response.json();
  }
  /** Public for manual runs/tests; normal startup uses the same persistent cycle. */
  async cycle(now = Date.now()): Promise<void> {
    if (!this.lock) { await this.acquire(); await this.load(); }
    const state = this.state!;
    if (!state.last_discovery || now >= nextMemoryScan(state.last_discovery)) await this.discover(now);
    // One bounded chunk per file and lane before rotating, with new material first.
    for (const lane of ['incremental', 'backfill'] as const) {
      for (const manifest of state.manifests.filter(m => m.lane === lane)) {
        if (this.stopped) return;
        try {
          if (!manifest.registered) {
            await this.post('/ingest/manifests', {
              dataset_id: this.config.dataset, source_id: state.source_id,
              manifest_id: manifest.manifest_id, session_key: manifest.session_key, lane,
              files: manifest.files.map(f => ({ stream_id: f.stream_id, end_offset: f.end - f.base, path: f.path })),
            });
            manifest.registered = true; await this.save();
          }
          for (const file of manifest.files) {
            const cursor = state.files[file.path][lane];
            if (cursor.offset < file.end) {
              try { await this.send(file, lane); delete state.files[file.path].error; }
              catch (error) { state.files[file.path].error = error instanceof Error ? error.message : 'upload failed'; await this.save(); throw error; }
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
      const absolute = path.join(this.config.root, 'logs', relative), stat = await fs.lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const end = await completeEnd(absolute);
      if (!state.files[relative]) state.files[relative] = {
        generation: randomUUID(), baseline: state.last_discovery ? 0 : end,
        backfill: { offset: 0, hash: digest('') }, incremental: { offset: state.last_discovery ? 0 : end, hash: state.last_discovery ? digest('') : (await prefixHasher(absolute, end)).digest('hex') },
      };
      const file = state.files[relative];
      if (end < file.baseline) throw Error('source rewritten: ' + relative);
      const session = relative.split('/')[1] + '/' + path.basename(relative);
      for (const lane of ['backfill', 'incremental'] as const) {
        const base = lane === 'backfill' ? 0 : file.baseline;
        const target = lane === 'backfill' ? file.baseline : end;
        const planned = Math.max(file[lane].offset, ...state.manifests.filter(m => m.lane === lane).flatMap(m => m.files.filter(f => f.path === relative).map(f => f.end)));
        if (target <= planned) continue;
        const key = session + ':' + lane;
        if (!plans.has(key)) plans.set(key, { manifest_id: 'scan_' + randomUUID(), session_key: session, lane, files: [], registered: false });
        plans.get(key)!.files.push({ path: relative, base, start: planned, end: target, stream_id: digest(file.generation + ':' + lane) });
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
      if (end < 0) throw Error('record_too_large at ' + plan.path + ':' + cursor.offset);
      bytes = buffer.subarray(0, end + 1);
    } finally { await handle.close(); }
    const records = [];
    let start = 0;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) {
      records.push({ offset: cursor.offset + start - plan.base, raw_base64: bytes.subarray(start, i + 1).toString('base64'), origin: { path: plan.path, offset: cursor.offset + start } });
      start = i + 1;
      if (records.length >= 10000) break;
    }
    bytes = bytes.subarray(0, start);
    const result = await this.post('/ingest/batches', {
      dataset_id: this.config.dataset, source_id: this.state!.source_id, stream_id: plan.stream_id, harness: 'xiaoba', records,
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
