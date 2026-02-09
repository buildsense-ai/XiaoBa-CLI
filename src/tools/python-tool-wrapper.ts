import { spawn } from 'child_process';
import * as path from 'path';
import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { isToolAllowed } from '../utils/safety';

/**
 * Python 工具配置接口
 */
export interface PythonToolConfig {
  name: string;
  description: string;
  script: string;
  timeout?: number;
  parameters: any;
}

/**
 * Python 工具包装器 - 用于调用 Python 脚本
 */
export class PythonToolWrapper implements Tool {
  definition: ToolDefinition;
  private scriptPath: string;
  private timeout: number;

  constructor(config: PythonToolConfig, workingDirectory: string) {
    this.definition = {
      name: config.name,
      description: config.description,
      parameters: config.parameters
    };

    // 解析脚本路径（相对于工作目录）
    this.scriptPath = path.isAbsolute(config.script)
      ? config.script
      : path.join(workingDirectory, config.script);

    this.timeout = config.timeout || 30000;
  }

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      if (this.definition.name === 'self_evolution') {
        const toolPermission = isToolAllowed(this.definition.name);
        if (!toolPermission.allowed) {
          return `执行被阻止: ${toolPermission.reason}`;
        }
      }

      const result = await this.executePythonScript(args);
      return this.formatResult(result);
    } catch (error: any) {
      return `Python 工具执行失败: ${error.message}`;
    }
  }

  /**
   * 执行 Python 脚本
   */
  private executePythonScript(args: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const pythonExecutable = process.env.PYTHON_EXECUTABLE || 'python';
      const inputData = JSON.stringify(args);

      // 启动 Python 进程
      const pythonProcess = spawn(pythonExecutable, [this.scriptPath, inputData], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUTF8: process.env.PYTHONUTF8 || '1',
          PYTHONIOENCODING: process.env.PYTHONIOENCODING || 'utf-8'
        }
      });

      let stdout = '';
      let stderr = '';

      // 收集标准输出
      pythonProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      // 收集错误输出并实时显示（用于进度反馈）
      pythonProcess.stderr.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        // 实时输出到控制台，让用户看到进度
        process.stderr.write(text);
      });

      // 设置超时
      const timeoutId = setTimeout(() => {
        pythonProcess.kill();
        reject(new Error(`Python 脚本执行超时 (${this.timeout}ms)`));
      }, this.timeout);

      // 处理进程结束
      pythonProcess.on('close', (code) => {
        clearTimeout(timeoutId);

        if (code !== 0) {
          reject(new Error(`Python 脚本退出码: ${code}\n错误信息: ${stderr}`));
          return;
        }

        try {
          const result = JSON.parse(stdout);
          resolve(result);
        } catch (error) {
          reject(new Error(`解析 Python 输出失败: ${stdout}\n${stderr}`));
        }
      });

      // 处理进程错误
      pythonProcess.on('error', (error) => {
        clearTimeout(timeoutId);
        reject(new Error(`启动 Python 进程失败: ${error.message}`));
      });

      // 写入输入数据
      pythonProcess.stdin.write(inputData);
      pythonProcess.stdin.end();
    });
  }

  /**
   * 格式化结果
   */
  private formatResult(result: any): string {
    if (!result.success) {
      return `错误: ${result.error || '未知错误'}`;
    }

    // 兼容两种 Python 输出格式：
    // 1) BaseTool: { success: true, data: {...}, error: null }
    // 2) Legacy:   { success: true, ... }  (没有 data 字段)
    const payload = result.data !== undefined ? result.data : result;

    if (typeof payload === 'string') {
      return payload;
    }

    return JSON.stringify(payload, null, 2);
  }
}
