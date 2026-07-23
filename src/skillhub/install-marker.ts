import * as fs from 'fs';
import * as path from 'path';
import { normalizeBotSkillRef } from '../bot-definition/skill-ref';
import { PathResolver } from '../utils/path-resolver';
import type { SkillHubPackageInstallMarker } from './types';

export const SKILLHUB_INSTALL_MARKER_FILE = '.xiaoba-skillhub-install.json';
const MAX_INSTALL_MARKER_BYTES = 64 * 1024;
const MAX_MARKER_TEXT_BYTES = 1024;
const MAX_PACKAGE_URL_BYTES = 4096;
const MAX_SIGNATURE_BYTES = 16 * 1024;

export function readSkillHubInstallMarker(skillDir: string): SkillHubPackageInstallMarker | null {
  const markerPath = path.join(skillDir, SKILLHUB_INSTALL_MARKER_FILE);
  if (!fs.existsSync(markerPath)) return null;
  try {
    const stat = fs.lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INSTALL_MARKER_BYTES) {
      return null;
    }
    return normalizeInstallMarker(JSON.parse(fs.readFileSync(markerPath, 'utf8')));
  } catch {
    return null;
  }
}

export function writeSkillHubInstallMarker(skillDir: string, marker: SkillHubPackageInstallMarker): void {
  let rawSerialized: string;
  try {
    rawSerialized = `${JSON.stringify(marker, null, 2)}\n`;
  } catch (cause) {
    const error: any = new Error('SkillHub install marker is invalid.');
    error.code = 'INSTALL_MARKER_INVALID';
    error.status = 422;
    error.cause = cause;
    throw error;
  }
  if (Buffer.byteLength(rawSerialized, 'utf8') > MAX_INSTALL_MARKER_BYTES) {
    const error: any = new Error('SkillHub install marker exceeds the local metadata limit.');
    error.code = 'INSTALL_MARKER_TOO_LARGE';
    error.status = 422;
    throw error;
  }
  let normalized: SkillHubPackageInstallMarker;
  try {
    normalized = normalizeInstallMarker(marker);
  } catch (cause) {
    const error: any = new Error('SkillHub install marker is invalid.');
    error.code = 'INSTALL_MARKER_INVALID';
    error.status = 422;
    error.cause = cause;
    throw error;
  }
  fs.mkdirSync(skillDir, { recursive: true });
  const markerPath = path.join(skillDir, SKILLHUB_INSTALL_MARKER_FILE);
  const tempPath = `${markerPath}.tmp-${process.pid}-${Date.now()}`;
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_INSTALL_MARKER_BYTES) {
    const error: any = new Error('SkillHub install marker exceeds the local metadata limit.');
    error.code = 'INSTALL_MARKER_TOO_LARGE';
    error.status = 422;
    throw error;
  }
  fs.writeFileSync(tempPath, serialized, 'utf8');
  fs.renameSync(tempPath, markerPath);
}

export function listInstalledSkillHubSkills(userId?: string): SkillHubPackageInstallMarker[] {
  const root = path.resolve(PathResolver.getSkillsPath());
  if (!fs.existsSync(root)) return [];
  const expectedUserId = stringValue(userId);
  const markers: SkillHubPackageInstallMarker[] = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const marker = readSkillHubInstallMarker(path.join(root, entry.name));
    if (!marker) continue;
    if (expectedUserId && marker.userId !== expectedUserId) continue;
    markers.push(marker);
  }

  return markers.sort((left, right) => left.skillId.localeCompare(right.skillId));
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeInstallMarker(value: unknown): SkillHubPackageInstallMarker {
  if (!isRecord(value) || value.source !== 'skillhub') {
    throw new Error('marker.source must be skillhub');
  }

  const ref = normalizeBotSkillRef({
    skillId: value.skillId as string,
    version: value.version as string,
  });
  const visibility = value.visibility === undefined ? 'public' : value.visibility;
  if (visibility !== 'public' && visibility !== 'private') {
    throw new Error('marker.visibility must be public or private');
  }

  const hasOwnerBotId = Object.prototype.hasOwnProperty.call(value, 'ownerBotId');
  const hasLocalSkillId = Object.prototype.hasOwnProperty.call(value, 'localSkillId');
  if (visibility === 'public' && (hasOwnerBotId || hasLocalSkillId)) {
    throw new Error('public marker must not contain private ownership fields');
  }

  const signature = value.signature;
  if (!isRecord(signature) || signature.algorithm !== 'ed25519') {
    throw new Error('marker.signature.algorithm must be ed25519');
  }

  return {
    source: 'skillhub',
    visibility,
    ...(value.userId !== undefined
      ? { userId: requiredText(value.userId, 'marker.userId') }
      : {}),
    ...(visibility === 'private'
      ? {
        ownerBotId: requiredText(value.ownerBotId, 'marker.ownerBotId'),
        localSkillId: requiredText(value.localSkillId, 'marker.localSkillId'),
      }
      : {}),
    skillId: ref.skillId,
    name: requiredText(value.name, 'marker.name').normalize('NFC'),
    installName: normalizeInstallName(value.installName),
    version: ref.version,
    packageChecksumSha256: requiredHash(
      value.packageChecksumSha256,
      'marker.packageChecksumSha256',
    ),
    ...(value.installedContentHash !== undefined
      ? {
        installedContentHash: requiredHash(
          value.installedContentHash,
          'marker.installedContentHash',
        ),
      }
      : {}),
    signature: {
      algorithm: 'ed25519',
      keyId: requiredText(signature.keyId, 'marker.signature.keyId'),
      signature: requiredText(
        signature.signature,
        'marker.signature.signature',
        MAX_SIGNATURE_BYTES,
      ),
      // Older public packages did not expose signedAt in registry metadata.
      // Canonicalize those markers with the local install timestamp while
      // requiring private packages to carry a stable signed timestamp.
      signedAt: normalizeTimestamp(
        signature.signedAt ?? (visibility === 'public' ? value.installedAt : undefined),
        'marker.signature.signedAt',
      ),
    },
    packageUrl: requiredText(value.packageUrl, 'marker.packageUrl', MAX_PACKAGE_URL_BYTES),
    installedAt: normalizeTimestamp(value.installedAt, 'marker.installedAt'),
  };
}

function normalizeInstallName(value: unknown): string {
  const name = requiredText(value, 'marker.installName').normalize('NFC');
  if (
    name !== path.posix.basename(name)
    || name !== path.win32.basename(name)
    || name === '.'
    || name === '..'
    || /[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(name)
    || /[ .]$/u.test(name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)
  ) {
    throw new Error('marker.installName is not a safe portable directory name');
  }
  return name;
}

function requiredText(
  value: unknown,
  field: string,
  maxBytes = MAX_MARKER_TEXT_BYTES,
): string {
  const text = stringValue(value);
  if (
    !text
    || Buffer.byteLength(text, 'utf8') > maxBytes
    || /[\u0000-\u001f\u007f]/u.test(text)
  ) {
    throw new Error(`${field} is missing, too long, or contains control characters`);
  }
  return text;
}

function requiredHash(value: unknown, field: string): string {
  const hash = requiredText(value, field).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(hash)) {
    throw new Error(`${field} must be a SHA-256 hex digest`);
  }
  return hash;
}

function normalizeTimestamp(value: unknown, field: string): string {
  const timestamp = requiredText(value, field);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/u.exec(timestamp);
  if (!match) throw new Error(`${field} must be an ISO-8601 UTC timestamp`);
  const parsed = new Date(timestamp);
  const normalized = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== normalized) {
    throw new Error(`${field} must be a valid timestamp`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
