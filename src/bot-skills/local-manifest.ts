import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { readSkillHubInstallMarker } from '../skillhub/install-marker';
import type { BotSkillRef } from '../bot-definition/types';
import { canonicalizeBotSkillRefs } from './canonical';
import type {
  BotSkillLocalMarker,
  BotSkillPackageFile,
  LocalBotSkillManifestEntry,
  SkillHubPackageRef,
} from './types';

export const BOT_SKILL_LOCAL_MARKER_FILE = '.xiaoba-bot-skill.json';

export class BotSkillPackageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BotSkillPackageValidationError';
  }
}

const BOT_SKILL_LOCAL_MARKER_SCHEMA = 'xiaoba.bot-skill-local.v1';
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules']);
const SKIP_FILES = new Set([
  BOT_SKILL_LOCAL_MARKER_FILE,
  '.xiaoba-skillhub-install.json',
  '.xiaoba-bundled-skill.json',
  'skill.json',
  'REVIEW.json',
  'SBOM.json',
]);
const MAX_FILES = 200;
const MAX_SINGLE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
// The legacy content scanner is intentionally retained below as a reusable
// detector, but package collection no longer calls it. SkillHub publication is
// content-agnostic; only package structure and transport limits are enforced.
const MAX_CREDENTIAL_ASSIGNMENTS = 512;
const MAX_CREDENTIAL_EXPRESSION_CHARS = 16 * 1024;
const ARCHIVE_FILE_EXTENSIONS = [
  '.7z', '.a', '.apk', '.ar', '.bz2', '.cab', '.cpio', '.deb', '.dmg', '.gz',
  '.img', '.iso', '.jar', '.lz', '.lz4', '.lzma', '.rar', '.rpm', '.tar',
  '.tbz', '.tbz2', '.tgz', '.txz', '.war', '.whl', '.xz', '.zip', '.zst',
] as const;
const EXPLICIT_SAFE_CREDENTIAL_VALUES = new Set([
  'catsco-bot-key',
  'catsco-fallback-user',
  'catsco-stale-bot-key',
  'catsco-user-login',
  'catsco-user-token',
  'reference-smoke-secret',
  'smoke-key',
  'smoke-secret',
]);
const CREDENTIAL_EXPRESSION_CONTINUATION_TOKENS = new Set([
  '\\', '||', '??', '&&', '=', '==', '===', '!=', '!==', '=>', '<=', '>=',
  '?', ':', '+', '-', '*', '/', '%', '&', '|', '^', '~', '.', '?.', '<', '>',
  '(', '[', '!', 'as', 'satisfies', 'instanceof', 'in',
]);

export interface BotSkillWorkspaceValidationFailure {
  localSkillId: string;
  name: string;
  installName: string;
  path: string;
  error: BotSkillPackageValidationError;
}

export interface ScanBotSkillWorkspaceOptions {
  onValidationFailure?: (failure: BotSkillWorkspaceValidationFailure) => void;
}

