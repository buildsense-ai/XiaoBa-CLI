import * as fs from 'fs';
import * as path from 'path';
import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { Logger } from '../utils/logger';
import { isPathAllowed, isToolAllowed } from '../utils/safety';

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
      const toolPermission = isToolAllowed(this.definition.name);
      if (!toolPermission.allowed) {
        return `执行被阻止: ${toolPermission.reason}`;
      }

      // 解析文件路径
      const absolutePath = path.isAbsolute(file_path)
        ? file_path
        : path.join(context.workingDirectory, file_path);

      const pathPermission = isPathAllowed(absolutePath, context.workingDirectory);
      if (!pathPermission.allowed) {
        return `执行被阻止: ${pathPermission.reason}`;
      }

      // 获取相对路径用于显示
      const relativePath = path.relative(context.workingDirectory, absolutePath);
      const displayPath = relativePath.startsWith('..') ? absolutePath : relativePath;

      // 检查文件是否已存在
      const fileExists = fs.existsSync(absolutePath);
      const operation = fileExists ? '覆盖' : '创建';

      Logger.info(`${operation}文件: ${displayPath}`);

      // 确保目录存在
      const dir = path.dirname(absolutePath);
      if (!fs.existsSync(dir)) {
        Logger.info(`创建目录: ${path.relative(context.workingDirectory, dir)}`);
        fs.mkdirSync(dir, { recursive: true });
      }

      // 计算文件信息
      const lines = content.split('\n').length;
      const bytes = Buffer.byteLength(content, 'utf-8');
      const sizeKB = (bytes / 1024).toFixed(2);

      // 写入文件
      fs.writeFileSync(absolutePath, content, 'utf-8');

      // 显示内容预览（前3行）
      const previewLines = content.split('\n').slice(0, 3);
      const preview = previewLines.join('\n');
      const hasMore = lines > 3;

      Logger.success(`✓ 成功${operation}文件: ${displayPath}`);
      Logger.info(`  行数: ${lines} | 大小: ${sizeKB} KB (${bytes} bytes)`);

      if (preview.trim()) {
        Logger.info(`  内容预览:`);
        previewLines.forEach((line: string) => {
          const displayLine = line.length > 80 ? line.substring(0, 77) + '...' : line;
          Logger.info(`    ${displayLine}`);
        });
        if (hasMore) {
          Logger.info(`    ... (还有 ${lines - 3} 行)`);
        }
      }

      return `成功${operation}文件: ${file_path}\n行数: ${lines}\n大小: ${sizeKB} KB (${bytes} bytes)`;
    } catch (error: any) {
      Logger.error(`写入文件失败: ${file_path} - ${error.message}`);
      return `写入文件失败: ${error.message}`;
    }
  }
}
