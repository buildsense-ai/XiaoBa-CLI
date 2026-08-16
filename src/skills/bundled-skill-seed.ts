import * as fs from 'node:fs';
import * as path from 'node:path';

import { Logger } from '../utils/logger';
import { PathResolver } from '../utils/path-resolver';

/**
 * Source-controlled manual Skills that must be usable on a cold, offline
 * runtime. Generated capabilities are deliberately absent: their durable
 * Registry, evidence, and lifecycle live under the runtime data root.
 */
const BUNDLED_MANUAL_SKILLS = ['mails'] as const;

/** Copy missing built-in manual Skills into the active runtime workspace. */
export function seedBundledManualSkills(): void {
  const sourceRoot = resolveBundledSkillsRoot();
  if (!sourceRoot) return;

  const targetRoot = path.resolve(PathResolver.getSkillsPath());
  if (targetRoot === sourceRoot) return;

  for (const name of BUNDLED_MANUAL_SKILLS) {
    const sourceDir = resolveChild(sourceRoot, name);
    const sourceSkillFile = path.join(sourceDir, 'SKILL.md');
    const targetDir = resolveChild(targetRoot, name);
    if (!fs.existsSync(sourceSkillFile) || fs.existsSync(targetDir)) continue;

    try {
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      fs.cpSync(sourceDir, targetDir, {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: source => !['.git', 'node_modules', '__pycache__'].includes(path.basename(source)),
      });
    } catch (error: any) {
      // A concurrent installer or a user-created directory wins; discovery
      // will use its resulting workspace on this or the next load.
      Logger.warning(`Failed to seed bundled Skill ${name}: ${error?.message || String(error)}`);
    }
  }
}

function resolveBundledSkillsRoot(): string | undefined {
  const configuredAppRoot = process.env.XIAOBA_APP_ROOT?.trim();
  // Electron gives the installed bundle an explicit root. Treat it as
  // authoritative: falling through to an unrelated source checkout would
  // make a test/development configuration silently seed the wrong package.
  const candidates = configuredAppRoot
    ? [configuredAppRoot]
    : [path.resolve(__dirname, '../..')];
  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;
    const root = path.resolve(candidate);
    if (fs.existsSync(path.join(root, 'skills', 'mails', 'SKILL.md'))) {
      return path.join(root, 'skills');
    }
  }
  return undefined;
}

function resolveChild(rootDir: string, name: string): string {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, name);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Unsafe bundled Skill path: ${name}`);
  }
  return target;
}