export function scanBotSkillWorkspace(
  skillsRoot: string,
  options: ScanBotSkillWorkspaceOptions = {},
): LocalBotSkillManifestEntry[] {
  const root = path.resolve(skillsRoot);
  if (!fs.existsSync(root)) {
    throw new Error(`Bot Skill workspace does not exist: ${root}`);
  }
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Bot Skill workspace is not a safe directory: ${root}`);
  }
  const realRoot = fs.realpathSync(root);

  const entries: LocalBotSkillManifestEntry[] = [];
  const localSkillIds = new Set<string>();
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const skillDir = path.join(current, entry.name);
      assertRealPathContained(realRoot, skillDir);
      if (fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
        let manifestEntry: LocalBotSkillManifestEntry;
        try {
          manifestEntry = scanLocalBotSkill(skillDir, root);
        } catch (error) {
          if (!(error instanceof BotSkillPackageValidationError) || !options.onValidationFailure) {
            throw error;
          }
          const marker = readBotSkillLocalMarker(skillDir);
          if (!marker) throw error;
          const name = readLocalSkillNameForValidationFailure(skillDir);
          if (localSkillIds.has(marker.localSkillId)) {
            throw new Error(`Bot Skill workspace contains a duplicate localSkillId: ${marker.localSkillId}`);
          }
          localSkillIds.add(marker.localSkillId);
          options.onValidationFailure({
            localSkillId: marker.localSkillId,
            name,
            installName: path.relative(root, skillDir).replace(/\\/g, '/'),
            path: skillDir,
            error,
          });
          if (!SKIP_DIRECTORIES.has(entry.name)) visit(skillDir);
          continue;
        }
        if (localSkillIds.has(manifestEntry.localSkillId)) {
          throw new Error(`Bot Skill workspace contains a duplicate localSkillId: ${manifestEntry.localSkillId}`);
        }
        localSkillIds.add(manifestEntry.localSkillId);
        entries.push(manifestEntry);
      }
      if (!SKIP_DIRECTORIES.has(entry.name)) visit(skillDir);
    }
  };
  visit(root);
  return entries.sort((left, right) => compareText(left.localSkillId, right.localSkillId));
}

export function scanLocalBotSkill(
  skillDir: string,
  workspaceRoot?: string,
): LocalBotSkillManifestEntry {
  const root = path.resolve(skillDir);
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Skill path is not a safe directory: ${root}`);
  }
  const skillFile = path.join(root, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    throw new Error(`Skill is missing SKILL.md: ${root}`);
  }
  const skillStat = fs.lstatSync(skillFile);
  if (skillStat.isSymbolicLink() || !skillStat.isFile()) {
    throw new Error(`Skill has an unsafe SKILL.md: ${root}`);
  }
  assertRealPathContained(fs.realpathSync(root), skillFile);
  const marker = ensureBotSkillLocalMarker(root);
  const files = collectBotSkillPackageFiles(root);
  const contentHash = computeBotSkillPackageHash(files);
  const reference = marker.reference?.contentHash === contentHash
    ? marker.reference
    : undefined;
  const name = readLocalSkillName(root);
  return {
    localSkillId: marker.localSkillId,
    name,
    installName: workspaceRoot
      ? path.relative(path.resolve(workspaceRoot), root).replace(/\\/g, '/')
      : path.basename(root),
    path: root,
    contentHash,
    files,
    ...(reference ? { reference } : {}),
    ...(marker.origin ? { origin: marker.origin } : {}),
  };
}

function readLocalSkillName(skillDir: string): string {
  const fallback = path.basename(skillDir);
  try {
    const parsed = matter(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), {});
    return String(parsed.data?.name || fallback).trim() || fallback;
  } catch {
    throw new BotSkillPackageValidationError(
      'SKILL.md format is invalid. Check its YAML frontmatter and try again.',
    );
  }
}

function readLocalSkillNameForValidationFailure(skillDir: string): string {
  try {
    return readLocalSkillName(skillDir);
  } catch (error) {
    if (!(error instanceof BotSkillPackageValidationError)) throw error;
    return path.basename(skillDir);
  }
}

