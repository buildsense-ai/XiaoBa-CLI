import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  BOT_SKILL_LOCAL_MARKER_FILE,
  collectBotSkillPackageFiles,
  computeBotSkillPackageHash,
  isPortablePackagePath,
  readBotSkillLocalMarker,
  scanLocalBotSkill,
  writeBotSkillLocalMarker,
} from './local-manifest';
import type { BotSkillLocalMarker, LocalBotSkillManifestEntry } from './types';
import { renameBotSkillWorkspaceSync } from './workspace-fs';

const CANDIDATE_SCHEMA = 'xiaoba.bot-skill-candidate.v1';
const CANDIDATE_FILE = 'candidate.json';
const PACKAGE_DIRECTORY = 'package';
const SCOPED_ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,159}$/;

export interface CreateBotSkillCandidateOptions {
  runtimeRoot: string;
  botId: string;
  mutationId: string;
  sourceSkillPath: string;
  installName?: string;
  now?: () => Date;
}

export interface BotSkillCandidateManifest {
  schema: typeof CANDIDATE_SCHEMA;
  botId: string;
  mutationId: string;
  state: 'prepared';
  localSkillId: string;
  installName: string;
  contentHash: string;
  markerHash: string;
  fileCount: number;
  createdAt: string;
}

export interface BotSkillCandidate {
  path: string;
  packagePath: string;
  manifest: BotSkillCandidateManifest;
  skill: LocalBotSkillManifestEntry;
  deduplicated: boolean;
}

export interface BotSkillCandidateRecoveryEntry {
  path: string;
  mutationId?: string;
  status: 'ready' | 'incomplete' | 'invalid';
  candidate?: BotSkillCandidate;
  error?: string;
}

/**
 * Creates an isolated copy of one Skill for a future mutation workflow.
 *
 * This module is deliberately not registered with the model, Runtime startup,
 * BotDefinition activation, or the existing file/Shell tools. Candidate files
 * therefore cannot affect the active Skill workspace until a later, explicit
 * and separately reviewed promotion workflow is introduced.
 */
