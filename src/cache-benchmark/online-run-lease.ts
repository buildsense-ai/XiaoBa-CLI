import * as fs from 'node:fs';
import * as path from 'node:path';

const RUN_SCHEMA = 'xiaoba.cache_benchmark_online_run.v1' as const;

/**
 * Holds an output-directory writer lock from round reservation through seal.
 * An unsealed reservation is deliberately unrecoverable in place: callers
 * must preserve it as failed evidence and use a new output directory.
 */
export class OnlineBenchmarkRunLease {
  readonly directory: string;
  readonly runPath: string;
  private readonly lockPath: string;
  private lockFd: number | undefined;
  private runFd: number | undefined;
  private completed = false;

  constructor(input: {
    directory: string;
    suiteId: string;
    round: number;
    artifactFingerprint: string;
    manifestFingerprint: string;
    configFingerprint: string;
    cachePartitionNonce: string;
  }) {
    if (!/^[a-f0-9]{32}$/.test(input.cachePartitionNonce)) {
      throw new Error('benchmark_partition_nonce_invalid');
    }
    this.directory = preparePrivateDirectory(input.directory);
    this.lockPath = path.join(this.directory, '.online-run.lock');
    this.runPath = path.join(this.directory, `round-${input.round}.run.jsonl`);
    try {
      this.lockFd = openExclusivePrivate(this.lockPath);
      appendAndSync(this.lockFd, `${JSON.stringify({
        schema: RUN_SCHEMA,
        state: 'locked',
        suite_id: input.suiteId,
        round: input.round,
        cache_partition_nonce: input.cachePartitionNonce,
      })}\n`);
      fsyncDirectory(this.directory);
      this.assertNoIncompleteReservation();
      if (fs.existsSync(this.runPath)) throw new Error('online_round_already_reserved');
      this.runFd = openExclusivePrivate(this.runPath);
      appendAndSync(this.runFd, `${JSON.stringify({
        schema: RUN_SCHEMA,
        state: 'started',
        suite_id: input.suiteId,
        round: input.round,
        cache_partition_nonce: input.cachePartitionNonce,
        artifact_fingerprint: input.artifactFingerprint,
        manifest_fingerprint: input.manifestFingerprint,
        config_fingerprint: input.configFingerprint,
      })}\n`);
      fsyncDirectory(this.directory);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  complete(evidenceFingerprint: string): void {
    if (this.completed || this.runFd === undefined) throw new Error('online_round_lease_invalid');
    appendAndSync(this.runFd, `${JSON.stringify({
      schema: RUN_SCHEMA,
      state: 'sealed',
      evidence_fingerprint: evidenceFingerprint,
    })}\n`);
    fs.closeSync(this.runFd);
    this.runFd = undefined;
    this.completed = true;
    fsyncDirectory(this.directory);
    this.releaseLock();
  }

  close(): void {
    if (this.runFd !== undefined) {
      try { fs.fsyncSync(this.runFd); } finally { fs.closeSync(this.runFd); }
      this.runFd = undefined;
    }
    this.releaseLock();
  }

  private assertNoIncompleteReservation(): void {
    for (const name of fs.readdirSync(this.directory)) {
      if (!/^round-[1-9][0-9]*\.run\.jsonl$/.test(name)) continue;
      const file = path.join(this.directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('online_round_reservation_invalid');
      if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) {
        throw new Error('online_round_reservation_not_private');
      }
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
      let terminal: unknown;
      try { terminal = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : undefined; } catch {}
      if (!terminal || (terminal as any).schema !== RUN_SCHEMA || (terminal as any).state !== 'sealed') {
        throw new Error('online_incomplete_round_exists');
      }
    }
  }

  private releaseLock(): void {
    if (this.lockFd === undefined) return;
    try { fs.closeSync(this.lockFd); } finally { this.lockFd = undefined; }
    if (fs.existsSync(this.lockPath)) {
      try {
        fs.unlinkSync(this.lockPath);
      } catch {
        throw new Error('online_lock_release_failed');
      }
      fsyncDirectory(this.directory);
    }
  }
}

function preparePrivateDirectory(value: string): string {
  const directory = path.resolve(value);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('online_output_directory_invalid');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('online_output_owner_mismatch');
  }
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  return directory;
}

function openExclusivePrivate(filePath: string): number {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  return fs.openSync(
    filePath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow,
    0o600,
  );
}

function appendAndSync(fd: number, source: string): void {
  const buffer = Buffer.from(source, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
  }
  fs.fsyncSync(fd);
}

function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
