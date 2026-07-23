import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BotSkillRef } from '../bot-definition/types';
import {
  BOT_SKILL_LOCAL_IDENTITY_FILE,
  type LocalSkillManifestEntry,
} from './local-manifest';
import {
  SKILLHUB_INSTALL_MARKER_FILE,
  readSkillHubInstallMarker,
  writeSkillHubInstallMarker,
} from '../skillhub/install-marker';
import type { SkillHubPackageInstallMarker } from '../skillhub/types';

export const SIMULATED_SKILL_ARTIFACT_SCHEMA = 'xiaoba.simulated-skill-artifact.v1';

const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 256;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PATH_LENGTH = 512;
const MAX_PATH_DEPTH = 24;
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '__pycache__']);
const SKIP_FILES = new Set([BOT_SKILL_LOCAL_IDENTITY_FILE, SKILLHUB_INSTALL_MARKER_FILE]);

export interface SimulatedSkillArtifactFile {
  path: string;
  size: number;
  sha256: string;
  contentBase64: string;
}

export interface SimulatedSkillArtifact {
  schema: typeof SIMULATED_SKILL_ARTIFACT_SCHEMA;
  botId: string;
  localSkillId: string;
  ref: BotSkillRef;
  storage: 'skillhub-mirror' | 'simulated-private';
  name: string;
  installName: string;
  contentHash: string;
  artifactDigest: string;
  files: SimulatedSkillArtifactFile[];
  installMarker?: SkillHubPackageInstallMarker;
}

export interface PutSimulatedSkillArtifactOptions {
  botId: string;
  skillsRoot: string;
  entry: LocalSkillManifestEntry;
  publicRef?: BotSkillRef;
}

export interface SimulatedSkillArtifactStore {
  put(options: PutSimulatedSkillArtifactOptions): SimulatedSkillArtifact;
  read(ref: BotSkillRef): SimulatedSkillArtifact;
  materialize(artifact: SimulatedSkillArtifact, targetDir: string): void;
}

