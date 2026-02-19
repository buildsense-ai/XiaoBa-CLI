import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { PythonToolWrapper, PythonToolSchema } from './python-tool-wrapper';
import { Logger } from '../utils/logger';

/**
 * 扫描 tools/global/*_tool.py，对每个文件执行 --schema 获取定义，
 * 返回 PythonToolWrapper[] 供 ToolManager 注册
 */
export function loadGlobalPythonTools(projectRoot: string): PythonToolWrapper[] {
  const globalDir = path.join(projectRoot, 'tools', 'global');

  if (!fs.existsSync(globalDir)) {
    Logger.warning(`[PythonToolLoader] 目录不存在: ${globalDir}`);
    return [];
  }

  const files = fs.readdirSync(globalDir).filter(
    (f) => f.endsWith('_tool.py') && f !== 'base_tool.py',
  );

  if (files.length === 0) {
    Logger.info('[PythonToolLoader] 未发现全局 Python 工具');
    return [];
  }

  const tools: PythonToolWrapper[] = [];

  for (const file of files) {
    const scriptPath = path.join(globalDir, file);
    try {
      const raw = execSync(`python "${scriptPath}" --schema`, {
        encoding: 'utf-8',
        timeout: 10_000,
        env: {
          ...process.env,
          PYTHONPATH: globalDir,
          PYTHONIOENCODING: 'utf-8',
        },
      });

      const schema: PythonToolSchema = JSON.parse(raw);

      if (!schema.name || !schema.parameters) {
        Logger.warning(`[PythonToolLoader] ${file} schema 不完整，跳过`);
        continue;
      }

      tools.push(new PythonToolWrapper(schema, scriptPath, globalDir));
      Logger.info(`[PythonToolLoader] 已加载: ${schema.name} (${file})`);
    } catch (err: any) {
      Logger.warning(`[PythonToolLoader] 加载 ${file} 失败: ${err.message}`);
    }
  }

  Logger.info(`[PythonToolLoader] 已加载 ${tools.length} 个全局 Python 工具`);
  return tools;
}
