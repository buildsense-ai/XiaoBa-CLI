import * as fs from 'fs';
import * as path from 'path';
import { Tool } from '../types/tool';
import { PythonToolWrapper, PythonToolConfig } from './python-tool-wrapper';

/**
 * Python 工具配置文件结构
 */
interface PythonToolsConfig {
  tools: PythonToolConfig[];
  settings: {
    python_executable?: string;
    max_buffer_size?: number;
    default_timeout?: number;
    encoding?: string;
  };
}

/**
 * Python 工具加载器
 */
export class PythonToolLoader {
  private workingDirectory: string;
  private configPath: string;

  constructor(workingDirectory: string = process.cwd()) {
    this.workingDirectory = workingDirectory;
    this.configPath = path.join(workingDirectory, 'tools', 'python', 'tool-config.json');
  }

  /**
   * 加载所有 Python 工具
   */
  loadTools(): Tool[] {
    try {
      // 检查配置文件是否存在
      if (!fs.existsSync(this.configPath)) {
        console.warn(`Python 工具配置文件不存在: ${this.configPath}`);
        return [];
      }

      // 读取配置文件
      const configContent = fs.readFileSync(this.configPath, 'utf-8');
      const config: PythonToolsConfig = JSON.parse(configContent);

      // 应用全局设置
      if (config.settings?.python_executable) {
        process.env.PYTHON_EXECUTABLE = config.settings.python_executable;
      }

      // 创建工具实例
      const tools: Tool[] = [];
      for (const toolConfig of config.tools) {
        try {
          const tool = new PythonToolWrapper(toolConfig, this.workingDirectory);
          tools.push(tool);
        } catch (error: any) {
          console.warn(`加载 Python 工具失败: ${toolConfig.name} - ${error.message}`);
        }
      }

      return tools;
    } catch (error: any) {
      console.error(`加载 Python 工具配置失败: ${error.message}`);
      return [];
    }
  }

  /**
   * 检查 Python 环境
   */
  async checkPythonEnvironment(): Promise<boolean> {
    const { spawn } = require('child_process');
    const pythonExecutable = process.env.PYTHON_EXECUTABLE || 'python';

    return new Promise((resolve) => {
      const pythonProcess = spawn(pythonExecutable, ['--version']);

      pythonProcess.on('close', (code: number) => {
        resolve(code === 0);
      });

      pythonProcess.on('error', () => {
        resolve(false);
      });
    });
  }
}
