import * as path from 'path';
import * as fs from 'fs';

/**
 * Path helpers for local runtime resources.
 */
export class PathResolver {
  static readonly BASE_SKILL_NAMESPACE = '_base';
  static readonly INTERNAL_SKILL_NAMESPACES = new Set([PathResolver.BASE_SKILL_NAMESPACE, '_tool-skills']);

  static getSkillsPath(): string {
    return path.join(process.cwd(), 'skills');
  }

  static ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  static findSkillFiles(baseDir: string): string[] {
    if (!fs.existsSync(baseDir)) return [];

    const root = path.resolve(baseDir);
    PathResolver.migrateFlatSkillsToBase(root);

    const results: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const namespacePath = path.join(root, entry.name);

      if (PathResolver.INTERNAL_SKILL_NAMESPACES.has(entry.name)) {
        results.push(...PathResolver.findSkillFilesRecursive(namespacePath));
        continue;
      }

      if (!PathResolver.isSafeSkillPathPart(entry.name)) continue;
      for (const skillEntry of fs.readdirSync(namespacePath, { withFileTypes: true })) {
        if (!skillEntry.isDirectory() || !PathResolver.isSafeSkillPathPart(skillEntry.name)) continue;
        const skillFile = path.join(namespacePath, skillEntry.name, 'SKILL.md');
        if (fs.existsSync(skillFile)) results.push(skillFile);
      }
    }
    return results;
  }

  static isShareableSkillFile(skillFilePath: string, skillsRoot: string = PathResolver.getSkillsPath()): boolean {
    const parts = PathResolver.getSkillDirParts(skillFilePath, skillsRoot);
    return parts.length === 2
      && !PathResolver.INTERNAL_SKILL_NAMESPACES.has(parts[0])
      && PathResolver.isSafeSkillPathPart(parts[0])
      && PathResolver.isSafeSkillPathPart(parts[1]);
  }

  static isBaseSkillFile(skillFilePath: string, skillsRoot: string = PathResolver.getSkillsPath()): boolean {
    const parts = PathResolver.getSkillDirParts(skillFilePath, skillsRoot);
    return parts.length >= 2 && PathResolver.INTERNAL_SKILL_NAMESPACES.has(parts[0]);
  }

  static getSkillIdFromFile(skillFilePath: string, skillsRoot: string = PathResolver.getSkillsPath()): string | undefined {
    const parts = PathResolver.getSkillDirParts(skillFilePath, skillsRoot);
    if (parts.length === 2 && !PathResolver.INTERNAL_SKILL_NAMESPACES.has(parts[0])) {
      return `${parts[0]}/${parts[1]}`;
    }
    return undefined;
  }

  static getSkillDirParts(skillFilePath: string, skillsRoot: string = PathResolver.getSkillsPath()): string[] {
    const dir = path.dirname(path.resolve(skillFilePath));
    const relative = path.relative(path.resolve(skillsRoot), dir);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return [];
    return relative.split(path.sep).filter(Boolean);
  }

  private static migrateFlatSkillsToBase(root: string): void {
    const baseDir = path.join(root, PathResolver.BASE_SKILL_NAMESPACE);
    fs.mkdirSync(baseDir, { recursive: true });

    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || PathResolver.INTERNAL_SKILL_NAMESPACES.has(entry.name)) continue;
      if (!PathResolver.isSafeSkillPathPart(entry.name)) continue;

      const source = path.join(root, entry.name);
      const directSkill = path.join(source, 'SKILL.md');
      if (!fs.existsSync(directSkill)) continue;

      const target = path.join(baseDir, entry.name);
      if (fs.existsSync(target)) continue;
      fs.renameSync(source, target);
    }
  }

  private static findSkillFilesRecursive(baseDir: string): string[] {
    if (!fs.existsSync(baseDir)) return [];
    const results: string[] = [];
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(baseDir, entry.name);
      const skillFile = path.join(fullPath, 'SKILL.md');
      if (fs.existsSync(skillFile)) results.push(skillFile);
      results.push(...PathResolver.findSkillFilesRecursive(fullPath));
    }
    return results;
  }

  private static isSafeSkillPathPart(value: string): boolean {
    return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value);
  }
}