export function readBotSkillLocalMarker(skillDir: string): BotSkillLocalMarker | undefined {
  const markerPath = path.join(skillDir, BOT_SKILL_LOCAL_MARKER_FILE);
  if (!fs.existsSync(markerPath)) return undefined;
  try {
    const value = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as BotSkillLocalMarker;
    if (
      value?.schema !== BOT_SKILL_LOCAL_MARKER_SCHEMA
      || !/^[A-Za-z0-9._:-]+$/.test(String(value.localSkillId || ''))
      || (value.reference && !validRef(value.reference))
      || (value.origin && !validPackageRef(value.origin))
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

export function writeBotSkillLocalMarker(skillDir: string, marker: BotSkillLocalMarker): void {
  if (
    marker.schema !== BOT_SKILL_LOCAL_MARKER_SCHEMA
    || !/^[A-Za-z0-9._:-]+$/.test(marker.localSkillId)
    || (marker.reference && !validRef(marker.reference))
    || (marker.origin && !validPackageRef(marker.origin))
  ) {
    throw new Error('Bot Skill local marker is invalid');
  }
  fs.mkdirSync(skillDir, { recursive: true });
  const markerPath = path.join(skillDir, BOT_SKILL_LOCAL_MARKER_FILE);
  const temporary = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, markerPath);
}

export function computeBotSkillPackageHash(files: readonly BotSkillPackageFile[]): string {
  const entries = [...files]
    .map(file => ({ path: file.path, size: file.size, sha256: file.sha256 }))
    .sort((left, right) => compareText(left.path, right.path));
  return sha256(Buffer.from(JSON.stringify(entries), 'utf8'));
}

function ensureBotSkillLocalMarker(skillDir: string): BotSkillLocalMarker {
  const existing = readBotSkillLocalMarker(skillDir);
  if (existing) return existing;
  if (fs.existsSync(path.join(skillDir, BOT_SKILL_LOCAL_MARKER_FILE))) {
    throw new Error(`Bot Skill local marker cannot be read safely: ${skillDir}`);
  }
  const installed = readSkillHubInstallMarker(skillDir);
  const origin = installed
    ? { skillId: installed.skillId, version: installed.version }
    : undefined;
  const marker: BotSkillLocalMarker = {
    schema: BOT_SKILL_LOCAL_MARKER_SCHEMA,
    localSkillId: crypto.randomUUID(),
    ...(origin ? { origin } : {}),
  };
  writeBotSkillLocalMarker(skillDir, marker);
  return marker;
}

export function collectBotSkillPackageFiles(root: string): BotSkillPackageFile[] {
  const realRoot = fs.realpathSync(root);
  const files: BotSkillPackageFile[] = [];
  let totalBytes = 0;
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(current, entry.name);
      const entryStat = fs.lstatSync(fullPath);
      if (entryStat.isSymbolicLink()) continue;
      assertRealPathContained(realRoot, fullPath);
      if (entry.isDirectory()) {
        if (
          !SKIP_DIRECTORIES.has(entry.name)
          && !fs.existsSync(path.join(fullPath, 'SKILL.md'))
        ) {
          visit(fullPath);
        }
        continue;
      }
      if (!entry.isFile() || SKIP_FILES.has(entry.name)) continue;
      const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');
      if (!isPortablePackagePath(relativePath)) {
        throw new BotSkillPackageValidationError(`Skill contains an unsafe path: ${relativePath}`);
      }
      const bytes = fs.readFileSync(fullPath);
      if (bytes.length > MAX_SINGLE_FILE_BYTES) {
        throw new BotSkillPackageValidationError(`Skill file is too large: ${relativePath}`);
      }
      totalBytes += bytes.length;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new BotSkillPackageValidationError('Skill package is too large');
      }
      files.push({
        path: relativePath,
        size: bytes.length,
        sha256: sha256(bytes),
        contentBase64: bytes.toString('base64'),
      });
      if (files.length > MAX_FILES) {
        throw new BotSkillPackageValidationError('Skill package contains too many files');
      }
    }
  };
  visit(root);
  return files.sort((left, right) => compareText(left.path, right.path));
}

function rejectSensitiveMaterial(filePath: string, bytes: Buffer): void {
  const name = path.posix.basename(filePath).toLowerCase();
  if (isArchiveFile(name, bytes)) {
    throw new BotSkillPackageValidationError(
      `Skill contains an archive file and cannot be uploaded automatically: ${filePath}`,
    );
  }
  if (
    name === '.env'
    || name.startsWith('.env.')
    || ['.npmrc', '.pypirc', 'credentials', 'credentials.json', 'kubeconfig', 'id_rsa', 'id_ed25519'].includes(name)
    || /\.(?:pem|key|p12|pfx)$/i.test(name)
    || /\.(?:exe|dll|so|dylib|msi|apk|appimage)$/i.test(name)
    || containsHighConfidenceSecret(filePath, bytes)
  ) {
    throw new BotSkillPackageValidationError(
      `Skill contains sensitive material and cannot be uploaded: ${filePath}`,
    );
  }
}

