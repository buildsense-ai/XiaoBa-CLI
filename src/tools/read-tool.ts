import * as fs from 'fs';
import * as path from 'path';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { isReadPathAllowed } from '../utils/safety';
import { createImageBlock } from '../utils/image-utils';

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
        },
        analysis_prompt: {
          type: 'string',
          description: '图片或附件读取时的用户问题/分析目标（可选）。如果不填，聊天平台会使用本轮用户文字。'
        }
      },
      required: ['file_path']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const { file_path, offset = 0, limit, pages, analysis_prompt } = args;

    // 解析文件路径
    const absolutePath = path.isAbsolute(file_path)
      ? file_path
      : path.join(context.workingDirectory, file_path);

    const pathPermission = isReadPathAllowed(absolutePath, context.workingDirectory);
    if (!pathPermission.allowed) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: `执行被阻止: ${pathPermission.reason}` };
    }

    // 检查文件是否存在
    if (!fs.existsSync(absolutePath)) {
      return { ok: false, errorCode: 'FILE_NOT_FOUND', message: `错误：文件不存在: ${absolutePath}` };
    }

    // 获取文件扩展名
    const ext = path.extname(absolutePath).toLowerCase();

    // 根据文件类型选择处理方式
    if (ext === '.pdf') {
      const content = this.readPDF(absolutePath, file_path, pages);
      return { ok: true, content };
    } else if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'].includes(ext)) {
      const currentAttachmentCheck = this.checkCurrentTurnImageAttachment(absolutePath, context);
      if (!currentAttachmentCheck.allowed) {
        return { ok: true, content: currentAttachmentCheck.message };
      }

      if (context.supportsDirectImageInput === false) {
        return {
          ok: true,
          content: this.buildImageReaderGuidance(
            absolutePath,
            file_path,
            String(analysis_prompt || context.currentUserText || '').trim(),
          ),
        };
      }

      const result = await this.readImage(absolutePath, file_path);
      // readImage 成功时会返回特殊对象表示图片消息
      if (result && typeof result === 'object' && '_imageForNewMessage' in result) {
        return {
          ok: true,
          content: result as unknown as string,
          // tool-manager 特殊处理：通过 content 结构中的 _imageForNewMessage 触发额外消息
        };
      }
      return { ok: true, content: result as string };
    } else if (ext === '.ipynb') {
      const content = await this.readNotebook(absolutePath, file_path);
      return { ok: true, content };
    } else {
      // 默认作为文本文件处理
      const content = this.readTextFile(absolutePath, file_path, offset, limit);
      return { ok: true, content };
    }
  }

  private readTextFile(absolutePath: string, file_path: string, offset: number, limit?: number): string {
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

  private readPDF(absolutePath: string, file_path: string, pages?: string): string {
    const stats = fs.statSync(absolutePath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    let result = `文件: ${file_path}\n类型: PDF\n大小: ${sizeMB} MB\n\n`;
    result += '当前 read_file 不再做 PDF 全文解析。\n';
    result += '建议使用以下流程获取高质量解析结果：\n';
    result += '1. 调用 paper_parser 提取结构化内容（MinerU）\n';
    result += '2. 调用 markdown_chunker 进行分章切块\n';
    result += '3. 或直接使用 /paper-analysis 技能执行完整精读流程';

    if (pages) {
      result += `\n\n已忽略 pages 参数: ${pages}`;
    }

    return result;
  }

  private async readImage(absolutePath: string, file_path: string): Promise<any> {
    const imageBlock = await createImageBlock(absolutePath);
    if (imageBlock) {
      return {
        _imageForNewMessage: true,
        imageBlock,
        filePath: file_path
      };
    }
    
    const stats = fs.statSync(absolutePath);
    const sizeKB = (stats.size / 1024).toFixed(2);
    return `文件: ${file_path}\n类型: 图片文件\n大小: ${sizeKB} KB\n\n无法读取图片（格式不支持或文件损坏）`;
  }

  private readNotebook(absolutePath: string, file_path: string): string {
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

  private checkCurrentTurnImageAttachment(
    absolutePath: string,
    context: ToolExecutionContext,
  ): { allowed: true } | { allowed: false; message: string } {
    const currentImages = (context.currentTurnAttachments || [])
      .filter(attachment => attachment.type === 'image');

    if (currentImages.length === 0) {
      return { allowed: true };
    }

    const normalizedTarget = this.normalizePath(absolutePath);
    const matched = currentImages.some(attachment => {
      return this.normalizePath(attachment.localPath) === normalizedTarget;
    });

    if (matched) {
      return { allowed: true };
    }

    const candidates = currentImages
      .map((attachment, index) => `${index + 1}. ${attachment.fileName}: ${attachment.localPath}`)
      .join('\n');

    return {
      allowed: false,
      message: [
        'The requested image is not one of the images attached in the current user turn.',
        'Do not analyze this file for the current question, because it may be an older image from conversation history.',
        '',
        'Use one of the current-turn image paths below instead:',
        candidates,
      ].join('\n'),
    };
  }

  private normalizePath(filePath: string): string {
    return path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
  }

  private buildImageReaderGuidance(absolutePath: string, file_path: string, userPrompt: string): string {
    const stats = fs.statSync(absolutePath);
    const sizeKB = (stats.size / 1024).toFixed(2);

    return [
      `文件: ${file_path}`,
      '类型: 图片文件',
      `大小: ${sizeKB} KB`,
      '',
      'This is the image attached in the current user turn.',
      userPrompt
        ? `Current user text / analysis prompt: ${userPrompt}`
        : 'Current user text / analysis prompt: [none]',
      '',
      'read_file can confirm the file and path, but it cannot decode image pixels for this non-vision primary model.',
      'Do not guess from the file name, old images, or prior conversation context.',
      'If the answer depends on this image, the next step MUST be a native tool call to the `skill` tool. Do not call any reader Python script directly from execute_shell.',
      'Recommended tool call:',
      JSON.stringify({
        skill: 'vision-analysis',
        args: `${absolutePath}${userPrompt ? ` ${userPrompt}` : ''}`,
      }),
      'After the skill is activated, follow that skill guidance to run the reader script and answer from the reader result plus the current user text.',
    ].join('\n');
  }

}