export interface FileSimulatedSkillArtifactStoreOptions {
  runtimeRoot: string;
  root?: string;
  simulatedCloudRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export class FileSimulatedSkillArtifactStore implements SimulatedSkillArtifactStore {
  readonly root: string;

  constructor(options: FileSimulatedSkillArtifactStoreOptions) {
    const runtimeRoot = path.resolve(options.runtimeRoot);
    const simulatedCloudRoot = path.resolve(
      options.simulatedCloudRoot
        ?? options.env?.XIAOBA_BOT_DEFINITION_SIMULATED_CLOUD_DIR
        ?? process.env.XIAOBA_BOT_DEFINITION_SIMULATED_CLOUD_DIR
        ?? path.join(runtimeRoot, 'data', 'bot-definition-simulated-cloud'),
    );
    this.root = path.resolve(
      options.root ?? path.join(simulatedCloudRoot, 'skill-artifacts'),
    );
    if (!options.root) assertContained(simulatedCloudRoot, this.root, 'simulated Skill artifact root');
  }

  put(options: PutSimulatedSkillArtifactOptions): SimulatedSkillArtifact {
    const botId = required(options.botId, 'botId');
    const root = path.resolve(options.skillsRoot);
    const relative = normalizeRelativePath(options.entry.path);
    const skillDir = path.resolve(root, ...relative.split('/'));
    assertContained(root, skillDir, 'Skill artifact source');
    const files = collectArtifactFiles(skillDir);
    const publicRef = options.publicRef && normalizeRef(options.publicRef);
    const rawInstallMarker = publicRef
      ? readSkillHubInstallMarker(skillDir) ?? undefined
      : undefined;
    if (publicRef && (
      !isValidInstallMarker(rawInstallMarker)
      || rawInstallMarker.skillId !== publicRef.skillId
      || rawInstallMarker.version !== publicRef.version
    )) {
      throw new Error(`Public Skill artifact marker does not match ${publicRef.skillId}@${publicRef.version}`);
    }
    const installMarker = rawInstallMarker
      ? canonicalPublicInstallMarker(rawInstallMarker)
      : undefined;
    const storage = publicRef ? 'skillhub-mirror' : 'simulated-private';
    const artifactBotId = publicRef ? 'public' : botId;
    const artifactLocalSkillId = publicRef
      ? 'public'
      : required(options.entry.localSkillId, 'localSkillId');
    const artifactDigest = digest({
      botId: artifactBotId,
      localSkillId: artifactLocalSkillId,
      storage,
      name: required(options.entry.name, 'name').normalize('NFC'),
      installName: path.posix.basename(relative),
      contentHash: requiredHash(options.entry.contentHash, 'contentHash'),
      files: files.map(file => ({
        path: file.path,
        size: file.size,
        sha256: file.sha256,
      })),
      ...(installMarker ? { installMarker } : {}),
    });
    const ref = publicRef ?? {
      skillId: `sim-private:${sha256(`${botId}\0${options.entry.localSkillId}`)}`,
      version: `content-${artifactDigest}`,
    };
    const artifact: SimulatedSkillArtifact = {
      schema: SIMULATED_SKILL_ARTIFACT_SCHEMA,
      botId: artifactBotId,
      localSkillId: artifactLocalSkillId,
      ref,
      storage,
      name: required(options.entry.name, 'name').normalize('NFC'),
      installName: path.posix.basename(relative),
      contentHash: requiredHash(options.entry.contentHash, 'contentHash'),
      artifactDigest,
      files,
      ...(installMarker ? { installMarker } : {}),
    };
    const filePath = this.filePath(ref);
    const existing = this.inspectFile(filePath, ref);
    if (existing) {
      if (existing.artifactDigest !== artifact.artifactDigest) {
        throw new Error(`Immutable Skill artifact conflict for ${ref.skillId}@${ref.version}`);
      }
      return existing;
    }
    writeJsonAtomic(this.root, filePath, artifact);
    return artifact;
  }

  read(ref: BotSkillRef): SimulatedSkillArtifact {
    const normalized = normalizeRef(ref);
    const artifact = this.inspectFile(this.filePath(normalized), normalized);
    if (!artifact) {
      const error: NodeJS.ErrnoException = new Error(
        `Simulated Skill artifact is missing: ${normalized.skillId}@${normalized.version}`,
      );
      error.code = 'SIMULATED_SKILL_ARTIFACT_MISSING';
      throw error;
    }
    return artifact;
  }

  materialize(artifact: SimulatedSkillArtifact, targetDir: string): void {
    const parsed = parseArtifact(artifact, artifact.ref);
    if (!parsed) throw new Error('Simulated Skill artifact is invalid');
    const target = path.resolve(targetDir);
    if (fs.existsSync(target)) {
      throw new Error(`Artifact target already exists: ${target}`);
    }
    fs.mkdirSync(target, { recursive: false, mode: 0o700 });
    try {
      for (const file of parsed.files) {
        const outputPath = path.resolve(target, ...file.path.split('/'));
        assertContained(target, outputPath, 'Skill artifact output');
        ensureMaterializeDirectory(target, path.dirname(outputPath));
        fs.writeFileSync(outputPath, Buffer.from(file.contentBase64, 'base64'), {
          flag: 'wx',
          mode: 0o600,
        });
      }
      if (parsed.installMarker) {
        writeSkillHubInstallMarker(target, parsed.installMarker);
      }
    } catch (error) {
      fs.rmSync(target, { recursive: true, force: true });
      throw error;
    }
  }

  getPath(ref: BotSkillRef): string {
    return this.filePath(normalizeRef(ref));
  }

  private inspectFile(
    filePath: string,
    expectedRef: BotSkillRef,
  ): SimulatedSkillArtifact | undefined {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(filePath);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    }
    assertRealDirectory(path.dirname(filePath), 'simulated Skill artifact directory');
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Unsafe simulated Skill artifact: ${filePath}`);
    }
    if (stat.size > MAX_ARTIFACT_BYTES) {
      throw new Error(`Simulated Skill artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    const artifact = parseArtifact(parsed, expectedRef);
    if (!artifact) throw new Error(`Invalid simulated Skill artifact: ${filePath}`);
    return artifact;
  }

  private filePath(ref: BotSkillRef): string {
    return path.join(this.root, `${sha256(`${ref.skillId}\0${ref.version}`)}.json`);
  }
}

