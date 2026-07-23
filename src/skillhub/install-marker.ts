import * as fs from 'fs';
import * as path from 'path';
import { PathResolver } from '../utils/path-resolver';
import type { SkillHubPackageInstallMarker } from './types';

export const SKILLHUB_INSTALL_MARKER_FILE = '.xiaoba-skillhub-install.json';
const MAX_INSTALL_MARKER_BYTES = 64 * 1024;

export function readSkillHubInstallMarker(skillDir: string): SkillHubPackageInstallMarker | null {
  const markerPath = path.join(skillDir, SKILLHUB_INSTALL_MARKER_FILE);
  if (!fs.existsSync(markerPath)) return null;
  try {
    const stat = fs.lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INSTALL_MARKER_BYTES) {
      return null;
    }
    const value = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Partial<SkillHubPackageInstallMarker>;
    if (
      value?.source !== 'skillhub'
      || !stringValue(value.skillId)
      || !stringValue(value.name)
      || !stringValue(value.installName)
      || !stringValue(value.version)
      || (value.installedContentHash !== undefined && !stringValue(value.installedContentHash))
    ) {
      return null;
    }
    return value as SkillHubPackageInstallMarker;
  } catch {
    return null;
  }
}

export function writeSkillHubInstallMarker(skillDir: string, marker: SkillHubPackageInstallMarker): void {
  fs.mkdirSync(skillDir, { recursive: true });
  const markerPath = path.join(skillDir, SKILLHUB_INSTALL_MARKER_FILE);
  const tempPath = `${markerPath}.tmp-${process.pid}-${Date.now()}`;
  const serialized = `${JSON.stringify(marker, null, 2)}\n`;
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
