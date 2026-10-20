import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { withCurrentBotSkillWorkspaceWrite } from '../bot-skills/runtime';
import { createCatsCoLocalConfigService, isActiveDeviceConnectorMode } from '../catscompany/local-config';
import { capturePublicationSource, findPublicationSource, PublicationSourceError, publicationSourceProbeEnabled,
  type PublicationSourceBinding, type PublicationSourceDescriptor } from './publication-source';

export const PUBLICATION_CAPTURE = 'skillhub.publication.capture.v1';
export function publicationCaptureEnabled(): boolean {
  const value = (process.env.XIAOBA_SKILLHUB_PUBLICATION_CAPTURE_ENABLED || '').trim().toLowerCase();
  return publicationSourceProbeEnabled() && (value === '1' || value === 'true');
}

export interface PublicationCaptureInput {
  entryId: string;
  binding: PublicationSourceBinding;
  source: PublicationSourceDescriptor;
}
export interface PublicationCaptureReceipt {
  schemaVersion: 1;
  entryId: string;
  candidateRevision: 1;
  sourceSnapshotHash: string;
  requestHash: string;
  requestBytes: number;
}
type File = { path: string; contentBase64: string };
type Saved = { schemaVersion: 1; input: PublicationCaptureInput; receipt: PublicationCaptureReceipt; requestBody: string };
const maxRecord = 32 * 1024 * 1024;
const maxStorage = 256 * 1024 * 1024;
const maxRecords = 32;
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const fail = (code = 'publication.capture_unsafe'): never => { throw new PublicationSourceError(code); };
const exact = (o: any, keys: string) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join(',') === keys;
const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort(byteOrder).map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function validateInput(input: PublicationCaptureInput): void {
  if (!exact(input, 'binding,entryId,source') || typeof input.entryId !== 'string' || !/^pubentry_[a-f0-9]{32}$/.test(input.entryId) ||
    !exact(input.binding, 'bodyId,botUid,installationId,ownerUid') || !exact(input.source, 'local_skill_id,workspace_generation') ||
    ![input.binding.botUid, input.binding.ownerUid].every(v => typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v)) ||
    ![input.binding.bodyId, input.binding.installationId].every(v => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(v)) ||
    typeof input.source.local_skill_id !== 'string' || !/^pubsrc-[a-f0-9]{48}$/.test(input.source.local_skill_id) ||
    typeof input.source.workspace_generation !== 'string' || !/^[a-f0-9]{64}$/.test(input.source.workspace_generation)) fail('publication.capture_invalid');
}
function safePath(p: unknown): p is string {
  return typeof p === 'string' && !!p && Buffer.from(p).toString('utf8') === p && p.length <= 180 &&
    !/[\x00-\x1f\x7f\\]/.test(p) && !/^[a-z]:/i.test(p) && !p.startsWith('~') &&
    p.split('/').length <= 12 && p.split('/').every(s => !!s && s !== '.' && s !== '..');
}
// Matches Cloud skillhub-publish-candidate-v1 for a source-only file request.
// Does not infer/repair manifest fields or parse SKILL.md/skill.json.
function candidateHash(files: File[]): string {
  if (!Array.isArray(files) || !files.length || files.length > 500) fail('publication.capture_limit');
  const seen = new Set<string>(); let total = 0;
  const facts = files.map(file => {
    if (!exact(file, 'contentBase64,path') || !safePath(file.path) || seen.has(file.path) || typeof file.contentBase64 !== 'string' || file.contentBase64.length > 7 * 1024 * 1024) fail();
    seen.add(file.path);
    const bytes = Buffer.from(file.contentBase64, 'base64'); total += bytes.length;
    if (bytes.toString('base64') !== file.contentBase64 || bytes.length > 5 * 1024 * 1024 || total > 20 * 1024 * 1024) fail('publication.capture_limit');
    return { path: file.path, size: bytes.length, sha256: sha(bytes) };
  });
  if (!seen.has('SKILL.md')) fail();
  for (const f of facts) {
    const parts = f.path.split('/');
    if (parts.slice(0, -1).some((_, i) => seen.has(parts.slice(0, i + 1).join('/')))) fail();
  }
  return sha(canonical({ domain: 'skillhub-publish-candidate-v1', manifest: {}, files: facts.sort((a,b) => byteOrder(a.path,b.path)) }));
}
function sameStat(a: fs.Stats, b: fs.Stats): void {
  if (a.dev !== b.dev || a.ino !== b.ino || a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.ctimeMs !== b.ctimeMs) fail('publication.capture_changed');
}
function directory(p: string): void {
  const s = fs.lstatSync(p);
  if (!s.isDirectory() || s.isSymbolicLink()) fail();
}
function regular(p: string): fs.Stats {
  const s = fs.lstatSync(p);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > maxRecord ||
    (process.platform !== 'win32' && (s.mode & 0o077) !== 0)) fail();
  return s;
}