function collectArtifactFiles(skillDir: string): SimulatedSkillArtifactFile[] {
  assertRealDirectory(skillDir, 'Skill artifact source');
  const paths: string[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw new Error(`Skill artifact source contains a link: ${fullPath}`);
      if (stat.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) visit(fullPath);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Skill artifact source contains a non-file: ${fullPath}`);
      if (!SKIP_FILES.has(entry.name)) paths.push(fullPath);
    }
  };
  visit(skillDir);
  if (paths.length === 0 || paths.length > MAX_FILES) {
    throw new Error(`Skill artifact file count is invalid: ${paths.length}`);
  }
  let total = 0;
  const seen = new Set<string>();
  const files = paths.map(filePath => {
    let relative = normalizeRelativePath(path.relative(skillDir, filePath));
    if (relative === 'SKILL.md.disabled') relative = 'SKILL.md';
    assertPortableArtifactPath(relative);
    const portable = portablePath(relative);
    if (seen.has(portable)) throw new Error(`Duplicate portable artifact path: ${relative}`);
    seen.add(portable);
    const before = fs.lstatSync(filePath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES) {
      throw new Error(`Skill artifact file is invalid or too large: ${relative}`);
    }
    const content = fs.readFileSync(filePath);
    const after = fs.lstatSync(filePath);
    if (
      !after.isFile()
      || after.isSymbolicLink()
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ino !== after.ino
    ) {
      throw new Error(`Skill changed while creating its artifact: ${relative}`);
    }
    total += content.length;
    if (total > MAX_TOTAL_FILE_BYTES) throw new Error('Skill artifact decoded size exceeds the limit');
    return {
      path: relative,
      size: content.length,
      sha256: sha256(content),
      contentBase64: content.toString('base64'),
    };
  });
  return files.sort((left, right) => compareUtf8(left.path, right.path));
}

function parseArtifact(value: unknown, expectedRef: BotSkillRef): SimulatedSkillArtifact | undefined {
  const raw = value as Partial<SimulatedSkillArtifact> | null;
  try {
    if (
      raw?.schema !== SIMULATED_SKILL_ARTIFACT_SCHEMA
      || !raw.ref
      || !Array.isArray(raw.files)
      || raw.files.length === 0
      || raw.files.length > MAX_FILES
      || (raw.storage !== 'skillhub-mirror' && raw.storage !== 'simulated-private')
    ) return undefined;
    const ref = normalizeRef(raw.ref);
    if (ref.skillId !== expectedRef.skillId || ref.version !== expectedRef.version) return undefined;
    const botId = required(raw.botId, 'botId');
    const localSkillId = required(raw.localSkillId, 'localSkillId');
    const name = required(raw.name, 'name').normalize('NFC');
    const installName = normalizeInstallName(raw.installName);
    const contentHash = requiredHash(raw.contentHash, 'contentHash');
    let total = 0;
    const seen = new Set<string>();
    const files = raw.files.map(file => {
      const relative = normalizeRelativePath(file?.path);
      assertPortableArtifactPath(relative);
      const key = portablePath(relative);
      if (seen.has(key)) throw new Error(`Duplicate artifact path: ${relative}`);
      seen.add(key);
      if (
        !Number.isSafeInteger(file?.size)
        || Number(file.size) < 0
        || Number(file.size) > MAX_FILE_BYTES
        || typeof file?.contentBase64 !== 'string'
      ) throw new Error(`Invalid artifact file metadata: ${relative}`);
      const content = Buffer.from(file.contentBase64, 'base64');
      if (
        content.toString('base64') !== file.contentBase64
        || content.length !== file.size
        || sha256(content) !== requiredHash(file.sha256, 'file.sha256')
      ) throw new Error(`Invalid artifact file content: ${relative}`);
      total += content.length;
      if (total > MAX_TOTAL_FILE_BYTES) throw new Error('Artifact decoded size exceeds the limit');
      return {
        path: relative,
        size: content.length,
        sha256: sha256(content),
        contentBase64: file.contentBase64,
      };
    }).sort((left, right) => compareUtf8(left.path, right.path));
    if (!files.some(file => file.path === 'SKILL.md')) return undefined;
    const installMarker = raw.installMarker;
    if (
      raw.storage === 'skillhub-mirror'
      && (
        !isValidInstallMarker(installMarker)
        || installMarker.skillId !== ref.skillId
        || installMarker.version !== ref.version
        || installMarker.installName !== installName
      )
    ) return undefined;
    if (raw.storage === 'simulated-private' && installMarker) return undefined;
    const artifactDigest = digest({
      botId,
      localSkillId,
      storage: raw.storage,
      name,
      installName,
      contentHash,
      files: files.map(file => ({
        path: file.path,
        size: file.size,
        sha256: file.sha256,
      })),
      ...(installMarker ? { installMarker } : {}),
    });
    if (artifactDigest !== requiredHash(raw.artifactDigest, 'artifactDigest')) return undefined;
    return {
      schema: SIMULATED_SKILL_ARTIFACT_SCHEMA,
      botId,
      localSkillId,
      ref,
      storage: raw.storage,
      name,
      installName,
      contentHash,
      artifactDigest,
      files,
      ...(installMarker ? { installMarker } : {}),
    };
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(root: string, filePath: string, value: unknown): void {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ARTIFACT_BYTES) {
    throw new Error(`Simulated Skill artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  }
  ensureSafeDirectory(root, path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function ensureSafeDirectory(rootPath: string, targetPath: string): void {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  assertContained(root, target, 'artifact directory');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  assertRealDirectory(root, 'artifact root');
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    assertRealDirectory(current, 'artifact directory');
  }
}

function ensureMaterializeDirectory(rootPath: string, targetPath: string): void {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  assertContained(root, target, 'artifact output directory');
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    assertRealDirectory(current, 'artifact output directory');
  }
}