function isArchiveFile(name: string, bytes: Buffer): boolean {
  if (ARCHIVE_FILE_EXTENSIONS.some(extension => name.endsWith(extension))) return true;
  if (
    hasMagic(bytes, [0x50, 0x4b, 0x03, 0x04])
    || hasMagic(bytes, [0x50, 0x4b, 0x05, 0x06])
    || hasMagic(bytes, [0x50, 0x4b, 0x07, 0x08])
    || hasMagic(bytes, [0x1f, 0x8b])
    || hasMagic(bytes, [0x42, 0x5a, 0x68])
    || hasMagic(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])
    || hasMagic(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])
    || hasMagic(bytes, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])
    || hasMagic(bytes, [0x28, 0xb5, 0x2f, 0xfd])
    || hasMagic(bytes, [0x4d, 0x53, 0x43, 0x46])
    || bytes.subarray(0, 8).toString('ascii') === '!<arch>\n'
    || /^(?:070701|070702|070707)$/.test(bytes.subarray(0, 6).toString('ascii'))
  ) {
    return true;
  }
  return bytes.length >= 262 && bytes.subarray(257, 262).toString('ascii') === 'ustar';
}

function hasMagic(bytes: Buffer, magic: readonly number[]): boolean {
  return bytes.length >= magic.length && magic.every((value, index) => bytes[index] === value);
}

