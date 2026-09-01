import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { execFileSync } from 'child_process';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { ContentBlock } from '../types';
import { isReadPathAllowed } from '../utils/safety';
import { validateReadToolArgs } from '../utils/input-validation';
import { createImageBlock } from '../utils/image-utils';
import { ConfigManager } from '../utils/config';
import { resolvePrimaryModelVisionCapability } from '../utils/model-capabilities';
import { analyzeImageWithReaderProxy, ReaderProxyResult } from '../utils/reader-proxy';
import { analyzeImageWithVisionFallback } from '../utils/vision-fallback-provider';
import { Logger } from '../utils/logger';
import { formatPathForLog } from '../utils/log-redaction';
import { resolveLocalFileAccess, resolveLocalFileReference } from './local-file-gateway';
import { formatCatsCoVisiblePath } from './tool-gateway';
import { executeRouteIfRemote, resolveExecutionRoute, targetParameterDescription } from './execution-router';
import { importRemoteFileToAgentWorkspace } from './import-file-tool';

export const DEFAULT_TEXT_READ_LIMIT = 200;
export const MAX_TEXT_READ_LIMIT = 2000;
export const MAX_TEXT_READ_BYTES = 256 * 1024;
export const DEFAULT_PDF_READ_PAGES = 10;
export const MAX_PDF_READ_PAGES = 30;
export const MAX_PDF_READ_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_OUTPUT_BYTES = 192 * 1024;
export const DEFAULT_PDF_IMAGE_FALLBACK_PAGES = 3;
export const MAX_PDF_IMAGE_FALLBACK_PAGES = 5;
const MAX_PDF_RENDER_PIXELS = 4_000_000;
const DEFAULT_PDF_RENDER_SCALE = 1.75;
const PDF_VISUAL_INTENT_PATTERNS = [
  /图片|图像|照片|截图|扫描|扫描件|影印|拍照/,
  /签名|签字|手写|字迹|笔迹|批注/,
  /印章|盖章|公章|章印|红章|骑缝章/,
  /版式|布局|排版|页面结构|格式|样式|颜色|表格|图表|流程图/,
  /试卷|答题卡|作业|批改|卷面/,
  /\b(image|photo|picture|screenshot|scan|scanned|signature|handwriting|stamp|seal|layout|table|chart|diagram|visual)\b/i,
];

interface PdfParseOptions {
  max?: number;
  version?: string;
  pagerender?: (pageData: any) => Promise<string>;
}

interface PdfParseResult {
  numpages?: number;
  numrender?: number;
  text?: string;
  info?: Record<string, unknown>;
}

type PdfParse = (dataBuffer: Buffer, options?: PdfParseOptions) => Promise<PdfParseResult>;
const pdfParse: PdfParse = require('pdf-parse');

interface TextReadOptions {
  offset?: unknown;
  limit?: unknown;
}

interface NormalizedTextReadOptions {
  startLine: number;
  lineLimit?: number;
  requestedLimit?: number;
  isDefaultLimit: boolean;
  isUnlimitedRequest: boolean;
  limitWasCapped: boolean;
}

interface TextReadResult {
  lines: string[];
  totalLines: number;
  totalLinesKnown: boolean;
  readLines: number;
  startLine: number;
  endLine: number;
  reachedLineLimit: boolean;
  reachedByteLimit: boolean;
  limitWasCapped: boolean;
  isDefaultLimit: boolean;
  isUnlimitedRequest: boolean;
  requestedLimit?: number;
  nextOffset?: number;
}

interface PdfPageSelection {
  label: string;
  maxPageToRender: number;
  selectedPages?: Set<number>;
  warnings: string[];
}

interface RenderedPdfPage {
  pageNumber: number;
  imagePath: string;
  renderer: 'pdfjs' | 'pdftoppm';
}

interface PdfCanvasAndContext {
  canvas: any;
  context: any;
}

interface ReadImageOptions {
  metadataType?: string;
  proxyIntro?: string;
}

interface PdfRenderedImageReadOptions {
  reason: 'missing_text' | 'parse_failed' | 'visual_supplement';
  totalPages?: number;
}

/**
 * Dynamic import helper for runtime module loading.
 * 
 * This function is used to dynamically import modules at runtime (e.g., pdfjs-dist).
 * Using a helper function instead of inline dynamic imports allows for better error
 * handling and caching of the imported modules.
 * 
 * Note: We use a wrapper instead of direct `import()` calls to:
 * 1. Allow centralized error handling and fallback logic
 * 2. Enable module caching for performance
 * 3. Provide clear logging when module loading fails
 */
