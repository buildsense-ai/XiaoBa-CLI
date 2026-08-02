import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  fingerprintManifest,
  fingerprintRoundEvidence,
} from './canonical';
import {
  parseLedgerJson,
  parseManifestJson,
  parseRoundJsonl,
} from './schema';
import {
  CACHE_BENCHMARK_LEDGER_SCHEMA,
  type CacheBenchmarkLedger,
  type CacheBenchmarkManifest,
  type CacheBenchmarkRoundEvidence,
} from './types';

export interface SealedRoundArtifacts {
  manifestPath: string;
  ledgerPath: string;
  evidencePath: string;
  evidenceFingerprint: string;
}

/** Private crash-consistent store for credential-free benchmark evidence. */
export class CacheBenchmarkEvidenceStore {
  readonly directory: string;
  readonly manifestPath: string;
  readonly ledgerPath: string;

  constructor(directory: string) {
    this.directory = preparePrivateDirectory(directory);
    this.manifestPath = path.join(this.directory, 'manifest.json');
    this.ledgerPath = path.join(this.directory, 'ledger.json');
  }

  writeManifest(manifest: CacheBenchmarkManifest): string {
    const parsed = parseManifestJson(`${JSON.stringify(manifest)}\n`);
    const source = `${JSON.stringify(parsed, null, 2)}\n`;
    if (fs.existsSync(this.manifestPath)) {
      const existing = readPrivateFile(this.manifestPath);
      const existingManifest = parseManifestJson(existing);
      if (fingerprintManifest(existingManifest) !== fingerprintManifest(parsed)) {
        throw new Error('manifest_mismatch');
      }
      return this.manifestPath;
    }
    writeAtomicPrivateFile(this.directory, this.manifestPath, source);
    return this.manifestPath;
  }

  sealRound(
    manifest: CacheBenchmarkManifest,
    evidence: CacheBenchmarkRoundEvidence,
  ): SealedRoundArtifacts {
    this.writeManifest(manifest);
    const parsedEvidence = parseRoundJsonl(serializeRound(evidence));
    if (parsedEvidence.header.manifest_fingerprint !== fingerprintManifest(manifest)) {
      throw new Error('round_manifest_mismatch');
    }
    const round = parsedEvidence.header.round;
    const evidencePath = path.join(this.directory, `round-${round}.jsonl`);
    const source = serializeRound(parsedEvidence);
    const fingerprint = fingerprintRoundEvidence(parsedEvidence);
    const ledger = this.readLedger(manifest.suite_id);
    const expectedRound = (ledger?.latest_round ?? 0) + 1;

    if (round !== expectedRound) {
      const existingEntry = ledger?.rounds.find(entry => entry.round === round);
      if (!existingEntry || existingEntry.evidence_fingerprint !== fingerprint) {
        throw new Error('round_not_contiguous');
      }
      if (!fs.existsSync(evidencePath)) throw new Error('sealed_round_missing');
      if (fingerprintRoundEvidence(parseRoundJsonl(readPrivateFile(evidencePath))) !== fingerprint) {
        throw new Error('sealed_round_mismatch');
      }
      return {
        manifestPath: this.manifestPath,
        ledgerPath: this.ledgerPath,
        evidencePath,
        evidenceFingerprint: fingerprint,
      };
    }

    if (fs.existsSync(evidencePath)) {
      const existing = parseRoundJsonl(readPrivateFile(evidencePath));
      if (fingerprintRoundEvidence(existing) !== fingerprint) {
        throw new Error('orphan_round_mismatch');
      }
    } else {
      writeAtomicPrivateFile(this.directory, evidencePath, source);
    }

    const nextLedger: CacheBenchmarkLedger = {
      schema: CACHE_BENCHMARK_LEDGER_SCHEMA,
      suite_id: manifest.suite_id,
      latest_round: round,
      rounds: [
        ...(ledger?.rounds ?? []),
        { round, evidence_fingerprint: fingerprint },
      ],
    };
    replaceAtomicPrivateFile(
      this.directory,
      this.ledgerPath,
      `${JSON.stringify(nextLedger, null, 2)}\n`,
    );
    return {
      manifestPath: this.manifestPath,
      ledgerPath: this.ledgerPath,
      evidencePath,
      evidenceFingerprint: fingerprint,
    };
  }

  private readLedger(suiteId: string): CacheBenchmarkLedger | undefined {
    if (!fs.existsSync(this.ledgerPath)) return undefined;
    const ledger = parseLedgerJson(readPrivateFile(this.ledgerPath));
    if (ledger.suite_id !== suiteId) throw new Error('ledger_suite_mismatch');
    return ledger;
  }
}

function serializeRound(evidence: CacheBenchmarkRoundEvidence): string {
  return [evidence.header, ...evidence.attempts]
    .map(value => JSON.stringify(value))
    .join('\n') + '\n';
}

function preparePrivateDirectory(value: string): string {
  const directory = path.resolve(value);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('evidence_directory_invalid');
  assertOwner(stat);
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  return directory;
}

function readPrivateFile(filePath: string): string {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('evidence_file_invalid');
  assertOwner(stat);
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) {
    throw new Error('evidence_file_not_private');
  }
  return fs.readFileSync(filePath, 'utf8');
}

function writeAtomicPrivateFile(directory: string, target: string, source: string): void {
  if (fs.existsSync(target)) throw new Error('evidence_file_exists');
  replaceAtomicPrivateFile(directory, target, source);
}

function replaceAtomicPrivateFile(directory: string, target: string, source: string): void {
  const temporary = path.join(directory, `.tmp-${process.pid}-${randomUUID()}`);
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow,
      0o600,
    );
    const buffer = Buffer.from(source, 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, target);
    if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
    fsyncDirectory(directory);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function assertOwner(stat: fs.Stats): void {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('evidence_owner_mismatch');
  }
}

function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
