import * as fs from 'fs';
import * as path from 'path';
import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';

/**
 * Read 工具 - 读取文件内容
 */
export class ReadTool implements Tool {
  definition: ToolDefinition = {
    name: 'read_file',
    description: '读取文件内容。支持文本文件、代码文件、PDF、图片、Jupyter notebook 等多种格式。',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '要读取的文件路径（绝对路径或相对于工作目录的路径）'
        },
        offset: {
          type: 'number',
          description: '从第几行开始读取（可选，默认从第1行开始，仅适用于文本文件）'
        },
        limit: {
          type: 'number',
          description: '读取多少行（可选，默认读取全部，仅适用于文本文件）'
        },
        pages: {
          type: 'string',
          description: 'PDF 文件的页码范围，如 "1-5" 或 "3"（仅适用于 PDF 文件）'
        }
      },
      required: ['file_path']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const { file_path, offset = 0, limit, pages } = args;

    try {
      // 解析文件路径
      const absolutePath = path.isAbsolute(file_path)
        ? file_path
        : path.join(context.workingDirectory, file_path);

      // 检查文件是否存在
      if (!fs.existsSync(absolutePath)) {
        return `错误：文件不存在: ${absolutePath}`;
      }

      // 获取文件扩展名
      const ext = path.extname(absolutePath).toLowerCase();

      // 根据文件类型选择处理方式
      if (ext === '.pdf') {
        return await this.readPDF(absolutePath, file_path, pages);
      } else if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'].includes(ext)) {
        return await this.readImage(absolutePath, file_path);
      } else if (ext === '.ipynb') {
        return await this.readNotebook(absolutePath, file_path);
      } else {
        // 默认作为文本文件处理
        return await this.readTextFile(absolutePath, file_path, offset, limit);
      }
    } catch (error: any) {
      return `读取文件失败: ${error.message}`;
    }
  }

  private async readTextFile(absolutePath: string, file_path: string, offset: number, limit?: number): Promise<string> {
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
  }

  private async readPDF(absolutePath: string, file_path: string, pages?: string): Promise<string> {
    try {
      // 尝试导入 pdf-parse
      const pdfParse = require('pdf-parse');
      const dataBuffer = fs.readFileSync(absolutePath);
      const data = await pdfParse(dataBuffer);

      let result = `文件: ${file_path}\nPDF 总页数: ${data.numpages}\n\n`;

      if (pages) {
        // 解析页码范围
        const pageRange = this.parsePageRange(pages, data.numpages);
        result += `显示页码: ${pages}\n\n`;
        result += `注意：完整的 PDF 文本提取需要更复杂的处理。当前显示全部文本内容。\n\n`;
      }

      result += `文本内容:\n${data.text}`;
      return result;
    } catch (error: any) {
      if (error.code === 'MODULE_NOT_FOUND') {
        return `错误：需要安装 pdf-parse 包才能读取 PDF 文件。\n运行: npm install pdf-parse`;
      }
      throw error;
    }
  }

  private async readImage(absolutePath: string, file_path: string): Promise<string> {
    const stats = fs.statSync(absolutePath);
    const sizeKB = (stats.size / 1024).toFixed(2);

    return `文件: ${file_path}\n类型: 图片文件\n大小: ${sizeKB} KB\n\n注意：图片文件无法直接显示文本内容。\n建议：\n1. 如果需要分析图片内容，请使用支持视觉的 AI 模型\n2. 如果需要提取图片中的文字，请使用 OCR 工具\n3. 图片路径: ${absolutePath}`;
  }

  private async readNotebook(absolutePath: string, file_path: string): Promise<string> {
    const content = fs.readFileSync(absolutePath, 'utf-8');
    const notebook = JSON.parse(content);

    let result = `文件: ${file_path}\nJupyter Notebook\n单元格数量: ${notebook.cells?.length || 0}\n\n`;

    if (notebook.cells && Array.isArray(notebook.cells)) {
      notebook.cells.forEach((cell: any, index: number) => {
        result += `\n=== Cell ${index + 1} (${cell.cell_type}) ===\n`;

        if (cell.source) {
          const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
          result += source + '\n';
        }

        // 显示输出（如果有）
        if (cell.outputs && Array.isArray(cell.outputs) && cell.outputs.length > 0) {
          result += '\n--- Output ---\n';
          cell.outputs.forEach((output: any) => {
            if (output.text) {
              const text = Array.isArray(output.text) ? output.text.join('') : output.text;
              result += text + '\n';
            } else if (output.data && output.data['text/plain']) {
              const text = Array.isArray(output.data['text/plain'])
                ? output.data['text/plain'].join('')
                : output.data['text/plain'];
              result += text + '\n';
            }
          });
        }
      });
    }

    return result;
  }

  private parsePageRange(pages: string, totalPages: number): number[] {
    // 简单的页码范围解析，如 "1-5" 或 "3"
    if (pages.includes('-')) {
      const [start, end] = pages.split('-').map(p => parseInt(p.trim()));
      return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    } else {
      return [parseInt(pages.trim())];
    }
  }
}