type DynamicImport = (specifier: string) => Promise<any>;
async function dynamicImportModule(specifier: string): Promise<any> {
  return import(specifier);
}
const dynamicImport: DynamicImport = dynamicImportModule;

/**
 * Read tool - reads local files and returns content to the model.
 */
export class ReadTool implements Tool {
  definition: ToolDefinition = {
    name: 'read_file',
    description: [
      '读取一个本地文件。CatsCo 附件请优先使用消息中显示的本地缓存路径。',
      '通常先用 glob 定位候选路径，或用 grep 找到包含目标内容的文件，再读取具体文件。',
      '支持文本/代码、PDF、图片和 Jupyter notebook。文本默认只读前若干行，可用 offset/limit 分页。',
      'PDF 会先提取文本层；如果文本层为空、解析失败，或用户明显关心图片/签章/手写/版式等视觉内容，会自动把少量页面转成图片并走读图链路。',
      '读取聊天参与者电脑上的图片或 PDF 时，工具会先将原文件导入 XiaoBa 本机，再由当前 agent 在本机处理。',
        'catsco_attachment:<id> 仅用于兼容当前轮旧附件引用；后续追问应使用历史消息里的本地缓存路径。',
        '图片会按当前模型能力处理：视觉模型收到图片块，非视觉模型收到 reader proxy 的文字解析结果。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '要读取的文件路径。支持绝对路径、相对当前目录路径；CatsCo 附件优先使用消息中的本地缓存路径，catsco_attachment:<id> 仅作旧引用兼容。',
        },
        offset: {
          type: 'number',
          description: '从第几行开始读取，1-based，默认从第 1 行开始，仅适用于文本文件。',
        },
        limit: {
          type: 'number',
          description: `最多读取多少行，仅适用于文本文件。默认 ${DEFAULT_TEXT_READ_LIMIT} 行；设为 0 表示尝试读取全文，但仍受输出字节上限保护。`,
        },
        pages: {
          type: 'string',
          description: 'PDF 页码范围，例如 "1-5" 或 "3"。仅适用于 PDF。',
        },
        prompt: {
          type: 'string',
          description: '可选。读取图片时的分析目标；不传则使用当前用户请求作为分析目标。',
        },
        target: targetParameterDescription(),
      },
      required: ['file_path'],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const { file_path, offset, limit, pages, prompt, analysis_prompt } = args;