export function createBotSkillCandidate(
  options: CreateBotSkillCandidateOptions,
): BotSkillCandidate {
  const runtimeRoot = requireSafeDirectory(options.runtimeRoot, 'Runtime root');
  const botId = normalizeScopedId(options.botId, 'Bot ID');
  const mutationId = normalizeScopedId(options.mutationId, 'mutation ID');
  const sourceSkillPath = requireSafeDirectory(options.sourceSkillPath, 'source Skill');
  assertSafeTree(sourceSkillPath, 'source Skill');
  const skillFile = path.join(sourceSkillPath, 'SKILL.md');
  if (!fs.existsSync(skillFile) || !fs.lstatSync(skillFile).isFile()) {
    throw new Error('Bot Skill candidate source is missing a safe SKILL.md.');
  }

  const files = collectBotSkillPackageFiles(sourceSkillPath);
  if (!files.some(file => file.path === 'SKILL.md')) {
    throw new Error('Bot Skill candidate source is missing SKILL.md.');
  }
  const contentHash = computeBotSkillPackageHash(files);
  const installName = normalizeInstallName(options.installName ?? path.basename(sourceSkillPath));
  const sourceMarker = readBotSkillLocalMarker(sourceSkillPath);
  if (!sourceMarker && fs.existsSync(path.join(sourceSkillPath, BOT_SKILL_LOCAL_MARKER_FILE))) {
    throw new Error('Source Skill local marker cannot be read safely.');
  }
  if (sourceMarker && !validLocalSkillId(sourceMarker.localSkillId)) {
    throw new Error('Source Skill has an invalid local Skill ID for candidate workspace.');
  }
  const candidatesRoot = ensureCandidateRoot(runtimeRoot);
  const botRoot = ensureSafeChildDirectory(candidatesRoot, botId);
  const finalPath = path.join(botRoot, mutationId);

  if (fs.existsSync(finalPath)) {
    return assertExistingCandidateMatches(
      finalPath,
      botId,
      mutationId,
      installName,
      contentHash,
      sourceMarker?.localSkillId,
    );
  }

  const localSkillId = sourceMarker?.localSkillId ?? crypto.randomUUID();
  if (!validLocalSkillId(localSkillId)) {
    throw new Error('Source Skill has an invalid local Skill ID for candidate workspace.');
  }
  const marker: BotSkillLocalMarker = {
    schema: 'xiaoba.bot-skill-local.v1',
    localSkillId,
    ...(sourceMarker?.reference?.contentHash === contentHash
      ? { reference: sourceMarker.reference }
      : {}),
    ...(sourceMarker?.origin ? { origin: sourceMarker.origin } : {}),
  };
  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  const manifest: BotSkillCandidateManifest = {
    schema: CANDIDATE_SCHEMA,
    botId,
    mutationId,
    state: 'prepared',
    localSkillId,
    installName,
    contentHash,
    markerHash: hashMarker(marker),
    fileCount: files.length,
    createdAt,
  };
  const temporary = path.join(
    botRoot,
    `.tmp-${mutationId}-${process.pid}-${crypto.randomBytes(8).toString('hex')}`,
  );
  const packagePath = path.join(temporary, PACKAGE_DIRECTORY, ...installName.split('/'));

  fs.mkdirSync(packagePath, { recursive: true });
  try {
    for (const file of files) {
      const target = path.join(packagePath, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const bytes = Buffer.from(file.contentBase64, 'base64');
      fs.writeFileSync(target, bytes, { flag: 'wx' });
    }
    writeBotSkillLocalMarker(packagePath, marker);
    const copied = scanLocalBotSkill(packagePath, path.join(temporary, PACKAGE_DIRECTORY));
    if (
      copied.contentHash !== contentHash
      || copied.localSkillId !== localSkillId
      || copied.installName !== installName
      || copied.files.length !== files.length
    ) {
      throw new Error('Bot Skill candidate verification failed before activation.');
    }
    fs.writeFileSync(
      path.join(temporary, CANDIDATE_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    renameBotSkillWorkspaceSync(temporary, finalPath);
    return inspectBotSkillCandidate({ runtimeRoot, botId, mutationId, deduplicated: false });
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
    if (fs.existsSync(finalPath)) {
      return assertExistingCandidateMatches(
        finalPath,
        botId,
        mutationId,
        installName,
        contentHash,
        sourceMarker?.localSkillId,
      );
    }
    throw error;
  }
}

export function inspectBotSkillCandidate(options: {
  runtimeRoot: string;
  botId: string;
  mutationId: string;
  deduplicated?: boolean;
}): BotSkillCandidate {
  const runtimeRoot = requireSafeDirectory(options.runtimeRoot, 'Runtime root');
  const botId = normalizeScopedId(options.botId, 'Bot ID');
  const mutationId = normalizeScopedId(options.mutationId, 'mutation ID');
  const botRoot = requireCandidateBotRoot(runtimeRoot, botId);
  const candidatePath = path.join(botRoot, mutationId);
  const safeCandidatePath = requireSafeDirectory(candidatePath, 'Bot Skill candidate');
  assertSafeTree(safeCandidatePath, 'Bot Skill candidate');
  const manifest = readCandidateManifest(safeCandidatePath, botId, mutationId);
  const packagePath = path.join(
    safeCandidatePath,
    PACKAGE_DIRECTORY,
    ...manifest.installName.split('/'),
  );
  const marker = readBotSkillLocalMarker(packagePath);
  if (!marker) {
    throw new Error('Bot Skill candidate marker cannot be read safely.');
  }
  const skill = scanLocalBotSkill(packagePath, path.join(safeCandidatePath, PACKAGE_DIRECTORY));
  if (
    skill.localSkillId !== manifest.localSkillId
    || skill.installName !== manifest.installName
    || skill.contentHash !== manifest.contentHash
    || hashMarker(marker) !== manifest.markerHash
    || skill.files.length !== manifest.fileCount
  ) {
    throw new Error('Bot Skill candidate no longer matches its verified manifest.');
  }
  return {
    path: safeCandidatePath,
    packagePath,
    manifest,
    skill,
    deduplicated: options.deduplicated ?? false,
  };
}

/** Reports interrupted/invalid candidates without deleting evidence. */
export function recoverBotSkillCandidates(
  runtimeRootValue: string,
  botIdValue: string,
): BotSkillCandidateRecoveryEntry[] {
  const runtimeRoot = requireSafeDirectory(runtimeRootValue, 'Runtime root');
  const botId = normalizeScopedId(botIdValue, 'Bot ID');
  const botRoot = candidatePathFor(runtimeRoot, botId);
  if (!fs.existsSync(botRoot)) return [];
  requireCandidateBotRoot(runtimeRoot, botId);

  return fs.readdirSync(botRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .sort((left, right) => compareText(left.name, right.name))
    .map(entry => {
      const entryPath = path.join(botRoot, entry.name);
      if (entry.isSymbolicLink()) {
        return { path: entryPath, status: 'invalid', error: 'Candidate entry is a symbolic link.' };
      }
      if (entry.name.startsWith('.tmp-')) {
        return { path: entryPath, status: 'incomplete' };
      }
      try {
        const mutationId = normalizeScopedId(entry.name, 'mutation ID');
        const candidate = inspectBotSkillCandidate({ runtimeRoot, botId, mutationId });
        return { path: entryPath, mutationId, status: 'ready', candidate };
      } catch (error) {
        return {
          path: entryPath,
          mutationId: entry.name,
          status: 'invalid',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
}

/** Removes only one fully verified candidate. Invalid evidence is preserved. */
export function discardBotSkillCandidate(options: {
  runtimeRoot: string;
  botId: string;
  mutationId: string;
}): boolean {
  const runtimeRoot = requireSafeDirectory(options.runtimeRoot, 'Runtime root');
  const botId = normalizeScopedId(options.botId, 'Bot ID');
  const mutationId = normalizeScopedId(options.mutationId, 'mutation ID');
  const botRoot = candidatePathFor(runtimeRoot, botId);
  if (!fs.existsSync(botRoot)) return false;
  requireCandidateBotRoot(runtimeRoot, botId);
  const candidatePath = path.join(botRoot, mutationId);
  if (!fs.existsSync(candidatePath)) return false;
  inspectBotSkillCandidate({ runtimeRoot, botId, mutationId });
  fs.rmSync(candidatePath, { recursive: true, force: false });
  return true;
}

function assertExistingCandidateMatches(
  candidatePath: string,
  botId: string,
  mutationId: string,
  installName: string,
  contentHash: string,
  expectedLocalSkillId?: string,
): BotSkillCandidate {
  const runtimeRoot = runtimeRootFromCandidatePath(candidatePath);
  const existing = inspectBotSkillCandidate({
    runtimeRoot,
    botId,
    mutationId,
    deduplicated: true,
  });
  if (
    existing.manifest.installName !== installName
    || existing.manifest.contentHash !== contentHash
    || (expectedLocalSkillId !== undefined
      && existing.manifest.localSkillId !== expectedLocalSkillId)
  ) {
    throw new Error('Bot Skill candidate mutation ID already exists with different content.');
  }
  return existing;
}

function readCandidateManifest(
  candidatePath: string,
  botId: string,
  mutationId: string,
): BotSkillCandidateManifest {
  const manifestPath = path.join(candidatePath, CANDIDATE_FILE);
  let value: Partial<BotSkillCandidateManifest>;
  try {
    value = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<BotSkillCandidateManifest>;
  } catch {
    throw new Error('Bot Skill candidate manifest cannot be read safely.');
  }
  if (
    value.schema !== CANDIDATE_SCHEMA
    || value.botId !== botId
    || value.mutationId !== mutationId
    || value.state !== 'prepared'
    || !validLocalSkillId(value.localSkillId)
    || normalizeInstallName(value.installName) !== value.installName
    || !/^[a-f0-9]{64}$/.test(String(value.contentHash || ''))
    || !/^[a-f0-9]{64}$/.test(String(value.markerHash || ''))
    || !Number.isInteger(value.fileCount)
    || Number(value.fileCount) <= 0
    || !validIsoDate(value.createdAt)
  ) {
    throw new Error('Bot Skill candidate manifest is invalid.');
  }
  return value as BotSkillCandidateManifest;
}

function ensureCandidateRoot(runtimeRoot: string): string {
  let current = runtimeRoot;
  for (const segment of ['data', 'bot-skills', 'candidates']) {
    current = ensureSafeChildDirectory(current, segment);
  }
  return current;
}

function ensureSafeChildDirectory(parent: string, name: string): string {
  const child = path.join(parent, name);
  if (!fs.existsSync(child)) {
    try {
      fs.mkdirSync(child, { recursive: false });
    } catch (error: any) {
      // A second Runtime process may have created the same safe scope first.
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  return requireSafeDirectory(child, 'Bot Skill candidate directory');
}

function requireCandidateBotRoot(runtimeRoot: string, botId: string): string {
  let current = runtimeRoot;
  for (const segment of ['data', 'bot-skills', 'candidates', botId]) {
    current = path.join(current, segment);
    requireSafeDirectory(current, 'Bot Skill candidate directory');
  }
  return current;
}

function candidatePathFor(runtimeRoot: string, botId: string, mutationId?: string): string {
  return path.join(
    runtimeRoot,
    'data',
    'bot-skills',
    'candidates',
    botId,
    ...(mutationId ? [mutationId] : []),
  );
}

function runtimeRootFromCandidatePath(candidatePath: string): string {
  return path.resolve(candidatePath, '..', '..', '..', '..', '..');
}

function requireSafeDirectory(value: string, label: string): string {
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} is not a safe directory: ${resolved}`);
  }
  return resolved;
}

function assertSafeTree(root: string, label: string): void {
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`${label} contains a symbolic link: ${entry.name}`);
      if (stat.isDirectory()) visit(absolute);
      else if (!stat.isFile()) throw new Error(`${label} contains an unsupported filesystem entry.`);
    }
  };
  visit(root);
}

function normalizeScopedId(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (
    !SCOPED_ID_PATTERN.test(normalized)
    || normalized === '.'
    || normalized === '..'
    || !isPortablePackagePath(normalized)
  ) {
    throw new Error(`Invalid ${label} for Bot Skill candidate workspace.`);
  }
  return normalized;
}

function normalizeInstallName(value: string | undefined): string {
  const normalized = String(value || '').replace(/\\/g, '/').trim();
  if (!isPortablePackagePath(normalized)) {
    throw new Error('Invalid install name for Bot Skill candidate workspace.');
  }
  return normalized;
}

function validLocalSkillId(value: unknown): boolean {
  return /^[A-Za-z0-9._:-]{1,200}$/.test(String(value || ''));
}

function validIsoDate(value: unknown): boolean {
  const text = String(value || '');
  try {
    return Boolean(text && new Date(text).toISOString() === text);
  } catch {
    return false;
  }
}

function hashMarker(marker: BotSkillLocalMarker): string {
  const normalized: BotSkillLocalMarker = {
    schema: 'xiaoba.bot-skill-local.v1',
    localSkillId: marker.localSkillId,
    ...(marker.reference ? { reference: marker.reference } : {}),
    ...(marker.origin ? { origin: marker.origin } : {}),
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
