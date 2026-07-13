import * as path from 'path';
import * as fs from 'fs';

export class PathResolver {
  static getRuntimeDataRoot(): string {
    const explicit = [
      process.env.XIAOBA_USER_DATA_DIR,
      process.env.CATSCO_USER_DATA_DIR,
      process.env.XIAOBA_ELECTRON_USER_DATA_DIR,
      process.env.XIAOBA_RUNTIME_ROOT,
    ]
      .map(value => String(value || '').trim())
      .find(Boolean);

    return path.resolve(explicit || process.cwd());
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

  static getSkillEvolutionRegistryPath(): string {
    const override = process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE?.trim();
    return path.resolve(override || this.getDataPath('current-skill-registry.json'));
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
      if (entry.isDirectory() && entry.name === 'history') continue;
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