// Internal storage, not a tool/HTTP endpoint. The reserved CatsCo capture RPC
// authenticates its envelope before calling. Uploads require separate authority.
// Storage is enabled only by explicit construction.
export class PublicationCaptureStore {
  constructor(private readonly options: { runtimeRoot: string; enabled?: boolean }) {}

  async capture(input: PublicationCaptureInput, checkAuthority: () => void): Promise<PublicationCaptureReceipt> {
    validateInput(input);
    input = { ...input, binding: { ...input.binding }, source: { ...input.source } };
    return this.locked(input, checkAuthority, (root, skills, check) => {
      const file = path.join(root, `${input.entryId}.json`);
      if (fs.existsSync(file)) return this.load(file, input).receipt;
      this.quota(root, 0);
      const source = findPublicationSource(skills, input.source.local_skill_id, check);
      // Match the existing probe's binding serialization, independent of the
      // internal caller's JSON/property insertion order.
      const probeBinding = { botUid: input.binding.botUid, ownerUid: input.binding.ownerUid,
        bodyId: input.binding.bodyId, installationId: input.binding.installationId };
      const captured = capturePublicationSource(skills, source, probeBinding, check);
      if (canonical(captured.descriptor) !== canonical(input.source)) fail('publication.source_changed');
      const requestBody = JSON.stringify({ source: { type: 'files', files: captured.files.sort((a,b) => byteOrder(a.path,b.path)) } });
      const receipt: PublicationCaptureReceipt = { schemaVersion: 1, entryId: input.entryId, candidateRevision: 1,
        sourceSnapshotHash: candidateHash(captured.files), requestHash: sha(requestBody), requestBytes: Buffer.byteLength(requestBody) };
      const record = Buffer.from(JSON.stringify({ schemaVersion: 1, input, receipt, requestBody } satisfies Saved));
      if (record.length > maxRecord) fail('publication.capture_limit');
      this.quota(root, record.length); check();
      const temporary = path.join(root, `.pending-${randomBytes(16).toString('hex')}`);
      let owned = false;
      try {
        const fd = fs.openSync(temporary, 'wx', 0o600); owned = true;
        try { fs.writeFileSync(fd, record); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        check(); directory(root);
        if (fs.existsSync(file)) fail('publication.capture_conflict');
        fs.renameSync(temporary, file); owned = false;
        // POSIX fsync of the parent makes the rename durable across power loss.
        // Windows has no portable directory fsync; restart/torn-write checks
        // still fail closed, without claiming a power-loss durability guarantee.
        if (process.platform !== 'win32') {
          const fd = fs.openSync(root, fs.constants.O_RDONLY);
          try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        }
      } finally { if (owned) fs.unlinkSync(temporary); }
      return this.load(file, input).receipt;
    });
  }

  // Raw bytes are available only through an explicit internal read, never in a
  // receipt, error, log or automatically serialized class property.
  async readRequest(input: PublicationCaptureInput, checkAuthority: () => void): Promise<Buffer> {
    return (await this.readCandidate(input, checkAuthority)).bytes;
  }

  // Explicit internal uploader access; receipt and exact bytes are verified
  // together under one lock. Never serialize this object onto generic RPC.
  async readCandidate(input: PublicationCaptureInput, checkAuthority: () => void): Promise<{ receipt: PublicationCaptureReceipt; bytes: Buffer }> {
    validateInput(input);
    input = { ...input, binding: { ...input.binding }, source: { ...input.source } };
    return this.locked(input, checkAuthority, root => {
      const saved = this.load(path.join(root, `${input.entryId}.json`), input);
      return { receipt: saved.receipt, bytes: Buffer.from(saved.requestBody) };
    });
  }

  private async locked<T>(input: PublicationCaptureInput, checkAuthority: () => void,
    operation: (root: string, skills: string, check: () => void) => T): Promise<T> {
    try {
      if (!this.options.enabled) fail('publication.runtime_unsupported');
      validateInput(input);
      if (typeof checkAuthority !== 'function') fail('publication.capture_invalid');
      const runtime = path.resolve(this.options.runtimeRoot); directory(runtime);
      for (const segment of ['data', path.join('data','bot-skills')]) {
        const ancestor = path.join(runtime, segment);
        if (fs.existsSync(ancestor)) directory(ancestor);
      }
      const deadline = Date.now() + 10_000;
      const check = () => {
        if (Date.now() >= deadline) fail('publication.runtime_unavailable');
        const result: unknown = checkAuthority();
        if (result !== undefined) fail('publication.capture_invalid'); // never ignore an asynchronous authorization check
      };
      const binding = () => {
        check();
        const c = createCatsCoLocalConfigService({ runtimeRoot: runtime }).load();
        const actual = { botUid: String(c.currentBot?.uid || ''), ownerUid: String(c.currentBot?.boundByUserUid || ''),
          bodyId: String(c.device?.bodyId || ''), installationId: String(c.device?.installationId || '') };
        if (isActiveDeviceConnectorMode(c) || canonical(actual) !== canonical(input.binding)) fail('publication.capture_conflict');
      };
      binding();
      return await withCurrentBotSkillWorkspaceWrite(context => {
        binding();
        if (context.deviceConnectorMode || context.botId !== input.binding.botUid || context.activeBotId !== input.binding.botUid) fail('publication.capture_conflict');
        const planned = path.join(fs.realpathSync(runtime), 'data', 'skillhub-publications');
        const relativeBefore = path.relative(fs.realpathSync(context.skillsRoot), planned);
        if (!relativeBefore || (!relativeBefore.startsWith(`..${path.sep}`) && relativeBefore !== '..' && !path.isAbsolute(relativeBefore))) fail();
        let root = runtime;
        for (const name of ['data', 'skillhub-publications']) {
          root = path.join(root, name);
          if (!fs.existsSync(root)) fs.mkdirSync(root, { mode: 0o700 });
          directory(root);
        }
        const relative = path.relative(fs.realpathSync(context.skillsRoot), fs.realpathSync(root));
        if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) fail();
        if (process.platform !== 'win32' && (fs.statSync(root).mode & 0o077) !== 0) fail();
        const result = operation(root, context.skillsRoot, () => { check(); });
        binding(); return result;
      }, { runtimeRoot: runtime, lockWaitMs: 1000 });
    } catch (error) {
      if (error instanceof PublicationSourceError) throw error;
      return fail('publication.runtime_unavailable');
    }
  }

