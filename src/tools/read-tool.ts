import * as fs from 'fs';
import * as path from 'path';
import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';

/**
 * Read 工具 - 读取文件内容
 */
export class ReadTool implements Tool {
  definition: ToolDefinition = {
    name: 'read_file',
    description: '读取文件内容。可以读取文本文件、代码文件等。',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '要读取的文件路径（绝对路径或相对于工作目录的路径）'
        },
        offset: {
          type: 'number',
          description: '从第几行开始读取（可选，默认从第1行开始）'
        },
        limit: {
          type: 'number',
          description: '读取多少行（可选，默认读取全部）'
        }
      },
      required: ['file_path']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const { file_path, offset = 0, limit } = args;

    try {
      // 解析文件路径
      const absolutePath = path.isAbsolute(file_path)
        ? file_path
        : path.join(context.workingDirectory, file_path);

      // 检查文件是否存在
      if (!fs.existsSync(absolutePath)) {
        return `错误：文件不存在: ${absolutePath}`;
      }

      // 读取文件内容
      const content = fs.readFileSync(absolutePath, 'utf-8');
      const lines = content.split('\n');

      // 应用offset和limit
      const startLine = offset;
      const endLine = limit ? startLine + limit : lines.length;
      const selectedLines = lines.slice(startLine, endLine);

      // 格式化输出（带行号）
      const formattedLines = selectedLines.map((line, index) => {
        const lineNumber = startLine + index + 1;
        return `${lineNumber.toString().padStart(5, ' ')}→${line}`;
      });

      return `文件: ${file_path}\n总行数: ${lines.length}\n显示: ${startLine + 1}-${Math.min(endLine, lines.length)}\n\n${formattedLines.join('\n')}`;
    } catch (error: any) {
      return `读取文件失败: ${error.message}`;
    }
  }
}
