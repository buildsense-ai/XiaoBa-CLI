import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export class PathResolver {
  static getSkillsPath(): string {
    const override = process.env.XIAOBA_SKILLS_DIR?.trim();
    if (override) return path.resolve(override);
    return this.getUserDataSkillsPath();
  }

  static getUserDataSkillsPath(): string {
    if (process.platform === 'win32') {
      return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'xiaoba-cli', 'skills');
    }
    if (process.platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Application Support', 'xiaoba-cli', 'skills');
    }
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'xiaoba-cli', 'skills');
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