  private quota(root: string, additional: number): void {
    const h = fs.opendirSync(root); let count = 0, bytes = 0;
    try {
      for (let entry = h.readSync(); entry; entry = h.readSync()) {
        if (++count >= maxRecords || !/^(pubentry_[a-f0-9]{32}\.json|\.pending-[a-f0-9]{32})$/.test(entry.name)) fail('publication.capture_limit');
        bytes += regular(path.join(root, entry.name)).size;
        if (bytes + additional > maxStorage) fail('publication.capture_limit');
      }
    } finally { h.closeSync(); }
    if (bytes + additional > maxStorage) fail('publication.capture_limit');
  }

  private load(file: string, input: PublicationCaptureInput): Saved {
    const before = regular(file);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    let raw: Buffer;
    try {
      sameStat(before, fs.fstatSync(fd));
      raw = Buffer.alloc(before.size);
      let at = 0;
      while (at < raw.length) { const n = fs.readSync(fd, raw, at, raw.length - at, null); if (!n) fail('publication.capture_changed'); at += n; }
      sameStat(before, fs.fstatSync(fd)); sameStat(before, regular(file));
    } finally { fs.closeSync(fd); }
    const saved: Saved = JSON.parse(raw.toString('utf8'));
    if (!exact(saved, 'input,receipt,requestBody,schemaVersion') || saved.schemaVersion !== 1 || canonical(saved.input) !== canonical(input) || typeof saved.requestBody !== 'string') fail('publication.capture_conflict');
    const body = JSON.parse(saved.requestBody);
    if (!exact(body,'source') || !exact(body.source,'files,type') || body.source.type !== 'files') fail();
    const receipt: PublicationCaptureReceipt = { schemaVersion: 1, entryId: input.entryId, candidateRevision: 1,
      sourceSnapshotHash: candidateHash(body.source.files), requestHash: sha(saved.requestBody), requestBytes: Buffer.byteLength(saved.requestBody) };
    if (canonical(saved.receipt) !== canonical(receipt)) fail('publication.capture_changed');
    return saved;
  }
}