function assertRealDirectory(directory: string, label: string): void {
  const stat = fs.lstatSync(directory);
  const resolved = path.resolve(directory);
  const real = fs.realpathSync.native(directory);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || !samePath(resolved, real)
  ) throw new Error(`Unsafe ${label}: ${directory}`);
}

function assertPortableArtifactPath(relative: string): void {
  if (relative.length > MAX_PATH_LENGTH || relative.split('/').length > MAX_PATH_DEPTH) {
    throw new Error(`Artifact path exceeds limits: ${relative}`);
  }
  for (const segment of relative.split('/')) {
    const normalized = segment.normalize('NFC');
    if (
      /[<>:"|?*\u0000-\u001f]/u.test(normalized)
      || /[ .]$/u.test(normalized)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(normalized)
    ) {
      throw new Error(`Artifact path is not portable: ${relative}`);
    }
  }
}

function portablePath(relative: string): string {
  return relative.normalize('NFC').toLocaleLowerCase('en-US');
}

function normalizeRef(ref: BotSkillRef): BotSkillRef {
  return {
    skillId: required(ref?.skillId, 'skillId'),
    version: required(ref?.version, 'version'),
  };
}

function isValidInstallMarker(
  value: SkillHubPackageInstallMarker | undefined,
): value is SkillHubPackageInstallMarker {
  if (!value || value.source !== 'skillhub') return false;
  try {
    required(value.skillId, 'marker.skillId');
    required(value.name, 'marker.name');
    normalizeInstallName(value.installName);
    required(value.version, 'marker.version');
    requiredHash(value.packageChecksumSha256, 'marker.packageChecksumSha256');
    if (value.installedContentHash) {
      requiredHash(value.installedContentHash, 'marker.installedContentHash');
    }
    required(value.packageUrl, 'marker.packageUrl');
    new Date(required(value.installedAt, 'marker.installedAt')).toISOString();
    if (
      value.signature?.algorithm !== 'ed25519'
      || !required(value.signature.keyId, 'marker.signature.keyId')
      || !required(value.signature.signature, 'marker.signature.signature')
    ) return false;
    new Date(required(value.signature.signedAt, 'marker.signature.signedAt')).toISOString();
    return true;
  } catch {
    return false;
  }
}

function canonicalPublicInstallMarker(
  marker: SkillHubPackageInstallMarker,
): SkillHubPackageInstallMarker {
  const signedAt = new Date(
    required(marker.signature.signedAt, 'marker.signature.signedAt'),
  ).toISOString();
  return {
    source: 'skillhub',
    skillId: required(marker.skillId, 'marker.skillId'),
    name: required(marker.name, 'marker.name').normalize('NFC'),
    installName: normalizeInstallName(marker.installName),
    version: required(marker.version, 'marker.version'),
    packageChecksumSha256: requiredHash(
      marker.packageChecksumSha256,
      'marker.packageChecksumSha256',
    ),
    ...(marker.installedContentHash
      ? {
        installedContentHash: requiredHash(
          marker.installedContentHash,
          'marker.installedContentHash',
        ),
      }
      : {}),
    signature: {
      algorithm: 'ed25519',
      keyId: required(marker.signature.keyId, 'marker.signature.keyId'),
      signature: required(marker.signature.signature, 'marker.signature.signature'),
      signedAt,
    },
    // Public artifacts represent package identity, not a particular user's install session.
    packageUrl: `skillhub:${marker.skillId}@${marker.version}`,
    installedAt: signedAt,
  };
}

function normalizeInstallName(value: unknown): string {
  const name = required(value, 'installName').normalize('NFC');
  if (name !== path.posix.basename(name) || name === '.' || name === '..') {
    throw new Error(`Invalid installName: ${name}`);
  }
  assertPortableArtifactPath(name);
  return name;
}

function normalizeRelativePath(value: unknown): string {
  const relative = required(value, 'path').replace(/\\/g, '/').normalize('NFC');
  if (
    path.posix.isAbsolute(relative)
    || relative === '.'
    || relative.split('/').some(segment => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Invalid relative path: ${relative}`);
  }
  return relative;
}

function required(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 1024) throw new Error(`${field} is required or too long`);
  return text;
}

function requiredHash(value: unknown, field: string): string {
  const text = required(value, field).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${field} must be SHA-256`);
  return text;
}

function digest(value: unknown): string {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function assertContained(root: string, target: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its root`);
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}
