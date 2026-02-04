import * as fs from 'fs';
import * as path from 'path';
import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';

/**
 * Write 工具 - 写入文件内容
 */
export class WriteTool implements Tool {
  definition: ToolDefinition = {
    name: 'write_file',
    description: '写入文件内容。可以创建新文件或覆盖现有文件。',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '要写入的文件路径（绝对路径或相对于工作目录的路径）'
        },
        content: {
          type: 'string',
          description: '要写入的内容'
        }
      },
      required: ['file_path', 'content']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const { file_path, content } = args;

    try {
      // 解析文件路径
      const absolutePath = path.isAbsolute(file_path)
        ? file_path
        : path.join(context.workingDirectory, file_path);

      // 确保目录存在
      const dir = path.dirname(absolutePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // 写入文件
      fs.writeFileSync(absolutePath, content, 'utf-8');

      const lines = content.split('\n').length;
      const bytes = Buffer.byteLength(content, 'utf-8');

      return `成功写入文件: ${file_path}\n行数: ${lines}\n大小: ${bytes} bytes`;
    } catch (error: any) {
      return `写入文件失败: ${error.message}`;
    }
  }
}
