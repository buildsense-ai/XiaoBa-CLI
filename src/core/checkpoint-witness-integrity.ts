import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Message } from '../types';
import { PathResolver } from '../utils/path-resolver';

const PROVENANCE_SCHEMA = 'xiaoba.checkpoint_completed_tool_witness.v1' as const;
const KEY_FILE_NAME = 'checkpoint-completed-tool-witness.key';
const CONFIGURED_KEY_ENV = 'XIAOBA_CHECKPOINT_WITNESS_INTEGRITY_KEY';

type CompletedToolCalls = NonNullable<Message['__checkpointCompletedToolCalls']>;
type WitnessProvenance = NonNullable<Message['__checkpointCompletedToolWitnessProvenance']>;

let cachedIntegrityKey: Buffer | undefined;

export function signCheckpointCompletedToolWitness(
  episodeId: string,
  entries: CompletedToolCalls,
): WitnessProvenance {
  const key = checkpointWitnessIntegrityKey(true);
  const keyIdSha256 = integrityKeyId(key);
  return {
    schema: PROVENANCE_SCHEMA,
    episodeId,
    keyIdSha256,
    macSha256: witnessMac(key, keyIdSha256, episodeId, entries),
  };
}

export function verifyCheckpointCompletedToolWitness(
  provenance: WitnessProvenance | undefined,
  episodeId: string,
  entries: CompletedToolCalls,
): boolean {
  if (
    provenance?.schema !== PROVENANCE_SCHEMA
    || provenance.episodeId !== episodeId
    || !/^[a-f0-9]{64}$/u.test(provenance.keyIdSha256)
    || !/^[a-f0-9]{64}$/u.test(provenance.macSha256)
  ) return false;
  const key = checkpointWitnessIntegrityKey(false);
  const currentKeyId = integrityKeyId(key);
  if (provenance.keyIdSha256 !== currentKeyId) {
    throw new Error('checkpoint witness integrity key identity mismatch');
  }
  const expected = Buffer.from(witnessMac(
    key,
    provenance.keyIdSha256,
    episodeId,
    entries,
  ), 'hex');
  const actual = Buffer.from(provenance.macSha256, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function witnessMac(
  key: Buffer,
  keyIdSha256: string,
  episodeId: string,
  entries: CompletedToolCalls,
): string {
  return createHmac('sha256', key)
    .update(JSON.stringify([PROVENANCE_SCHEMA, keyIdSha256, episodeId, entries]), 'utf8')
    .digest('hex');
}

function integrityKeyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex');
}

function checkpointWitnessIntegrityKey(createIfMissing: boolean): Buffer {
  if (cachedIntegrityKey) return cachedIntegrityKey;
  const configured = String(process.env[CONFIGURED_KEY_ENV] || '').trim();
  if (/^[a-f0-9]{64}$/iu.test(configured)) {
    cachedIntegrityKey = Buffer.from(configured, 'hex');
    return cachedIntegrityKey;
  }

  const stateDirectory = path.join(PathResolver.getRuntimeDataRoot(), 'state');
  const keyPath = path.join(stateDirectory, KEY_FILE_NAME);
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(stateDirectory, 0o700); } catch { /* best effort */ }
  cachedIntegrityKey = createIfMissing
    ? loadOrCreateDurableIntegrityKey(stateDirectory, keyPath)
    : readDurableIntegrityKey(keyPath);
  return cachedIntegrityKey;
}

function loadOrCreateDurableIntegrityKey(
  stateDirectory: string,
  keyPath: string,
): Buffer {
  try {
    return readDurableIntegrityKey(keyPath);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    createDurableIntegrityKeyCandidate(stateDirectory, keyPath);
    return readDurableIntegrityKey(keyPath);
  }
}

function readDurableIntegrityKey(keyPath: string): Buffer {
  const keyStat = fs.lstatSync(keyPath);
  if (!keyStat.isFile() || keyStat.isSymbolicLink()) {
    throw new Error('checkpoint witness integrity key is not a regular file');
  }
  const persisted = fs.readFileSync(keyPath);
  if (persisted.length !== 32) {
    // Fail closed. This key has never shipped, so there is no legacy invalid
    // artifact to migrate. Never deleting an existing path avoids TOCTOU that
    // could invalidate witnesses signed concurrently by another process.
    throw new Error('checkpoint witness integrity key has invalid length');
  }
  try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort */ }
  return Buffer.from(persisted);
}

function createDurableIntegrityKeyCandidate(
  stateDirectory: string,
  keyPath: string,
): void {
  const candidatePath = path.join(
    stateDirectory,
    `.${KEY_FILE_NAME}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  const fd = fs.openSync(candidatePath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, randomBytes(32));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    // Link publishes the already-complete inode only if the final path is
    // absent. Concurrent creators converge on the winner without overwriting
    // or deleting any existing key.
    fs.linkSync(candidatePath, keyPath);
    try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort */ }
    fsyncDirectory(stateDirectory);
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
  } finally {
    try { fs.unlinkSync(candidatePath); } catch { /* best effort */ }
  }
}

function fsyncDirectory(directory: string): void {
  try {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {
    // Directory fsync is unavailable on some platforms; the complete key file
    // is still published atomically and protected by its file mode.
  }
}