    // Validate input arguments
    const validation = validateReadToolArgs(args);
    if (!validation.valid) {
      return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: `输入验证失败: ${validation.error}` };
    }

    if (!file_path || typeof file_path !== 'string') {
      return { ok: false, errorCode: 'TOOL_EXECUTION_ERROR', message: '文件路径不能为空' };
    }

    let absolutePath: string;
    let displayPath = file_path;
    let visiblePath: string;
    let visibleInputPath = file_path;
    let resolvedFromAttachmentRef = false;
    let authorizedByLocalFileGrant = false;

    const reference = resolveLocalFileReference(context, {
      operation: 'read_file',
      inputPath: file_path,
    });
    if (reference.matched) {
      if (!reference.ok) {
        return {
          ok: false,
          errorCode: reference.errorCode,
          message: reference.message,
        };
      }
      absolutePath = reference.absolutePath;
      displayPath = reference.displayPath;
      visiblePath = reference.displayPath;
      visibleInputPath = reference.displayPath;
      resolvedFromAttachmentRef = true;
      authorizedByLocalFileGrant = true;
    } else {
      absolutePath = path.isAbsolute(file_path)
        ? file_path
        : path.join(context.workingDirectory, file_path);
      visiblePath = absolutePath;
    }

    if (!resolvedFromAttachmentRef) {
      const localAccess = resolveLocalFileAccess(context, {
        operation: 'read_file',
        absolutePath,
      });
      if (!localAccess.ok) {
        return {
          ok: false,
          errorCode: localAccess.errorCode,
          message: localAccess.message,
        };
      }
      if (localAccess.displayPath) {
        displayPath = localAccess.displayPath;
        visiblePath = localAccess.displayPath;
        visibleInputPath = localAccess.displayPath;
      }
      authorizedByLocalFileGrant = Boolean(localAccess.grant);
    }

    if (!authorizedByLocalFileGrant) {
      const route = resolveExecutionRoute(context, {
        toolName: this.definition.name,
        operation: 'read_file',
        target: args.target,
      });
      if (!route.ok) {
        return {
          ok: false,
          errorCode: route.errorCode,
          message: route.message,
        };
      }

      if (route.mode === 'remote' && this.shouldImportRemoteMedia(file_path)) {
        return this.readImportedRemoteMedia(args, context);
      }

      const remoteResult = await executeRouteIfRemote(context, route, 'read_file', 'read_file', args);
      if (remoteResult) return remoteResult;

      const pathPermission = isReadPathAllowed(absolutePath, context.workingDirectory);
      if (!pathPermission.allowed) {
        return { ok: false, errorCode: 'PERMISSION_DENIED', message: `执行被阻止: ${pathPermission.reason}` };
      }
      displayPath = formatCatsCoVisiblePath(context, displayPath, { preserveRelative: true });
      visiblePath = displayPath;
      visibleInputPath = displayPath;
    }

    const ext = path.extname(absolutePath).toLowerCase();
    if (ext === '.pdf') {
      return this.readPdf(absolutePath, { pages, displayPath, visibleInputPath, authorizedByLocalFileGrant }, context);
    } else if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'].includes(ext)) {
      return this.readImage(absolutePath, { displayPath, visibleInputPath, authorizedByLocalFileGrant, prompt: prompt || analysis_prompt }, context);
    } else if (ext === '.ipynb') {
      return this.readNotebook(absolutePath, { displayPath, visibleInputPath, authorizedByLocalFileGrant }, context);
    } else {
      return this.readText(absolutePath, { offset, limit, displayPath, visibleInputPath, authorizedByLocalFileGrant }, context);
    }
  }

  private shouldImportRemoteMedia(filePath: string): boolean {
    return filePath.startsWith('catsco_attachment:') || filePath.startsWith('http://') || filePath.startsWith('https://');
  }

  private async readImportedRemoteMedia(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      const result = await importRemoteFileToAgentWorkspace(args, context);
      if (!result.ok) {
        return result;
      }
      const localPath = result.file_path;
      return this.readFileWithPath(localPath, args, context);
    } catch (error) {
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: `导入远程文件失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async readFileWithPath(absolutePath: string, args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const { pages, prompt, analysis_prompt } = args;
    const ext = path.extname(absolutePath).toLowerCase();
    const displayPath = absolutePath;
    const visibleInputPath = absolutePath;

    if (ext === '.pdf') {
      return this.readPdf(absolutePath, { pages, displayPath, visibleInputPath, authorizedByLocalFileGrant: true }, context);
    } else if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'].includes(ext)) {
      return this.readImage(absolutePath, { displayPath, visibleInputPath, authorizedByLocalFileGrant: true, prompt: prompt || analysis_prompt }, context);
    } else if (ext === '.ipynb') {
      return this.readNotebook(absolutePath, { displayPath, visibleInputPath, authorizedByLocalFileGrant: true }, context);
    } else {
      return this.readText(absolutePath, { offset: args.offset, limit: args.limit, displayPath, visibleInputPath, authorizedByLocalFileGrant: true }, context);
    }
  }

  private async readText(filePath: string, options: {
    offset?: unknown;
    limit?: unknown;
    displayPath: string;
    visibleInputPath: string;
    authorizedByLocalFileGrant: boolean;
  }, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const { offset, limit, displayPath, visibleInputPath, authorizedByLocalFileGrant } = options;
    const normalized = this.normalizeTextReadOptions(offset, limit);
    const { startLine, lineLimit, isUnlimitedRequest } = normalized;

    let fd: number;
    try {
      fd = fs.openSync(filePath, 'r');
    } catch (err) {
      return {
        ok: false,
        errorCode: 'FILE_NOT_FOUND',
        message: `无法读取文件 ${formatPathForLog(displayPath)}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let totalLines = 0;
    let readLines = 0;
    let reachedByteLimit = false;
    let outputBytes = 0;
    const MAX_OUTPUT_BYTES = 1024 * 512;
    const lines: string[] = [];
    let reachedLineLimit = false;
    let nextOffset: number | undefined;

    try {
      const stats = fs.fstatSync(fd);
      const fileSize = stats.size;

      if (isUnlimitedRequest) {
        let lineStart = 0;
        let lineNumber = 0;
        const lineOffsets: number[] = [0];
        const buffer = Buffer.alloc(64 * 1024);
        let bytesRead: number;

        while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, lineStart)) > 0) {
          for (let i = 0; i < bytesRead; i++) {
            if (buffer[i] === 10) {
              lineNumber++;
              lineOffsets.push(lineStart + i + 1);
            }
          }
          lineStart += bytesRead;
        }
        totalLines = lineNumber + 1;

        if (lineOffsets.length <= startLine) {
          return {
            ok: true,
            content: [{ type: 'text', text: '请求的行号超出文件范围' }],
            displayPath,
            visibleInputPath,
            metadata: {
              totalLines,
              totalLinesKnown: true,
              readLines: 0,
              startLine,
              endLine: startLine,
              reachedLineLimit: true,
              reachedByteLimit: false,
              limitWasCapped: false,
              isDefaultLimit: false,
              isUnlimitedRequest: false,
            },
          };
        }

        const readStart = lineOffsets[startLine];
        const rawBytes = Buffer.alloc(fileSize - readStart);
        fs.readSync(fd, rawBytes, 0, rawBytes.length, readStart);
        const content = rawBytes.toString('utf-8');

        return {
          ok: true,
          content: [{ type: 'text', text: content }],
          displayPath,
          visibleInputPath,
          metadata: {
            totalLines,
            totalLinesKnown: true,
            readLines: totalLines - startLine,
            startLine,
            endLine: totalLines,
            reachedLineLimit: true,
            reachedByteLimit: false,
            limitWasCapped: false,
            isDefaultLimit: false,
            isUnlimitedRequest: false,
          },
        };
      }

      const rl = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: 'utf-8', start: 0 }),
        crlfDelay: Infinity,
      });

      let lineNumber = 0;
      for await (const line of rl) {
        lineNumber++;
        if (lineNumber < startLine) continue;

        const lineBytes = Buffer.byteLength(line, 'utf-8');
        if (outputBytes + lineBytes > MAX_OUTPUT_BYTES) {
          reachedByteLimit = true;
          break;
        }

        lines.push(line);
        outputBytes += lineBytes;
        readLines++;

        if (lineLimit !== undefined && readLines >= lineLimit) {
          reachedLineLimit = true;
          nextOffset = startLine + readLines;
          break;
        }
      }

      totalLines = lineNumber;
      const endLine = startLine + readLines - 1;
      const totalLinesKnown = !rl.line;

      return {
        ok: true,
        content: [{ type: 'text', text: lines.join('\n') }],
        displayPath,
        visibleInputPath,
        metadata: {
          totalLines,
          totalLinesKnown,
          readLines,
          startLine,
          endLine: readLines > 0 ? endLine : startLine,
          reachedLineLimit,
          reachedByteLimit,
          limitWasCapped: normalized.limitWasCapped,
          isDefaultLimit: normalized.isDefaultLimit,
          isUnlimitedRequest: normalized.isUnlimitedRequest,
          requestedLimit: normalized.requestedLimit,
          nextOffset,
        },
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  private normalizeTextReadOptions(offset?: unknown, limit?: unknown): NormalizedTextReadOptions {
    const startLine = typeof offset === 'number' && offset > 0 ? offset : 1;
    let lineLimit: number | undefined;
    let limitWasCapped = false;
    let isDefaultLimit = false;
    let isUnlimitedRequest = false;
    let requestedLimit: number | undefined;

    if (typeof limit === 'number') {
      if (limit === 0) {
        isUnlimitedRequest = true;
      } else {
        requestedLimit = limit;
        lineLimit = Math.min(limit, MAX_TEXT_READ_LIMIT);
        limitWasCapped = lineLimit < limit;
      }
    } else {
      lineLimit = DEFAULT_TEXT_READ_LIMIT;
      isDefaultLimit = true;
    }

    return { startLine, lineLimit, requestedLimit, isDefaultLimit, isUnlimitedRequest, limitWasCapped };
  }

  private async readPdf(filePath: string, options: {
    pages?: string;
    displayPath: string;
    visibleInputPath: string;
    authorizedByLocalFileGrant: boolean;
  }, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const { pages, displayPath, visibleInputPath, authorizedByLocalFileGrant } = options;
    const selection = this.parsePageSelection(pages);
    const textContent = await this.extractPdfText(filePath, selection);
    const textAvailable = Boolean(textContent?.text?.trim());
    const lowTextDensity = textAvailable && textContent.text.length < 100;

    const promptText = context.userMessage || '';
    const hasVisualIntent = PDF_VISUAL_INTENT_PATTERNS.some((pattern) => pattern.test(promptText));
    const shouldFallbackToImage = !textAvailable || lowTextDensity || hasVisualIntent;

    if (shouldFallbackToImage) {
      const pagesToRender = this.determinePdfFallbackPages(selection, textContent);
      const imageResults = await this.renderPdfPagesToImages(filePath, pagesToRender, context);
      const reason: 'missing_text' | 'parse_failed' | 'visual_supplement' =
        !textAvailable ? 'missing_text' : lowTextDensity ? 'parse_failed' : 'visual_supplement';

      const visionCapability = resolvePrimaryModelVisionCapability(context.modelId);
      const blocks: ContentBlock[] = [];

      for (const page of imageResults) {
        blocks.push(...(await this.readImage(page.imagePath, {
          displayPath: `${displayPath} (第 ${page.pageNumber} 页)`,
          visibleInputPath: `${visibleInputPath} (第 ${page.pageNumber} 页)`,
          authorizedByLocalFileGrant,
          metadataType: 'pdf',
          proxyIntro: `以下是 PDF "${path.basename(filePath)}" 第 ${page.pageNumber} 页的图片转录：`,
        }, context, { reason, totalPages: textContent.numpages })).content);
      }

      return {
        ok: true,
        content: blocks,
        displayPath,
        visibleInputPath,
        metadata: {
          reason,
          totalPages: textContent.numpages,
          renderedPages: imageResults.map((p) => p.pageNumber),
          textExtracted: textAvailable,
        },
      };
    }

    return {
      ok: true,
      content: [{ type: 'text', text: textContent.text }],
      displayPath,
      visibleInputPath,
      metadata: {
        totalPages: textContent.numpages,
        textExtracted: true,
      },
    };
  }

  private parsePageSelection(pagesSpec?: string): PdfPageSelection {
    const warnings: string[] = [];
    let selectedPages: Set<number> | undefined;
    let maxPageToRender = DEFAULT_PDF_READ_PAGES;

    if (pagesSpec) {
      const numbers: number[] = [];
      const parts = pagesSpec.split(',');
      for (const part of parts) {
        const trimmed = part.trim();
        const rangeMatch = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
        if (rangeMatch) {
          const start = parseInt(rangeMatch[1], 10);
          const end = parseInt(rangeMatch[2], 10);
          if (start <= end) {
            for (let i = start; i <= end; i++) numbers.push(i);
          }
        } else if (/^\d+$/.test(trimmed)) {
          numbers.push(parseInt(trimmed, 10));
        } else {
          warnings.push(`无法解析页码范围: ${trimmed}`);
        }
      }

      if (numbers.length > 0) {
        selectedPages = new Set(numbers);
        maxPageToRender = Math.min(numbers.length, MAX_PDF_READ_PAGES);
      }
    }

    return {
      label: pagesSpec || 'all',
      maxPageToRender,
      selectedPages,
      warnings,
    };
  }

  private async extractPdfText(filePath: string, selection: PdfPageSelection): Promise<PdfParseResult> {
    try {
      const dataBuffer = fs.readFileSync(filePath);
      if (dataBuffer.length > MAX_PDF_READ_BYTES) {
        return { text: `[PDF 文件过大 (${(dataBuffer.length / 1024 / 1024).toFixed(1)} MB)，仅显示前 ${MAX_PDF_READ_PAGES} 页]`, numpages: 0 };
      }

      const options: PdfParseOptions = {};
      if (selection.selectedPages) {
        const pages = Array.from(selection.selectedPages).slice(0, selection.maxPageToRender);
        if (pages.length > 0) {
          options.max = Math.max(...pages);
          options.pagerender = (pageData: any) => {
            if (pages.includes(pageData.pageInfo.pageIndex + 1)) {
              return pageData.getTextContent().then((content: any) => content.items.map((item: any) => item.str).join(' '));
            }
            return Promise.resolve('');
          };
        }
      } else {
        options.max = selection.maxPageToRender;
      }

      return await pdfParse(dataBuffer, options);
    } catch (error) {
      return { text: '', numpages: 0 };
    }
  }

  private determinePdfFallbackPages(selection: PdfPageSelection, textContent: PdfParseResult): number[] {
    if (selection.selectedPages) {
      return Array.from(selection.selectedPages).slice(0, DEFAULT_PDF_IMAGE_FALLBACK_PAGES);
    }
    const totalPages = textContent.numpages || 1;
    const maxPages = Math.min(totalPages, DEFAULT_PDF_IMAGE_FALLBACK_PAGES);
    return Array.from({ length: maxPages }, (_, i) => i + 1);
  }

  private async renderPdfPagesToImages(filePath: string, pageNumbers: number[], context: ToolExecutionContext): Promise<RenderedPdfPage[]> {
    const results: RenderedPdfPage[] = [];
    const tempDir = path.join(os.tmpdir(), `xiaoba-pdf-${Date.now()}`);

    try {
      fs.mkdirSync(tempDir, { recursive: true });
    } catch {
      return results;
    }

    for (const pageNumber of pageNumbers) {
      const imagePath = path.join(tempDir, `page-${pageNumber}.png`);

      if (await this.tryRenderWithPdfjs(filePath, pageNumber, imagePath, context)) {
        results.push({ pageNumber, imagePath, renderer: 'pdfjs' });
        continue;
      }

      if (await this.tryRenderWithPdftoppm(filePath, pageNumber, imagePath)) {
        results.push({ pageNumber, imagePath, renderer: 'pdftoppm' });
        continue;
      }

      const fallbackPath = path.join(tempDir, `page-${pageNumber}-fallback.png`);
      const fallbackSuccess = await this.tryRenderWithPdftoppm(filePath, pageNumber, fallbackPath) ||
        await this.tryRenderWithPdfjs(filePath, pageNumber, fallbackPath, context);

      if (fallbackSuccess) {
        results.push({ pageNumber, imagePath: fallbackPath, renderer: 'pdftoppm' });
      }
    }

    return results;
  }

  private async tryRenderWithPdfjs(filePath: string, pageNumber: number, outputPath: string, context: ToolExecutionContext): Promise<boolean> {
    try {
      const pdfjsLib = await dynamicImport('pdfjs-dist');
      const pdfjsWorker = await dynamicImport('pdfjs-dist/build/pdf.worker.min.mjs');
      pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker.default?.url || pdfjsWorker;

      const data = new Uint8Array(fs.readFileSync(filePath));
      const loadingTask = pdfjsLib.getDocument({ data });
      const pdf = await loadingTask.promise;
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: DEFAULT_PDF_RENDER_SCALE });

      if (viewport.width * viewport.height > MAX_PDF_RENDER_PIXELS) {
        const scale = Math.sqrt(MAX_PDF_RENDER_PIXELS / (viewport.width * viewport.height));
        viewport.scale(scale);
      }

      const canvas = (pdfjsLib as any).createElement('canvas');
      // @ts-expect-error - Canvas API is standard, TypeScript definitions may not cover all environments
      const ctx = canvas.getContext('2d');
      canvas.width = viewport.width;
      canvas.height = viewport.height;

      await page.render({ canvasContext: ctx, viewport }).promise;
      fs.writeFileSync(outputPath, canvas.toBuffer ? canvas.toBuffer('image/png') : Buffer.from(canvas.toDataURL('image/png').split(',')[1], 'base64'));

      return true;
    } catch (error) {
      return false;
    }
  }

  private async tryRenderWithPdftoppm(filePath: string, pageNumber: number, outputPath: string): Promise<boolean> {
    try {
      execFileSync('pdftoppm', ['-png', '-f', String(pageNumber), '-l', String(pageNumber), '-r', '150', filePath, outputPath.replace('.png', '')], { stdio: 'ignore' });
      const actualPath = `${outputPath.replace('.png', '')}-${pageNumber}.png`;
      if (fs.existsSync(actualPath)) {
        if (actualPath !== outputPath) {
          fs.renameSync(actualPath, outputPath);
        }
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private async readImage(filePath: string, options: {
    displayPath: string;
    visibleInputPath: string;
    authorizedByLocalFileGrant: boolean;
    prompt?: string;
    metadataType?: string;
    proxyIntro?: string;
  }, context: ToolExecutionContext, renderedPdfOptions?: PdfRenderedImageReadOptions): Promise<ToolExecutionResult> {
    const { displayPath, visibleInputPath, authorizedByLocalFileGrant, prompt, metadataType, proxyIntro } = options;
    const visionCapability = resolvePrimaryModelVisionCapability(context.modelId);

    if (!visionCapability.supported) {
      const readerProxyResult: ReaderProxyResult = {
        content: `[无法处理图片: 模型 ${context.modelId} 不支持视觉功能]`,
      };
      const intro = proxyIntro || `以下是图片 "${path.basename(filePath)}" 的分析结果：`;
      return {
        ok: true,
        content: [{ type: 'text', text: `${intro}\n${readerProxyResult.content}` }],
        displayPath,
        visibleInputPath,
      };
    }

    let imageBuffer: Buffer;
    try {
      imageBuffer = fs.readFileSync(filePath);
    } catch (err) {
      return {
        ok: false,
        errorCode: 'FILE_NOT_FOUND',
        message: `无法读取图片 ${formatPathForLog(displayPath)}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (imageBuffer.length > 10 * 1024 * 1024) {
      return {
        ok: false,
        errorCode: 'FILE_TOO_LARGE',
        message: `图片文件过大 (${(imageBuffer.length / 1024 / 1024).toFixed(1)} MB)，最大支持 10 MB`,
      };
    }

    const base64Image = imageBuffer.toString('base64');
    const mimeType = this.getImageMimeType(filePath);
    const imageDataUrl = `data:${mimeType};base64,${base64Image}`;

    try {
      const result = await analyzeImageWithVisionFallback(context, imageDataUrl, {
        prompt,
        metadataType,
      });

      if (result.fallback) {
        return {
          ok: true,
          content: [createImageBlock(imageDataUrl), { type: 'text', text: result.description }],
          displayPath,
          visibleInputPath,
          metadata: { usedFallback: true },
        };
      }

      return {
        ok: true,
        content: [createImageBlock(imageDataUrl), { type: 'text', text: result.description }],
        displayPath,
        visibleInputPath,
      };
    } catch (error) {
      if (authorizedByLocalFileGrant) {
        const readerProxyResult = await analyzeImageWithReaderProxy(context, imageBuffer, filePath);
        const intro = proxyIntro || `以下是图片 "${path.basename(filePath)}" 的分析结果：`;
        return {
          ok: true,
          content: [createImageBlock(imageDataUrl), { type: 'text', text: `${intro}\n${readerProxyResult.content}` }],
          displayPath,
          visibleInputPath,
          metadata: { usedReaderProxy: true },
        };
      }

      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: `图片分析失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private getImageMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
    };
    return mimeTypes[ext] || 'image/png';
  }

  private async readNotebook(filePath: string, options: {
    displayPath: string;
    visibleInputPath: string;
    authorizedByLocalFileGrant: boolean;
  }, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const { displayPath, visibleInputPath } = options;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const notebook = JSON.parse(content);

      if (!notebook.cells || !Array.isArray(notebook.cells)) {
        return {
          ok: false,
          errorCode: 'TOOL_EXECUTION_ERROR',
          message: '无效的 Jupyter notebook 格式',
        };
      }

      let markdownContent = `# ${path.basename(filePath)}\n\n`;
      for (const cell of notebook.cells) {
        if (cell.cell_type === 'markdown') {
          markdownContent += `## Markdown Cell\n${cell.source?.join?.('') || cell.source || ''}\n\n`;
        } else if (cell.cell_type === 'code') {
          const code = cell.source?.join?.('') || cell.source || '';
          markdownContent += `## Code Cell\n\`\`\`\n${code}\n\`\`\`\n\n`;
          if (cell.outputs && cell.outputs.length > 0) {
            for (const output of cell.outputs) {
              if (output.output_type === 'stream') {
                markdownContent += `**Output:**\n\`\`\`\n${output.text?.join?.('') || output.text || ''}\n\`\`\`\n\n`;
              } else if (output.output_type === 'execute_result' && output.data) {
                const text = output.data['text/plain']?.join?.('') || output.data['text/plain'] || '';
                markdownContent += `**Result:**\n\`\`\`\n${text}\n\`\`\`\n\n`;
              }
            }
          }
        }
      }

      return {
        ok: true,
        content: [{ type: 'text', text: markdownContent }],
        displayPath,
        visibleInputPath,
      };
    } catch (err) {
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: `读取 notebook 失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
