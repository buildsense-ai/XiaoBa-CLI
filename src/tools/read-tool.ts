import * as fs from 'fs';
import * as path from 'path';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { isReadPathAllowed } from '../utils/safety';
import { createImageBlock } from '../utils/image-utils';
import { ConfigManager } from '../utils/config';
import { isPrimaryModelVisionCapable } from '../utils/model-capabilities';
import { analyzeImageWithReaderProxy } from '../utils/reader-proxy';

/**
 * Read tool - reads local files and returns content to the model.
 */
export class ReadTool implements Tool {
  definition: ToolDefinition = {
    name: 'read_file',
    description: [
      '读取文件内容，支持文本、代码、PDF、图片和 Jupyter notebook。',
      '读取图片时：如果当前主模型支持多模态，会直接把图片附加给模型；如果不支持，会自动调用 Cats reader proxy 解析图片并返回文字结果。',
      '不要再调用 advanced-reader 或 vision-analysis skill 来读图片，图片统一走 read_file。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '要读取的文件路径，可以是绝对路径，也可以是相对当前工作目录的路径。',
        },
        offset: {
          type: 'number',
          description: '从第几行开始读取，默认从第 1 行开始，仅适用于文本文件。',
        },
        limit: {
          type: 'number',
          description: '最多读取多少行，仅适用于文本文件。',
        },
        pages: {
          type: 'string',
          description: 'PDF 页码范围，例如 "1-5" 或 "3"。当前 read_file 仅记录该参数，不做 PDF 全文解析。',
        },
        prompt: {
          type: 'string',
          description: '可选。读取图片时的分析目标；不传时会自动使用当前用户消息。',
        },
      },
      required: ['file_path'],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const { file_path, offset = 0, limit, pages, prompt, analysis_prompt } = args;

    const absolutePath = path.isAbsolute(file_path)
      ? file_path
      : path.join(context.workingDirectory, file_path);

    const pathPermission = isReadPathAllowed(absolutePath, context.workingDirectory);
    if (!pathPermission.allowed) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: `执行被阻止: ${pathPermission.reason}` };
    }

    if (!fs.existsSync(absolutePath)) {
      return { ok: false, errorCode: 'FILE_NOT_FOUND', message: `错误：文件不存在: ${absolutePath}` };
    }

    const ext = path.extname(absolutePath).toLowerCase();

    if (ext === '.pdf') {
      const content = this.readPDF(absolutePath, file_path, pages);
      return { ok: true, content };
    }

    if (this.isImageExt(ext)) {
      const content = await this.readImage(absolutePath, file_path, context, prompt || analysis_prompt);
      return { ok: true, content: content as any };
    }

    if (ext === '.ipynb') {
      const content = this.readNotebook(absolutePath, file_path);
      return { ok: true, content };
    }

    const content = this.readTextFile(absolutePath, file_path, offset, limit);
    return { ok: true, content };
  }

  private readTextFile(absolutePath: string, filePath: string, offset: number, limit?: number): string {
    const content = fs.readFileSync(absolutePath, 'utf-8');
    const lines = content.split('\n');
    const startLine = Math.max(0, Number(offset) || 0);
    const endLine = limit ? startLine + Number(limit) : lines.length;
    const selectedLines = lines.slice(startLine, endLine);

    const formattedLines = selectedLines.map((line, index) => {
      const lineNumber = startLine + index + 1;
      return `${lineNumber.toString().padStart(5, ' ')}→ ${line}`;
    });

    return [
      `文件: ${filePath}`,
      `总行数: ${lines.length}`,
      `显示: ${startLine + 1}-${Math.min(endLine, lines.length)}`,
      '',
      formattedLines.join('\n'),
    ].join('\n');
  }

  private readPDF(absolutePath: string, filePath: string, pages?: string): string {
    const stats = fs.statSync(absolutePath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    const lines = [
      `文件: ${filePath}`,
      '类型: PDF',
      `大小: ${sizeMB} MB`,
      '',
      '当前 read_file 不再做 PDF 全文解析。',
      '建议使用 shell 中可用的文档解析库、系统工具，或后续新增专门文档解析工具。',
    ];

    if (pages) {
      lines.push('', `已忽略 pages 参数: ${pages}`);
    }

    return lines.join('\n');
  }

  private isImageExt(ext: string): boolean {
    return ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'].includes(ext);
  }

  private getLatestUserText(context: ToolExecutionContext): string {
    for (let i = context.conversationHistory.length - 1; i >= 0; i--) {
      const message = context.conversationHistory[i];
      if (!message || message.role !== 'user') continue;

      if (typeof message.content === 'string') {
        const text = message.content.trim();
        if (text) return text;
      }

      if (Array.isArray(message.content)) {
        const text = message.content
          .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
          .map((block: any) => block.text.trim())
          .filter(Boolean)
          .join('\n')
          .trim();
        if (text) return text;
      }
    }

    return '';
  }

  private getImageReadPrompt(context: ToolExecutionContext, prompt?: string): string {
    const explicit = typeof prompt === 'string' ? prompt.trim() : '';
    return explicit || this.getLatestUserText(context);
  }

  private formatImageMetadata(absolutePath: string, filePath: string): string {
    const stats = fs.statSync(absolutePath);
    const sizeKB = (stats.size / 1024).toFixed(2);
    return [`文件: ${filePath}`, '类型: 图片文件', `大小: ${sizeKB} KB`].join('\n');
  }

  private async readImage(
    absolutePath: string,
    filePath: string,
    context: ToolExecutionContext,
    prompt?: string,
  ): Promise<any> {
    const config = ConfigManager.getConfigReadonly();
    const imagePrompt = this.getImageReadPrompt(context, prompt);
    const visionCapable = isPrimaryModelVisionCapable(config);

    if (visionCapable) {
      const imageBlock = await createImageBlock(absolutePath);
      if (imageBlock) {
        return {
          _imageForNewMessage: true,
          imageBlock,
          filePath,
        };
      }
    }

    const proxyResult = await analyzeImageWithReaderProxy({
      filePath: absolutePath,
      prompt: imagePrompt,
      config,
    });

    if (proxyResult.ok && proxyResult.analysis) {
      return [
        this.formatImageMetadata(absolutePath, filePath),
        '',
        visionCapable
          ? '主模型图片块生成失败，已自动改用 Cats reader proxy 解析：'
          : '读图结果（由 Cats reader proxy 解析，已作为 read_file 结果返回给当前非多模态主模型）：',
        proxyResult.analysis,
      ].join('\n');
    }

    return [
      this.formatImageMetadata(absolutePath, filePath),
      '',
      visionCapable
        ? '无法生成图片输入，也无法调用 Cats reader proxy 完成解析。'
        : '当前主模型不能直接读取图片内容，且 Cats reader proxy 调用失败。',
      `失败原因: ${proxyResult.error || 'unknown error'}`,
      '请检查 CatsCo API Key / Reader Proxy 配置或网络后重试。',
    ].join('\n');
  }

  private readNotebook(absolutePath: string, filePath: string): string {
    const content = fs.readFileSync(absolutePath, 'utf-8');
    const notebook = JSON.parse(content);

    let result = `文件: ${filePath}\nJupyter Notebook\n单元格数量: ${notebook.cells?.length || 0}\n\n`;

    if (notebook.cells && Array.isArray(notebook.cells)) {
      notebook.cells.forEach((cell: any, index: number) => {
        result += `\n=== Cell ${index + 1} (${cell.cell_type}) ===\n`;

        if (cell.source) {
          const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
          result += source + '\n';
        }

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
}