function containsHighConfidenceSecret(filePath: string, bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  const text = bytes.toString('utf8');
  if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(text)) return true;
  if (/\bAKIA[0-9A-Z]{16}\b/.test(text)) return true;
  if (/\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(text)) return true;
  if (/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/.test(text)) return true;
  if (/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/.test(text)) return true;
  const sourceExtension = path.posix.extname(filePath).toLowerCase();
  const isSourceCode = ['.cjs', '.js', '.jsx', '.mjs', '.py', '.ts', '.tsx'].includes(sourceExtension);
  const equalsAssignments = text.matchAll(new RegExp(
    /(?=(?:^|[^A-Za-z0-9_.'"`-])(?:[ \t\r\n]|\/\*[\s\S]*?\*\/)*(?<quote>["']?)(?<key>[A-Za-z_][A-Za-z0-9_.-]{0,127})\k<quote>\]?(?:[ \t\r\n]|\/\*[\s\S]*?\*\/)*(?:\|\|=|\?\?=|&&=|[?+]?=(?![=>]))(?:[ \t\r\n]|\/\*[\s\S]*?\*\/)*(?:"(?<double>[^"\r\n]*)"|'(?<single>[^'\r\n]*)'|(?<bare>[^\s#,;}]+)))/im.source,
    'gimd',
  ));
  if (hasSensitiveCredentialAssignment(
    equalsAssignments,
    isSourceCode,
    text,
    'equals',
    sourceExtension,
  )) return true;
  const colonAssignments = text.matchAll(new RegExp(
    /(?=(?:^|[\[,{])(?:[ \t\r\n]|\/\*[\s\S]*?\*\/)*(?:-[ \t]+)?(?<quote>["']?)(?<key>[A-Za-z_][A-Za-z0-9_.-]{0,127})\k<quote>(?:[ \t\r\n]|\/\*[\s\S]*?\*\/)*:(?:[ \t\r\n]|\/\*[\s\S]*?\*\/)*(?:"(?<double>[^"\r\n]*)"|'(?<single>[^'\r\n]*)'|(?<bare>[^\s#,;}]+)))/im.source,
    'gimd',
  ));
  if (hasSensitiveCredentialAssignment(
    colonAssignments,
    isSourceCode,
    text,
    'colon',
    sourceExtension,
  )) return true;
  const commandAssignments = text.matchAll(
    /^(?:[ \t]*[Ss][Ee][Tt][Xx](?:[ \t]+\/[A-Za-z]+)*[ \t]+(?<quote>["']?)(?<key>[A-Za-z_][A-Za-z0-9_.-]{0,127})\k<quote>[ \t]+|[ \t]*ENV[ \t]+(?<quote2>["']?)(?<key2>[A-Za-z_][A-Za-z0-9_.-]{0,127})\k<quote2>[ \t]+)(?:"(?<double>[^"\r\n]*)"|'(?<single>[^'\r\n]*)'|(?<bare>[^\s#,;}]+))/gm,
  );
  if (hasSensitiveCredentialAssignment(commandAssignments, isSourceCode)) return true;
  const quotedSetAssignments = text.matchAll(
    /^[ \t]*[Ss][Ee][Tt][ \t]+(?<outer>["']?)(?<key>[A-Za-z_][A-Za-z0-9_.-]{0,127})[ \t]*=[ \t]*(?:"(?<double>[^"\r\n]*)"|'(?<single>[^'\r\n]*)'|(?<bare>[^"'\r\n]*?))(?:\k<outer>)?[ \t]*$/gm,
  );
  return hasSensitiveCredentialAssignment(quotedSetAssignments, isSourceCode);
}

function hasSensitiveCredentialAssignment(
  assignments: Iterable<RegExpMatchArray>,
  isSourceCode: boolean,
  sourceText?: string,
  boundary?: 'equals' | 'colon',
  sourceExtension = '',
): boolean {
  let scannedAssignments = 0;
  for (const match of assignments) {
    const key = String(match.groups?.key || match.groups?.key2 || '')
      .replace(/[^A-Za-z0-9]/g, '')
      .toLowerCase();
    if (!/(?:apikey|accesstoken|authtoken|clientsecret|secretaccesskey|secretkey|password|passwd|token|secret)$/.test(key)) {
      continue;
    }
    scannedAssignments += 1;
    if (scannedAssignments > MAX_CREDENTIAL_ASSIGNMENTS) return true;
    const candidate = String(
      match.groups?.double ?? match.groups?.single ?? match.groups?.bare ?? '',
    ).toLowerCase();
    const isBare = match.groups?.bare !== undefined;
    const expression = sourceText && boundary
      ? readCredentialExpression(sourceText, match, boundary, sourceExtension)
      : undefined;
    if (sourceText && boundary && !expression) return true;
    if (
      isBare
      && isSourceCode
      && expression
      && isSafeRuntimeCredentialExpression(expression.value.toLowerCase())
    ) {
      continue;
    }
    if (
      isSourceCode
      && expression
      && isSafeTypeOnlyCredentialDeclaration(expression.value.toLowerCase())
    ) {
      continue;
    }
    if (
      !isExplicitSafeCredentialValue(key, candidate, isBare, isSourceCode)
      || !isOnlyCredentialExpressionTrivia(expression?.tail || '')
    ) {
      return true;
    }
  }
  return false;
}

type MatchIndices = Array<[number, number] | undefined> & {
  groups?: Record<string, [number, number] | undefined>;
};

function readCredentialExpression(
  source: string,
  match: RegExpMatchArray,
  boundary: 'equals' | 'colon',
  sourceExtension: string,
): { value: string; tail: string } | undefined {
  const indices = (match as RegExpMatchArray & { indices?: MatchIndices }).indices?.groups;
  const group = match.groups?.bare !== undefined
    ? 'bare'
    : match.groups?.double !== undefined
      ? 'double'
      : match.groups?.single !== undefined
        ? 'single'
        : undefined;
  const range = group ? indices?.[group] : undefined;
  if (!group || !range) return undefined;
  const quoted = group !== 'bare';
  const valueStart = Math.max(0, range[0] - (quoted ? 1 : 0));
  const tokenEnd = Math.min(source.length, range[1] + (quoted ? 1 : 0));
  const valueEnd = findCredentialExpressionEnd(
    source,
    valueStart,
    boundary,
    boundary === 'colon' || sourceExtension !== '.py',
  );
  if (valueEnd === undefined || valueEnd < tokenEnd) return undefined;
  return {
    value: source.slice(valueStart, valueEnd).trim(),
    tail: source.slice(tokenEnd, valueEnd),
  };
}

function findCredentialExpressionEnd(
  source: string,
  start: number,
  boundary: 'equals' | 'colon',
  stopAtComma: boolean,
): number | undefined {
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  let quote = '';
  let escaped = false;
  let blockComment = false;
  let lineComment = false;
  let lastToken = '';

  for (let index = start; index < source.length; index += 1) {
    if (index - start > MAX_CREDENTIAL_EXPRESSION_CHARS) return undefined;
    const char = source[index];
    const next = source[index + 1] || '';
    if (lineComment) {
      if (char !== '\n' && char !== '\r') continue;
      lineComment = false;
      if (roundDepth || squareDepth || curlyDepth || expressionContinues(lastToken, source, index)) {
        continue;
      }
      return index;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = '';
        lastToken = 'literal';
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === '\'' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') roundDepth += 1;
    else if (char === '[') squareDepth += 1;
    else if (char === '{') curlyDepth += 1;
    else if (char === ')' && roundDepth > 0) roundDepth -= 1;
    else if (char === ']' && squareDepth > 0) squareDepth -= 1;
    else if (char === '}' && curlyDepth > 0) curlyDepth -= 1;
    else if (!roundDepth && !squareDepth && !curlyDepth) {
      if (
        char === ';'
        || (stopAtComma && char === ',')
        || (boundary === 'colon' && char === '}')
      ) return index;
      if (char === '\n' || char === '\r') {
        if (expressionContinues(lastToken, source, index)) continue;
        return index;
      }
    }
    if (/\s/.test(char)) continue;
    const token = readCredentialToken(source, index);
    lastToken = token.value;
    index = token.end - 1;
  }
  return source.length - start <= MAX_CREDENTIAL_EXPRESSION_CHARS
    ? source.length
    : undefined;
}

function expressionContinues(lastToken: string, source: string, lineEnd: number): boolean {
  if (isCredentialContinuationToken(lastToken)) return true;
  const nextToken = readNextCredentialToken(source, lineEnd + 1);
  return nextToken === '`' || isCredentialContinuationToken(nextToken);
}

function isCredentialContinuationToken(value: string): boolean {
  return CREDENTIAL_EXPRESSION_CONTINUATION_TOKENS.has(value);
}

function readNextCredentialToken(source: string, start: number): string {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    if (source[index] === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index + 2);
      if (index < 0) return '';
      continue;
    }
    if (source[index] === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) return '';
      index = end + 2;
      continue;
    }
    return readCredentialToken(source, index).value;
  }
  return '';
}

function readCredentialToken(source: string, start: number): { value: string; end: number } {
  const operator = /^(?:\|\||\?\?|&&|===|!==|==|!=|=>|<=|>=|\?\.|.)/.exec(source.slice(start));
  const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(start));
  const value = word?.[0] || operator?.[0] || source[start];
  return { value: value.toLowerCase(), end: start + value.length };
}

function isOnlyCredentialExpressionTrivia(value: string): boolean {
  const withoutBlockComments = value.replace(/\/\*[\s\S]*?\*\//g, '');
  const trimmed = withoutBlockComments.trim();
  return trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('#');
}

function isSafeEmptyEnvironmentLookup(candidate: string): boolean {
  const identifier = '[a-z_$][a-z0-9_$]*';
  const accessor = `(?:\\??\\.${identifier}|\\[(?:${identifier}|\\d+|["'][a-z0-9_$.-]+["'])\\])`;
  const expressionPath = `${identifier}(?:${accessor})*`;
  const environmentKey = `(?:${expressionPath}|["'][a-z0-9_.-]+["'])`;
  return new RegExp(
    `^os\\.environ\\.get\\(${environmentKey},\\s*(?:""|'')\\)`
      + `(?:\\s+if\\s+${expressionPath}\\s+else\\s+(?:""|''))?$`,
  ).test(candidate);
}

function isSafeRuntimeCredentialExpression(
  candidate: string,
  depth = 0,
  allowBareIdentifier = true,
): boolean {
  if (depth > 4) return false;
  const normalized = candidate
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/[ \t]+(?:\/\/|#).*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^(?:null|""|''|void 0)$/.test(normalized)) return true;
  if (
    (isRuntimeCredentialExpression(normalized) && (
      allowBareIdentifier || !/^[a-z_$][a-z0-9_$]*$/.test(normalized)
    ))
    || isSafeEmptyEnvironmentLookup(normalized)
  ) {
    return true;
  }
  const chain = normalized.split(/\s*(?:\|\||\?\?|&&)\s*/);
  if (chain.length > 1 && chain.every(part => (
    part && isSafeRuntimeCredentialExpression(part, depth + 1, false)
  ))) {
    return true;
  }
  const ternary = /^(.+?)(?<!\?)\?(?![?.])(.+?):(.+)$/.exec(normalized);
  if (
    ternary
    && isSafeRuntimeCredentialExpression(ternary[1], depth + 1, true)
    && ternary.slice(2).every(part => (
      isSafeRuntimeCredentialExpression(part, depth + 1, false)
    ))
  ) {
    return true;
  }
  const typeAssertion = /^(.+?)\s+as\s+[a-z_$][a-z0-9_$]*(?:\[\])?$/.exec(normalized);
  return Boolean(
    typeAssertion
    && isSafeRuntimeCredentialExpression(typeAssertion[1], depth + 1, allowBareIdentifier),
  );
}

function isSafeTypeOnlyCredentialDeclaration(candidate: string): boolean {
  const type = '(?:string|number|boolean|unknown|null|undefined)';
  return new RegExp(`^${type}(?:\\s*\\|\\s*${type})+$`).test(candidate.trim());
}

function isExplicitSafeCredentialValue(
  key: string,
  candidate: string,
  isBare: boolean,
  isSourceCode: boolean,
): boolean {
  return (
    candidate === ''
    || /^\$\{[a-z_][a-z0-9_]*\}$/.test(candidate)
    || /^%[a-z_][a-z0-9_]*%$/.test(candidate)
    || /^\$env:[a-z_][a-z0-9_]*$/.test(candidate)
    || (isBare && isSourceCode && isRuntimeCredentialExpression(candidate))
    || (
      /(?:password|passwd)$/.test(key)
      && /^(?:minimum|maximum)[-_]length[-_]\d+$/.test(candidate)
    )
    || /^(?:string|number|boolean|unknown|null|undefined|z\.string\(\)(?:\.min\(\d+\))?)$/.test(candidate)
    || /^(?:example[-_](?:api[-_]?key|token|secret|password)|placeholder(?:[-_]value)?|dummy[-_]value|changeme(?:[-_]please)?|your[-_](?:api[-_]?key|token|secret|password)[-_]here|\*{3,})$/.test(candidate)
    || (isSourceCode && EXPLICIT_SAFE_CREDENTIAL_VALUES.has(candidate))
  );
}

function isRuntimeCredentialExpression(candidate: string): boolean {
  const identifier = '[a-z_$][a-z0-9_$]*';
  const accessor = `(?:\\??\\.${identifier}|\\[(?:${identifier}|\\d+|["'][a-z0-9_$.-]+["'])\\])`;
  const expressionPath = `${identifier}(?:${accessor})*`;
  const call = `\\((?:${expressionPath}|\\d+)?\\)`;
  return (
    new RegExp(`^${identifier}$`).test(candidate)
    || new RegExp(`^(?:${expressionPath}|${identifier})(?:(?:${accessor})|${call})+$`).test(candidate)
    || new RegExp(`^os\\.environ\\.get\\((?:${expressionPath}|["'][a-z0-9_.-]+["'])\\)$`).test(candidate)
  );
}

function validRef(ref: BotSkillRef): boolean {
  try {
    canonicalizeBotSkillRefs([ref]);
    return true;
  } catch {
    return false;
  }
}

function validPackageRef(ref: SkillHubPackageRef): boolean {
  const skillId = String(ref?.skillId || '').trim();
  const version = String(ref?.version || '').trim();
  return Boolean(
    skillId
    && version
    && !skillId.split('/').some(part => !part || part === '.' || part === '..')
    && version !== '.'
    && version !== '..'
  );
}

export function isPortablePackagePath(value: string): boolean {
  const normalized = String(value || '').replace(/\\/g, '/');
  const parts = normalized.split('/');
  return Boolean(
    normalized
    && normalized.length <= 1024
    && parts.length <= 64
    && !normalized.includes('\0')
    && !Array.from(normalized).some(char => {
      const code = char.codePointAt(0) ?? 0;
      return (
        code <= 0x1f
        || (code >= 0x7f && code <= 0x9f)
        || (char.length === 1 && code >= 0xd800 && code <= 0xdfff)
      );
    })
    && !normalized.startsWith('/')
    && !/^[A-Za-z]:/.test(normalized)
    && !parts.some(part => (
      !part
      || part === '.'
      || part === '..'
      || /[<>:"|?*]/.test(part)
      || /[. ]$/.test(part)
      || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)
    ))
  );
}

function assertRealPathContained(realRoot: string, candidate: string): void {
  const realCandidate = fs.realpathSync(candidate);
  if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${path.sep}`)) {
    throw new BotSkillPackageValidationError('Skill path escaped its workspace.');
  }
}

function sha256(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
