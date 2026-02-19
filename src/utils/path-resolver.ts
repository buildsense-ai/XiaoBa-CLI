import * as path from 'path';
import * as fs from 'fs';

/**
 * 路径解析工具类
 */
export class PathResolver {
  /**
   * 获取统一的 skills 目录（项目根目录的 skills 文件夹）
   */
  static getSkillsPath(): string {
    return path.join(process.cwd(), 'skills');
  }

  /**
   * 确保目录存在
   */
  static ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * 递归查找所有 SKILL.md 文件
   */
  static findSkillFiles(baseDir: string): string[] {
    const results: string[] = [];

    if (!fs.existsSync(baseDir)) {
      return results;
    }

    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(baseDir, entry.name);

      if (entry.isDirectory()) {
        // 检查是否有 SKILL.md
        const skillFile = path.join(fullPath, 'SKILL.md');
        if (fs.existsSync(skillFile)) {
          results.push(skillFile);
        }
        // 递归查找子目录
        results.push(...this.findSkillFiles(fullPath));
      }
    }

    return results;
  }
}
