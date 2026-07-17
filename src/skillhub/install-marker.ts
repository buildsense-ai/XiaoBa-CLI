import * as fs from 'fs';
import * as path from 'path';
import { PathResolver } from '../utils/path-resolver';
import type { SkillHubPackageInstallMarker } from './types';

export const SKILLHUB_INSTALL_MARKER_FILE = '.xiaoba-skillhub-install.json';

export function readSkillHubInstallMarker(skillDir: string): SkillHubPackageInstallMarker | null {
  const markerPath = path.join(skillDir, SKILLHUB_INSTALL_MARKER_FILE);
  if (!fs.existsSync(markerPath)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Partial<SkillHubPackageInstallMarker>;
    if (
      value?.source !== 'skillhub'
      || !stringValue(value.skillId)
      || !stringValue(value.name)
      || !stringValue(value.installName)
      || !stringValue(value.version)
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
  fs.writeFileSync(tempPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
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
