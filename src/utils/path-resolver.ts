import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export class PathResolver {
  static getRuntimeDataRoot(
    env: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd(),
  ): string {
    const explicit = [
      env.XIAOBA_USER_DATA_DIR,
      env.CATSCO_USER_DATA_DIR,
      env.XIAOBA_ELECTRON_USER_DATA_DIR,
      // Legacy data-root compatibility only. Bundled executable discovery uses
      // XIAOBA_BUNDLED_EXECUTABLES_DIR and must not write this variable.
      env.XIAOBA_RUNTIME_ROOT,
    ]
      .map(value => String(value || '').trim())
      .find(Boolean);

    if (
      explicit
      && env.NODE_TEST_CONTEXT
      && env.XIAOBA_ALLOW_NON_TEMP_TEST_RUNTIME_ROOT !== '1'
      && !isPathInside(path.resolve(explicit), path.resolve(os.tmpdir()))
    ) {
      throw new Error(
        `Refusing Node test runtime data root outside the OS temporary directory: ${path.resolve(explicit)}`,
      );
    }

    return path.resolve(explicit || cwd);
  }

  static getDataPath(...segments: string[]): string {
    return path.join(this.getRuntimeDataRoot(), 'data', ...segments);
  }

  static getLogsPath(...segments: string[]): string {
    return path.join(this.getRuntimeDataRoot(), 'logs', ...segments);
  }

  static getAttachmentsPath(...segments: string[]): string {
    return this.getDataPath('attachments', ...segments);
  }

  static getPromptOverridesPath(): string {
    return path.join(this.getRuntimeDataRoot(), 'prompt-overrides');
  }

  static getSkillsPath(): string {
    const override = process.env.XIAOBA_SKILLS_DIR?.trim();
    if (override) return path.resolve(override);
    return this.getUserDataSkillsPath();
  }

  static getUserDataSkillsPath(): string {
    return path.join(this.getRuntimeDataRoot(), 'skills');
  }

  static ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  static findSkillFiles(baseDir: string): string[] {
    const results: string[] = [];

    if (!fs.existsSync(baseDir)) {
      return results;
    }

    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(baseDir, entry.name);

      if (entry.isDirectory()) {
        const skillFile = path.join(fullPath, 'SKILL.md');
        if (fs.existsSync(skillFile)) {
          results.push(skillFile);
        }
        results.push(...this.findSkillFiles(fullPath));
      }
    }

    return results;
  }
}

function isPathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
