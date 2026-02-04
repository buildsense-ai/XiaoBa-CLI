import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

/**
 * 路径解析工具类
 */
export class PathResolver {
  /**
   * 获取社区 skills 目录（从 GitHub 等安装的 skills）
   */
  static getCommunitySkillsPath(): string {
    return path.join(process.cwd(), 'skills');
  }

  /**
   * 获取项目级 skills 目录（项目自定义的 skills）
   */
  static getProjectSkillsPath(): string {
    return path.join(process.cwd(), '.xiaoba', 'skills');
  }

  /**
   * 获取用户级 skills 目录
   */
  static getUserSkillsPath(): string {
    return path.join(os.homedir(), '.xiaoba', 'skills');
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
   * 获取 npm 包形式的 skills 搜索路径
   */
  static getNpmSkillsPaths(): string[] {
    const paths: string[] = [];

    // 1. 项目的 node_modules
    const projectNodeModules = path.join(process.cwd(), 'node_modules');
    if (fs.existsSync(projectNodeModules)) {
      paths.push(projectNodeModules);
    }

    // 2. 全局 node_modules (Windows)
    const globalNodeModulesWin = path.join(process.env.APPDATA || '', 'npm', 'node_modules');
    if (fs.existsSync(globalNodeModulesWin)) {
      paths.push(globalNodeModulesWin);
    }

    // 3. 全局 node_modules (Unix/Linux/Mac)
    const globalNodeModulesUnix = path.join(os.homedir(), '.npm-global', 'lib', 'node_modules');
    if (fs.existsSync(globalNodeModulesUnix)) {
      paths.push(globalNodeModulesUnix);
    }

    return paths;
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

  /**
   * 从 node_modules 中查找 @xiaoba-skills/* 包
   */
  static findNpmSkills(): string[] {
    const results: string[] = [];
    const npmPaths = this.getNpmSkillsPaths();

    for (const npmPath of npmPaths) {
      // 查找 @xiaoba-skills 作用域下的包
      const skillsScope = path.join(npmPath, '@xiaoba-skills');
      if (fs.existsSync(skillsScope)) {
        try {
          const packages = fs.readdirSync(skillsScope);

          for (const pkg of packages) {
            const skillFile = path.join(skillsScope, pkg, 'SKILL.md');
            if (fs.existsSync(skillFile)) {
              results.push(skillFile);
            }
          }
        } catch (error) {
          // 忽略读取错误
        }
      }
    }

    return results;
  }
}
