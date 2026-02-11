import * as fs from 'fs';
import * as path from 'path';
import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { ToolPolicyGateway } from '../utils/tool-policy-gateway';

/**
 * Edit 工具 - 精确字符串替换
 */
export class EditTool implements Tool {
  definition: ToolDefinition = {
    name: 'edit_file',
    description: '对文件进行精确的字符串替换。用于修改代码、配置文件等。必须提供要替换的原始字符串和新字符串。',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '要编辑的文件路径（绝对路径或相对于工作目录的路径）'
        },
        old_string: {
          type: 'string',
          description: '要被替换的原始字符串（必须在文件中存在）'
        },
        new_string: {
          type: 'string',
          description: '替换后的新字符串'
        },
        replace_all: {
          type: 'boolean',
          description: '是否替换所有匹配项（默认 false，只替换第一个匹配项）',
          default: false
        }
      },
      required: ['file_path', 'old_string', 'new_string']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const { file_path, old_string, new_string, replace_all = false } = args;

    try {
      const toolPermission = ToolPolicyGateway.checkTool(this.definition.name, context);
      if (!toolPermission.allowed) {
        return `执行被阻止: ${toolPermission.reason}`;
      }

      // 解析文件路径
      const absolutePath = path.isAbsolute(file_path)
        ? file_path
        : path.join(context.workingDirectory, file_path);

      const pathPermission = ToolPolicyGateway.checkWritePath(absolutePath, context);
      if (!pathPermission.allowed) {
        return `执行被阻止: ${pathPermission.reason}`;
      }

      // 检查文件是否存在
      if (!fs.existsSync(absolutePath)) {
        return `错误：文件不存在: ${absolutePath}`;
      }

      // 读取文件内容
      const content = fs.readFileSync(absolutePath, 'utf-8');

      // 检查 old_string 是否存在
      if (!content.includes(old_string)) {
        return `错误：在文件中未找到要替换的字符串。\n文件: ${file_path}\n查找: ${old_string.substring(0, 100)}${old_string.length > 100 ? '...' : ''}`;
      }

      // 检查唯一性（如果不是 replace_all）
      if (!replace_all) {
        const occurrences = content.split(old_string).length - 1;
        if (occurrences > 1) {
          return `错误：找到 ${occurrences} 个匹配项，但 replace_all=false。\n请提供更具体的字符串以确保唯一性，或设置 replace_all=true 替换所有匹配项。\n文件: ${file_path}`;
        }
      }

      // 执行替换
      let newContent: string;
      let replacedCount: number;

      if (replace_all) {
        // 替换所有匹配项
        const occurrences = content.split(old_string).length - 1;
        newContent = content.split(old_string).join(new_string);
        replacedCount = occurrences;
      } else {
        // 只替换第一个匹配项
        newContent = content.replace(old_string, new_string);
        replacedCount = 1;
      }

      // 写入文件
      fs.writeFileSync(absolutePath, newContent, 'utf-8');

      // 计算变化
      const oldLines = content.split('\n').length;
      const newLines = newContent.split('\n').length;
      const lineDiff = newLines - oldLines;

      return `成功编辑文件: ${file_path}\n替换次数: ${replacedCount}\n原始行数: ${oldLines}\n新行数: ${newLines}${lineDiff !== 0 ? `\n行数变化: ${lineDiff > 0 ? '+' : ''}${lineDiff}` : ''}`;
    } catch (error: any) {
      return `编辑文件失败: ${error.message}`;
    }
  }
}
