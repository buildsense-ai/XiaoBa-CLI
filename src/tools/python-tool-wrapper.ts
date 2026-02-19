import { spawn } from 'child_process';
import * as path from 'path';
import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { Logger } from '../utils/logger';

/**
 * Python 工具 schema（由 --schema 输出）
 */
export interface PythonToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  timeout?: number;
}

/**
 * PythonToolWrapper - 将 tools/global/ 下的 Python 工具包装为 TS Tool 接口
 *
 * execute() 流程：JSON 写入 stdin → 读取 stdout → 解析结果
 */
export class PythonToolWrapper implements Tool {
  definition: ToolDefinition;
  private scriptPath: string;
  private timeoutMs: number;
  private globalToolsDir: string;

  constructor(schema: PythonToolSchema, scriptPath: string, globalToolsDir: string) {
    this.definition = {
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
    };
    this.scriptPath = scriptPath;
    this.timeoutMs = (schema.timeout ?? 30) * 1000;
    this.globalToolsDir = globalToolsDir;
  }

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const inputJson = JSON.stringify(args);

    Logger.info(`[PythonTool] 调用 ${this.definition.name}`);

    return new Promise<string>((resolve) => {
      const env = {
        ...process.env,
        PYTHONPATH: this.globalToolsDir,
        PYTHONIOENCODING: 'utf-8',
      };

      const child = spawn('python', [this.scriptPath], {
        cwd: context.workingDirectory,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString('utf-8');
      });

      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString('utf-8');
      });

      // 超时控制
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve(`工具 ${this.definition.name} 执行超时（${this.timeoutMs / 1000}s）`);
      }, this.timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);

        if (stderr) {
          // stderr 用于日志，不算错误
          Logger.info(`[PythonTool] ${this.definition.name} stderr: ${stderr.substring(0, 500)}`);
        }

        if (!stdout.trim()) {
          resolve(`工具 ${this.definition.name} 无输出（exit code: ${code}）`);
          return;
        }

        try {
          const result = JSON.parse(stdout);
          if (result.success) {
            resolve(JSON.stringify(result.data, null, 2));
          } else {
            resolve(`工具执行失败: ${result.error || '未知错误'}`);
          }
        } catch {
          // 非 JSON 输出，直接返回原文
          resolve(stdout);
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve(`工具 ${this.definition.name} 启动失败: ${err.message}`);
      });

      // 写入 stdin
      child.stdin.write(inputJson);
      child.stdin.end();
    });
  }
}
