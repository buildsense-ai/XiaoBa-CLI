import * as path from 'path';
import * as fs from 'fs';

/**
 * 输出管理器
 * 统一管理各种任务的输出目录
 */
export class OutputManager {
  /**
   * 获取论文分析的输出目录
   * @param paperName 论文名称（不含扩展名）
   * @returns 论文分析结果的完整路径
   */
  static getPaperAnalysisDir(paperName: string): string {
    // 基础目录：docs/analysis
    const baseDir = path.join(process.cwd(), 'docs', 'analysis');

    // 确保基础目录存在
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }

    // 论文分析目录：docs/analysis/[论文名称]
    const analysisDir = path.join(baseDir, paperName);

    // 确保分析目录存在
    if (!fs.existsSync(analysisDir)) {
      fs.mkdirSync(analysisDir, { recursive: true });
    }

    return analysisDir;
  }

  /**
   * 获取通用输出目录
   * @param taskType 任务类型（如 'exports', 'reports' 等）
   * @returns 输出目录的完整路径
   */
  static getOutputDir(taskType: string): string {
    const baseDir = path.join(process.cwd(), 'outputs');
    const taskDir = path.join(baseDir, taskType);

    // 确保目录存在
    if (!fs.existsSync(taskDir)) {
      fs.mkdirSync(taskDir, { recursive: true });
    }

    return taskDir;
  }

  /**
   * 清理论文名称，移除不合法的文件名字符
   * @param paperName 原始论文名称
   * @returns 清理后的论文名称
   */
  static sanitizePaperName(paperName: string): string {
    // 移除文件扩展名
    let cleanName = paperName.replace(/\.(pdf|md)$/i, '');

    // 移除或替换不合法的文件名字符
    cleanName = cleanName
      .replace(/[<>:"/\\|?*]/g, '_')  // 替换不合法字符为下划线
      .replace(/\s+/g, '_')            // 替换空格为下划线
      .replace(/_+/g, '_')             // 合并多个下划线
      .replace(/^_|_$/g, '');          // 移除首尾下划线

    return cleanName;
  }
}
