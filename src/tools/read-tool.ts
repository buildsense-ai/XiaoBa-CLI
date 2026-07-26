import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { execFileSync } from 'child_process';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { ContentBlock } from '../types';
import { isReadPathAllowed } from '../utils/safety';
import { createImageBlock } from '../utils/image-utils';
import { ConfigManager } from '../utils/config';
import { resolvePrimaryModelVisionCapability } from '../utils/model-capabilities';
import { analyzeImageWithReaderProxy, ReaderProxyResult } from '../utils/reader-proxy';
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

type DynamicImport = (specifier: string) => Promise<any>;
const dynamicImport: DynamicImport = new Function('specifier', 'return import(specifier)') as DynamicImport;

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
      visiblePath = formatCatsCoVisiblePath(context, visiblePath);
      visibleInputPath = formatCatsCoVisiblePath(context, file_path);
    }

    if (!fs.existsSync(absolutePath)) {
      return { ok: false, errorCode: 'FILE_NOT_FOUND', message: `错误：文件不存在: ${visiblePath}` };
    }

    try {
      const stats = fs.statSync(absolutePath);
      if (!stats.isFile()) {
        return {
          ok: false,
          errorCode: 'TOOL_EXECUTION_ERROR',
          message: [
            'Path is not a file.',
            `Input path: ${visibleInputPath}`,
            `Resolved path: ${visiblePath}`,
          ].join('\n'),
        };
      }
    } catch {
      return { ok: false, errorCode: 'FILE_NOT_FOUND', message: `错误：文件不存在: ${visiblePath}` };
    }

    const ext = path.extname(absolutePath).toLowerCase();

    if (ext === '.pdf') {
      const content = await this.readPDF(absolutePath, displayPath, visiblePath, context, pages, prompt || analysis_prompt);
      return { ok: true, content };
    }

    if (this.isImageExt(ext)) {
      const content = await this.readImage(absolutePath, displayPath, visiblePath, context, prompt || analysis_prompt);
      return { ok: true, content: content as any };
    }

    if (ext === '.ipynb') {
      const content = this.readNotebook(absolutePath, displayPath, visiblePath);
      return { ok: true, content };
    }

    const content = await this.readTextFile(absolutePath, displayPath, visiblePath, { offset, limit }, context);
    return { ok: true, content };
  }

  private normalizeTextReadOptions({ offset, limit }: TextReadOptions): NormalizedTextReadOptions {
    const parsedOffset = Number(offset);
    const startLine = Number.isFinite(parsedOffset) && parsedOffset > 0
      ? Math.floor(parsedOffset)
      : 1;

    if (limit === 0 || limit === '0') {
      return {
        startLine,
        isDefaultLimit: false,
        isUnlimitedRequest: true,
        limitWasCapped: false,
      };
    }

    const parsedLimit = Number(limit);
    const hasExplicitLimit = limit !== undefined && limit !== null && limit !== '';
    const requestedLimit = hasExplicitLimit && Number.isFinite(parsedLimit)
      ? Math.floor(parsedLimit)
      : undefined;

    if (!hasExplicitLimit || requestedLimit === undefined || requestedLimit <= 0) {
      return {
        startLine,
        lineLimit: DEFAULT_TEXT_READ_LIMIT,
        isDefaultLimit: true,
        isUnlimitedRequest: false,
        limitWasCapped: false,
      };
    }

    return {
      startLine,
      lineLimit: Math.min(requestedLimit, MAX_TEXT_READ_LIMIT),
      requestedLimit,
      isDefaultLimit: false,
      isUnlimitedRequest: false,
      limitWasCapped: requestedLimit > MAX_TEXT_READ_LIMIT,
    };
  }

  private trimToUtf8ByteLimit(value: string, maxBytes: number): string {
    if (maxBytes <= 0) return '';
    const buffer = Buffer.from(value, 'utf-8');
    if (buffer.length <= maxBytes) return value;
    return buffer.subarray(0, maxBytes).toString('utf-8');
  }

  private async collectTextLines(
    absolutePath: string,
    options: NormalizedTextReadOptions,
    context: ToolExecutionContext,
  ): Promise<TextReadResult> {
    const selectedLines: string[] = [];
    let totalLines = 0;
    let totalLinesKnown = true;
    let selectedBytes = 0;
    let reachedLineLimit = false;
    let reachedByteLimit = false;

    const input = fs.createReadStream(absolutePath, { encoding: 'utf-8' });
    const reader = readline.createInterface({ input, crlfDelay: Infinity });

    const abort = () => {
      input.destroy(new Error('读取已取消'));
      reader.close();
    };
    context.abortSignal?.addEventListener('abort', abort, { once: true });

    try {
      for await (const line of reader) {
        if (context.abortSignal?.aborted) {
          throw new Error('读取已取消');
        }

        totalLines += 1;

        if (totalLines < options.startLine) continue;

        const relativeLineIndex = totalLines - options.startLine;
        if (options.lineLimit !== undefined && relativeLineIndex >= options.lineLimit) {
          reachedLineLimit = true;
          totalLinesKnown = false;
          break;
        }

        const lineBytes = Buffer.byteLength(line, 'utf-8') + 1;
        const remainingBytes = MAX_TEXT_READ_BYTES - selectedBytes;
        if (lineBytes > remainingBytes) {
          const trimmed = this.trimToUtf8ByteLimit(line, Math.max(remainingBytes - 1, 0));
          if (trimmed) {
            selectedLines.push(trimmed);
            selectedBytes = MAX_TEXT_READ_BYTES;
          }
          reachedByteLimit = true;
          totalLinesKnown = false;
          break;
        }

        selectedLines.push(line);
        selectedBytes += lineBytes;
      }
    } finally {
      context.abortSignal?.removeEventListener('abort', abort);
    }

    const readLines = selectedLines.length;
    const endLine = readLines > 0 ? options.startLine + readLines - 1 : options.startLine - 1;
    const hasMoreAfterSelection = totalLines > endLine && endLine >= options.startLine;
    const nextOffset = hasMoreAfterSelection ? endLine + 1 : undefined;

    return {
      lines: selectedLines,
      totalLines,
      totalLinesKnown,
      readLines,
      startLine: options.startLine,
      endLine,
      reachedLineLimit,
      reachedByteLimit,
      limitWasCapped: options.limitWasCapped,
      isDefaultLimit: options.isDefaultLimit,
      isUnlimitedRequest: options.isUnlimitedRequest,
      requestedLimit: options.requestedLimit,
      nextOffset,
    };
  }

  private formatTextReadResult(filePath: string, displayPath: string, result: TextReadResult): string {
    const formattedLines = result.lines
      .map((line, index) => {
        const lineNumber = result.startLine + index;
        return `${lineNumber.toString().padStart(5, ' ')}→ ${line}`;
      });

    const displayRange = result.readLines > 0
      ? `${result.startLine}-${result.endLine}`
      : `无（从第 ${result.startLine} 行开始无内容）`;
    const totalLinesLabel = result.totalLinesKnown
      ? `${result.totalLines}`
      : `至少 ${result.totalLines}（已停止继续统计，避免超大文件读取耗时）`;

    const notes: string[] = [];
    if (result.limitWasCapped) {
      notes.push(`请求的 limit=${result.requestedLimit} 已限制为 ${MAX_TEXT_READ_LIMIT} 行。`);
    }
    if (result.isDefaultLimit && result.nextOffset) {
      notes.push(`默认只显示 ${DEFAULT_TEXT_READ_LIMIT} 行，避免超大文件占满上下文。`);
    }
    if (result.reachedByteLimit) {
      notes.push(`输出达到 ${(MAX_TEXT_READ_BYTES / 1024).toFixed(0)} KB 上限，已停止追加内容。`);
    }
    if (result.nextOffset) {
      const nextLimit = result.isUnlimitedRequest
        ? DEFAULT_TEXT_READ_LIMIT
        : (result.limitWasCapped ? MAX_TEXT_READ_LIMIT : (result.requestedLimit || DEFAULT_TEXT_READ_LIMIT));
      notes.push(`继续读取请调用 read_file，参数 offset=${result.nextOffset}, limit=${nextLimit}。`);
    }

    return [
      `文件: ${filePath}`,
      `Path: ${displayPath}`,
      `总行数: ${totalLinesLabel}`,
      `显示: ${displayRange}`,
      '',
      formattedLines.join('\n'),
      notes.length > 0 ? ['', ...notes].join('\n') : '',
    ].filter(part => part !== '').join('\n');
  }

  private async readTextFile(
    absolutePath: string,
    filePath: string,
    visiblePath: string,
    options: TextReadOptions,
    context: ToolExecutionContext,
  ): Promise<string> {
    const normalizedOptions = this.normalizeTextReadOptions(options);
    const result = await this.collectTextLines(absolutePath, normalizedOptions, context);
    return this.formatTextReadResult(filePath, visiblePath, result);
  }

  private parsePdfPages(pages?: string): PdfPageSelection {
    const warnings: string[] = [];
    const raw = typeof pages === 'string' ? pages.trim() : '';

    if (!raw) {
      return {
        label: `前 ${DEFAULT_PDF_READ_PAGES} 页`,
        maxPageToRender: DEFAULT_PDF_READ_PAGES,
        warnings,
      };
    }

    const selected = new Set<number>();
    for (const part of raw.split(',').map(item => item.trim()).filter(Boolean)) {
      const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end <= 0 || end < start) {
          warnings.push(`已忽略无效页码范围: ${part}`);
          continue;
        }
        for (let page = start; page <= end; page += 1) selected.add(page);
        continue;
      }

      const page = Number(part);
      if (Number.isInteger(page) && page > 0) {
        selected.add(page);
      } else {
        warnings.push(`已忽略无效页码: ${part}`);
      }
    }

    if (selected.size === 0) {
      warnings.push(`pages="${raw}" 未匹配到有效页码，已改为默认读取前 ${DEFAULT_PDF_READ_PAGES} 页。`);
      return {
        label: `前 ${DEFAULT_PDF_READ_PAGES} 页`,
        maxPageToRender: DEFAULT_PDF_READ_PAGES,
        warnings,
      };
    }

    const sorted = Array.from(selected).sort((a, b) => a - b);
    const capped = sorted.slice(0, MAX_PDF_READ_PAGES);
    if (sorted.length > capped.length) {
      warnings.push(`请求页数 ${sorted.length} 页，已限制为前 ${MAX_PDF_READ_PAGES} 个页码。`);
    }

    return {
      label: capped.join(', '),
      maxPageToRender: Math.max(...capped),
      selectedPages: new Set(capped),
      warnings,
    };
  }

  private getPdfCoverageNotice(selection: PdfPageSelection, totalPages?: number): string[] {
    if (!Number.isFinite(totalPages) || !totalPages || totalPages <= 0) return [];
    const pageCount = Math.floor(totalPages);
    const selectedPages = selection.selectedPages
      ? Array.from(selection.selectedPages).filter(page => page <= pageCount).sort((a, b) => a - b)
      : undefined;

    if (selectedPages) {
      const coversAllPages = selectedPages.length === pageCount
        && selectedPages.every((page, index) => page === index + 1);
      if (coversAllPages) return [];

      return [
        `读取范围提示: 仅已读取页 ${selectedPages.length > 0 ? selectedPages.join(', ') : selection.label} / 共 ${pageCount} 页。`,
        '重要: 下面内容只代表已读取页，不能当作整份 PDF 的完整总结；如果用户要全文/整份分析，请询问是否继续分段读取全文，或让用户指定页码。',
      ];
    }

    const readCount = Math.min(selection.maxPageToRender, pageCount);
    if (readCount >= pageCount) return [];

    return [
      `读取范围提示: 仅已读取前 ${readCount} / 共 ${pageCount} 页。`,
      '重要: 下面内容只代表已读取页，不能当作整份 PDF 的完整总结；如果用户要全文/整份分析，请询问是否继续分段读取全文，或让用户指定页码。',
    ];
  }

  private async extractPdfText(absolutePath: string, selection: PdfPageSelection): Promise<PdfParseResult> {
    const data = fs.readFileSync(absolutePath);
    const selectedPages = selection.selectedPages;
    const options: PdfParseOptions = {
      max: selection.maxPageToRender,
      pagerender: async (pageData: any) => {
        const pageNumber = typeof pageData?.pageIndex === 'number' ? pageData.pageIndex + 1 : undefined;
        if (selectedPages && pageNumber && !selectedPages.has(pageNumber)) return '';

        const textContent = await pageData.getTextContent({
          normalizeWhitespace: false,
          disableCombineTextItems: false,
        });

        let lastY: number | undefined;
        let text = '';
        for (const item of textContent.items || []) {
          const value = typeof item?.str === 'string' ? item.str : '';
          const y = Array.isArray(item?.transform) ? item.transform[5] : undefined;
          if (!value) continue;
          if (lastY === undefined || y === lastY) {
            text += value;
          } else {
            text += `\n${value}`;
          }
          lastY = y;
        }
        return text;
      },
    };

    return pdfParse(data, options);
  }

  private getPdfRenderedImagePages(selection: PdfPageSelection, totalPages?: number): number[] {
    if (selection.selectedPages && selection.selectedPages.size > 0) {
      return Array.from(selection.selectedPages)
        .sort((a, b) => a - b)
        .slice(0, MAX_PDF_IMAGE_FALLBACK_PAGES);
    }

    const knownPages = Number.isFinite(totalPages) && totalPages && totalPages > 0
      ? Math.floor(totalPages)
      : undefined;
    const count = knownPages && knownPages <= MAX_PDF_IMAGE_FALLBACK_PAGES
      ? knownPages
      : Math.min(DEFAULT_PDF_IMAGE_FALLBACK_PAGES, selection.maxPageToRender);
    return Array.from({ length: count }, (_, index) => index + 1);
  }

  private shouldSupplementPdfVisualRead(context: ToolExecutionContext, prompt?: string): boolean {
    const task = this.getImageReadPrompt(context, prompt);
    if (!task) return false;
    return PDF_VISUAL_INTENT_PATTERNS.some(pattern => pattern.test(task));
  }

  private loadPdfCanvasModule(): any {
    const rawCanvasModule = require('@napi-rs/canvas');
    const canvasModule = rawCanvasModule?.createCanvas
      ? rawCanvasModule
      : rawCanvasModule?.default;
    if (!canvasModule?.createCanvas) {
      throw new Error('@napi-rs/canvas createCanvas is unavailable');
    }
    return canvasModule;
  }

  private createPdfCanvasFactory(canvasModule: any): any {
    return {
      create(width: number, height: number): PdfCanvasAndContext {
        if (width <= 0 || height <= 0) {
          throw new Error('Invalid PDF canvas size');
        }
        const canvas = canvasModule.createCanvas(width, height);
        return {
          canvas,
          context: canvas.getContext('2d', { willReadFrequently: true }),
        };
      },
      reset(canvasAndContext: PdfCanvasAndContext, width: number, height: number): void {
        if (!canvasAndContext?.canvas) {
          throw new Error('PDF canvas is not specified');
        }
        if (width <= 0 || height <= 0) {
          throw new Error('Invalid PDF canvas size');
        }
        canvasAndContext.canvas.width = width;
        canvasAndContext.canvas.height = height;
      },
      destroy(canvasAndContext: PdfCanvasAndContext): void {
        if (!canvasAndContext?.canvas) return;
        canvasAndContext.canvas.width = 0;
        canvasAndContext.canvas.height = 0;
        canvasAndContext.canvas = null;
        canvasAndContext.context = null;
      },
    };
  }

  private async renderPdfPagesWithPdfJs(
    absolutePath: string,
    pages: number[],
    tempDir: string,
  ): Promise<RenderedPdfPage[]> {
    const canvasModule = this.loadPdfCanvasModule();
    const globalScope = globalThis as any;
    if (!globalScope.DOMMatrix && canvasModule.DOMMatrix) globalScope.DOMMatrix = canvasModule.DOMMatrix;
    if (!globalScope.DOMPoint && canvasModule.DOMPoint) globalScope.DOMPoint = canvasModule.DOMPoint;
    if (!globalScope.DOMRect && canvasModule.DOMRect) globalScope.DOMRect = canvasModule.DOMRect;
    if (!globalScope.ImageData && canvasModule.ImageData) globalScope.ImageData = canvasModule.ImageData;
    if (!globalScope.Path2D && canvasModule.Path2D) globalScope.Path2D = canvasModule.Path2D;

    const pdfjs = await dynamicImport('pdfjs-dist/legacy/build/pdf.mjs');
    const canvasFactory = this.createPdfCanvasFactory(canvasModule);
    const data = new Uint8Array(fs.readFileSync(absolutePath));
    const loadingTask = pdfjs.getDocument({
      data,
      disableWorker: true,
      useSystemFonts: true,
      canvasFactory,
    });

    const rendered: RenderedPdfPage[] = [];
    const doc = await loadingTask.promise;
    try {
      for (const pageNumber of pages) {
        if (pageNumber > doc.numPages) continue;

        const page = await doc.getPage(pageNumber);
        const baseViewport = page.getViewport({ scale: 1 });
        const basePixels = Math.max(1, baseViewport.width * baseViewport.height);
        const maxScale = Math.sqrt(MAX_PDF_RENDER_PIXELS / basePixels);
        const scale = Math.min(DEFAULT_PDF_RENDER_SCALE, maxScale);
        const viewport = page.getViewport({ scale });
        const canvas = canvasModule.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const canvasContext = canvas.getContext('2d');
        await page.render({ canvasContext, viewport, canvasFactory }).promise;

        const imagePath = path.join(tempDir, `page-${pageNumber}.png`);
        fs.writeFileSync(imagePath, canvas.toBuffer('image/png'));
        rendered.push({ pageNumber, imagePath, renderer: 'pdfjs' });
        page.cleanup?.();
      }
    } finally {
      await doc.destroy();
    }

    if (rendered.length === 0) {
      throw new Error('PDF 页码超出范围，未渲染出任何页面。');
    }
    return rendered;
  }

  private async renderPdfPagesWithPdftoppm(
    absolutePath: string,
    pages: number[],
    tempDir: string,
  ): Promise<RenderedPdfPage[]> {
    const rendered: RenderedPdfPage[] = [];
    for (const pageNumber of pages) {
      const outputPrefix = path.join(tempDir, `pdftoppm-page-${pageNumber}`);
      execFileSync('pdftoppm', [
        '-f',
        String(pageNumber),
        '-l',
        String(pageNumber),
        '-singlefile',
        '-png',
        '-r',
        '150',
        absolutePath,
        outputPrefix,
      ], { timeout: 45_000, stdio: 'pipe' });

      const imagePath = `${outputPrefix}.png`;
      if (fs.existsSync(imagePath)) {
        rendered.push({ pageNumber, imagePath, renderer: 'pdftoppm' });
      }
    }

    if (rendered.length === 0) {
      throw new Error('pdftoppm 未生成页面图片。');
    }
    return rendered;
  }

  private async renderPdfPagesToImages(
    absolutePath: string,
    pages: number[],
    tempDir: string,
  ): Promise<RenderedPdfPage[]> {
    let pdfJsMessage = 'unknown pdfjs error';
    try {
      return await this.renderPdfPagesWithPdfJs(absolutePath, pages, tempDir);
    } catch (pdfJsError: any) {
      pdfJsMessage = String(pdfJsError?.message || pdfJsError || 'unknown pdfjs error');
      Logger.warning(`[CatsCo] pdf_image_fallback pdfjs_failed file=${formatPathForLog(absolutePath)} reason=${pdfJsMessage.slice(0, 300)}`);
    }

    try {
      return await this.renderPdfPagesWithPdftoppm(absolutePath, pages, tempDir);
    } catch (pdftoppmError: any) {
      const message = String(pdftoppmError?.message || pdftoppmError || 'unknown pdftoppm error');
      throw new Error(`PDF 页面渲染失败：内置 PDF.js 渲染失败：${pdfJsMessage}；系统 pdftoppm 也不可用或执行失败：${message}`);
    }
  }

  private async readPdfViaRenderedImages(
    absolutePath: string,
    filePath: string,
    visiblePath: string,
    context: ToolExecutionContext,
    selection: PdfPageSelection,
    prompt?: string,
    options?: PdfRenderedImageReadOptions,
  ): Promise<string | ContentBlock[]> {
    const pages = this.getPdfRenderedImagePages(selection, options?.totalPages);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catsco-pdf-pages-'));

    try {
      const renderedPages = await this.renderPdfPagesToImages(absolutePath, pages, tempDir);
      const isSupplement = options?.reason === 'visual_supplement';
      const visionState = await resolvePrimaryModelVisionCapability(ConfigManager.getConfigReadonly());
      const visionCapable = visionState === 'supported';
      const parts = [
        isSupplement
          ? 'PDF 文本层已提取；由于用户任务可能涉及图片、签名、印章、手写、版式或表格，已额外转成页面图片补充读取。'
          : 'PDF 文本层未提取到内容，已自动转成页面图片继续读取。',
        `${isSupplement ? '视觉补充页码' : '转图片页码'}: ${renderedPages.map(page => page.pageNumber).join(', ')}`,
        `读取方式: ${renderedPages[0]?.renderer === 'pdftoppm' ? '系统 pdftoppm 渲染' : '内置 PDF.js 渲染'} + ${visionCapable ? '当前主模型读图' : 'Cats reader proxy 读图'}`,
      ];
      const imageBlocks: ContentBlock[] = [];

      if (pages.length > renderedPages.length) {
        const renderedSet = new Set(renderedPages.map(page => page.pageNumber));
        const skipped = pages.filter(page => !renderedSet.has(page));
        if (skipped.length > 0) {
          parts.push(`跳过页码: ${skipped.join(', ')}（可能超出 PDF 总页数）`);
        }
      }

      if (!selection.selectedPages && options?.totalPages && options.totalPages > renderedPages.length) {
        parts.push(`PDF 共 ${options.totalPages} 页，为避免大 PDF 转图过慢和上下文膨胀，默认只补读前 ${renderedPages.length} 页；需要指定页请用 pages，例如 pages="12-15"。`);
      } else if ((!selection.selectedPages || selection.selectedPages.size > MAX_PDF_IMAGE_FALLBACK_PAGES)
        && selection.maxPageToRender > renderedPages.length) {
        parts.push(`为避免读图成本和上下文膨胀，图片读取默认最多处理 ${renderedPages.length} 页；需要更多页请用 pages 指定更小范围。`);
      }

      const userTask = this.getImageReadPrompt(context, prompt);
      for (const page of renderedPages) {
        const pagePrompt = [
          `用户正在读取 PDF 文件: ${visiblePath}`,
          `当前是 PDF 第 ${page.pageNumber} 页的渲染图片。`,
          userTask ? `用户任务: ${userTask}` : '请提取这一页中可见的文字、表格和关键结构。',
        ].join('\n');
        const analysis = await this.readImage(
          page.imagePath,
          `${filePath}#page=${page.pageNumber}`,
          `${visiblePath}#page=${page.pageNumber}`,
          context,
          pagePrompt,
          {
            metadataType: 'PDF 页面图片',
            proxyIntro: isSupplement
              ? '视觉补充结果（PDF 文本层可能漏掉图片、签章、手写或版式信息）：'
              : '读图结果（PDF 文本层不可用，已转为页面图片解析）：',
          },
        );
        if (this.isDirectImageReadResult(analysis)) {
          imageBlocks.push(
            { type: 'text', text: `--- 第 ${page.pageNumber} 页（PDF 页面图片）---` },
            analysis.imageBlock,
          );
        } else {
          parts.push('', `--- 第 ${page.pageNumber} 页 ---`, String(analysis));
        }
      }

      if (imageBlocks.length > 0) {
        parts.push('', '以下附有上述 PDF 页面图片，按页码顺序查看。');
        return [{ type: 'text', text: parts.join('\n') }, ...imageBlocks];
      }

      return parts.join('\n');
    } catch (error: any) {
      const rawMessage = String(error?.message || error || 'unknown error').trim();
      const message = rawMessage.length > 500 ? `${rawMessage.slice(0, 500)}...` : rawMessage;
      return [
        options?.reason === 'visual_supplement'
          ? 'PDF 文本层已提取，但 CatsCo 额外尝试转为页面图片补充读取时失败。'
          : 'PDF 文本层未提取到内容，CatsCo 已尝试转为页面图片读取，但转图链路失败。',
        `原因: ${message}`,
        '可以改发截图/图片，或在当前环境安装 Poppler(pdftoppm) 后重试。',
      ].join('\n');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private async readPDF(
    absolutePath: string,
    filePath: string,
    visiblePath: string,
    context: ToolExecutionContext,
    pages?: string,
    prompt?: string,
  ): Promise<string | ContentBlock[]> {
    const stats = fs.statSync(absolutePath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    const selection = this.parsePdfPages(pages);

    const lines = [
      `文件: ${filePath}`,
      `Path: ${visiblePath}`,
      '类型: PDF',
      `大小: ${sizeMB} MB`,
    ];

    if (stats.size > MAX_PDF_READ_BYTES) {
      lines.push(
        '',
        `PDF 文件超过 ${(MAX_PDF_READ_BYTES / 1024 / 1024).toFixed(0)} MB，read_file 不会自动解析，避免占满内存和上下文。`,
        '请先指定更小文件，或使用 shell 中的文档解析工具做分段提取。',
      );
      return lines.join('\n');
    }

    try {
      const parsed = await this.extractPdfText(absolutePath, selection);
      const rawText = String(parsed.text || '').trim();
      const text = this.trimToUtf8ByteLimit(rawText, MAX_PDF_OUTPUT_BYTES);
      const wasTruncated = Buffer.byteLength(rawText, 'utf-8') > Buffer.byteLength(text, 'utf-8');

      lines.push(
        `总页数: ${parsed.numpages ?? '未知'}`,
        `已解析页: ${selection.label}`,
      );

      const coverageNotice = this.getPdfCoverageNotice(selection, parsed.numpages);
      if (coverageNotice.length > 0) {
        lines.push('', ...coverageNotice);
      }

      if (selection.warnings.length > 0) {
        lines.push('', ...selection.warnings);
      }

      if (!rawText) {
        const visualContent = await this.readPdfViaRenderedImages(absolutePath, filePath, visiblePath, context, selection, prompt, {
          reason: 'missing_text',
          totalPages: parsed.numpages,
        });
        if (Array.isArray(visualContent)) {
          return [{ type: 'text', text: lines.join('\n') }, ...visualContent];
        }
        lines.push('', visualContent);
        return lines.join('\n');
      }

      lines.push('', '文本内容:', text);
      if (wasTruncated) {
        lines.push(
          '',
          `输出达到 ${(MAX_PDF_OUTPUT_BYTES / 1024).toFixed(0)} KB 上限，后续内容已省略。`,
          '如需继续读取，请用 pages 参数指定更小页码范围，例如 pages="11-20"。',
        );
      } else if (!pages && parsed.numpages && parsed.numpages > DEFAULT_PDF_READ_PAGES) {
        lines.push(
          '',
          `默认只解析前 ${DEFAULT_PDF_READ_PAGES} 页。`,
          `如需继续读取，请调用 read_file 并指定 pages="${DEFAULT_PDF_READ_PAGES + 1}-${Math.min(parsed.numpages, DEFAULT_PDF_READ_PAGES * 2)}"。`,
        );
      }

      if (this.shouldSupplementPdfVisualRead(context, prompt)) {
        const visualContent = await this.readPdfViaRenderedImages(absolutePath, filePath, visiblePath, context, selection, prompt, {
          reason: 'visual_supplement',
          totalPages: parsed.numpages,
        });
        if (Array.isArray(visualContent)) {
          return [{ type: 'text', text: lines.join('\n') }, ...visualContent];
        }
        lines.push('', visualContent);
      }

      return lines.join('\n');
    } catch (error: any) {
      const rawMessage = String(error?.message || error || 'unknown error').trim();
      const message = rawMessage.length > 500 ? `${rawMessage.slice(0, 500)}...` : rawMessage;
      lines.push('', 'PDF 解析失败，read_file 未能提取正文。', `原因: ${message}`);
      const visualContent = await this.readPdfViaRenderedImages(absolutePath, filePath, visiblePath, context, selection, prompt, {
        reason: 'parse_failed',
      });
      if (Array.isArray(visualContent)) {
        return [{ type: 'text', text: lines.join('\n') }, ...visualContent];
      }
      lines.push('', visualContent);
      return lines.join('\n');
    }
  }

  private isImageExt(ext: string): boolean {
    return ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'].includes(ext);
  }

  private isDirectImageReadResult(content: unknown): content is { _imageForNewMessage: true; imageBlock: ContentBlock } {
    return Boolean(
      content
      && typeof content === 'object'
      && (content as any)._imageForNewMessage === true
      && (content as any).imageBlock?.type === 'image',
    );
  }

  private shouldImportRemoteMedia(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    const ext = path.posix.extname(normalized).toLowerCase();
    return ext === '.pdf' || this.isImageExt(ext);
  }

  private async readImportedRemoteMedia(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const sourcePath = String(args.file_path || '').trim();
    const importResult = await importRemoteFileToAgentWorkspace({
      file_path: sourcePath,
      file_name: this.remoteMediaFileName(sourcePath),
      target: args.target,
    }, context);

    if (!importResult.ok) return importResult;
    if (!importResult.importedLocalPath) {
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: '远程媒体文件已经上传，但当前 agent 未获得本地缓存路径。',
        targetContext: importResult.targetContext,
      };
    }

    const localArgs = {
      ...args,
      file_path: importResult.importedLocalPath,
    };
    delete (localArgs as Record<string, unknown>).target;
    return this.execute(localArgs, context);
  }

  private remoteMediaFileName(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    const baseName = path.posix.basename(normalized).trim();
    if (baseName && baseName !== '.' && baseName !== '/') return baseName;
    return 'remote-media';
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

  private formatImageMetadata(
    absolutePath: string,
    filePath: string,
    visiblePath: string,
    metadataType = '图片文件',
  ): string {
    const stats = fs.statSync(absolutePath);
    const sizeKB = (stats.size / 1024).toFixed(2);
    return [`文件: ${filePath}`, `Path: ${visiblePath}`, `类型: ${metadataType}`, `大小: ${sizeKB} KB`].join('\n');
  }

  private formatReaderProxyFailure(proxyResult: ReaderProxyResult, visionCapable: boolean): string {
    const status = proxyResult.status;
    const attempts = proxyResult.attempts && proxyResult.attempts > 1
      ? `已自动尝试 ${proxyResult.attempts} 次（含凭证切换或网络重试）。`
      : '';
    const rawError = String(proxyResult.error || 'unknown error').trim();
    const shortError = rawError.length > 500 ? `${rawError.slice(0, 500)}...` : rawError;

    let title = '读图失败：读图服务暂时没有返回可用结果。';
    let action = '可以稍后重试，或先把图片里的关键文字/区域用文字补充一下。';

    if (/could not find the current CatsCo account|requires CATSCOMPANY_API_KEY|READER_PROXY_API_KEY|apiKey/i.test(rawError)) {
      title = '读图失败：当前 CatsCo 登录或机器人绑定没有提供有效认证。';
      action = '请重新登录 CatsCo 或重新绑定机器人；正常使用不需要单独配置 Reader Key。';
    } else if (status === 400) {
      title = '读图失败：图片请求格式不被服务接受。';
      action = '请确认上传的是常见图片格式（png/jpg/jpeg/webp/gif/bmp），必要时重新截图后再发。';
    } else if (status === 401 || status === 403) {
      title = '读图失败：读图服务鉴权失败。';
      action = '请重新登录 CatsCo 或重新绑定机器人，并确认账号仍有读图权限。';
    } else if (status === 404) {
      title = '读图失败：读图服务地址不正确。';
      action = '请检查 Reader Proxy URL / CatsCo HTTP Base URL 是否指向正确服务。';
    } else if (status === 413) {
      title = '读图失败：图片太大，服务拒绝处理。';
      action = '请压缩图片、裁剪重点区域，或改发更小的截图。';
    } else if (status === 415) {
      title = '读图失败：图片格式暂不支持。';
      action = '请转成 png 或 jpg 后重试。';
    } else if (status === 429) {
      title = '读图失败：读图服务正在忙。';
      action = '当前同一客户端并发读图太多，请等上一张图片处理完后再试。';
    } else if (status === 502 || status === 503 || status === 504) {
      title = '读图失败：读图服务临时不可用。';
      action = '可能是服务重启、上游模型繁忙或网关超时，请稍后重试。';
    } else if (/timeout|ECONNRESET|ECONNABORTED|EAI_AGAIN|ENOTFOUND|network|socket/i.test(rawError)) {
      title = '读图失败：CatsCo 桌面端连接读图服务失败。';
      action = '请检查本机网络、代理、DNS，或 CatsCo 服务是否能访问。';
    }

    return [
      visionCapable
        ? '主模型图片块生成失败，CatsCo 桌面端已尝试改用读图服务。'
        : '当前主模型不能直接读取图片内容，CatsCo 桌面端已尝试调用读图服务。',
      title,
      action,
      attempts,
      `排查信息: ${status ? `HTTP ${status}; ` : ''}${shortError}`,
    ].filter(Boolean).join('\n');
  }

  private async readImage(
    absolutePath: string,
    filePath: string,
    visiblePath: string,
    context: ToolExecutionContext,
    prompt?: string,
    options?: ReadImageOptions,
  ): Promise<any> {
    const config = ConfigManager.getConfigReadonly();
    const imagePrompt = this.getImageReadPrompt(context, prompt);
    const visionState = await resolvePrimaryModelVisionCapability(config);
    const visionCapable = visionState === 'supported';
    const modelName = config.model || 'unknown';

    if (visionCapable) {
      const imageBlock = await createImageBlock(absolutePath);
      const logFile = formatPathForLog(absolutePath || filePath);
      if (imageBlock) {
        Logger.info(`[CatsCo] vision_direct model=${modelName} tool=read_file file=${logFile} bytes_base64=${((imageBlock as any).source as any)?.data?.length || 0}`);
        return {
          _imageForNewMessage: true,
          imageBlock: { ...imageBlock, filePath },
          filePath,
        };
      }
      Logger.warning(`[CatsCo] vision_fallback_read_file model=${modelName} tool=read_file file=${logFile} reason=image_block_create_failed path=${logFile}`);
    } else {
      Logger.info(`[CatsCo] vision_fallback_read_file model=${modelName} tool=read_file file=${formatPathForLog(absolutePath || filePath)} reason=${visionState === 'unsupported' ? 'model_not_vision_capable' : 'model_capability_unknown'}`);
    }

    const proxyResult = await analyzeImageWithReaderProxy({
      filePath: absolutePath,
      prompt: imagePrompt,
      config,
    });

    if (proxyResult.ok && proxyResult.analysis) {
      return [
        this.formatImageMetadata(absolutePath, filePath, visiblePath, options?.metadataType),
        '',
        options?.proxyIntro || (visionCapable
          ? '主模型图片块生成失败，已自动改用 Cats reader proxy 解析：'
          : '读图结果（由 Cats reader proxy 解析，已作为 read_file 结果返回给当前非多模态主模型）：'),
        proxyResult.analysis,
      ].join('\n');
    }

    return [
      this.formatImageMetadata(absolutePath, filePath, visiblePath, options?.metadataType),
      '',
      this.formatReaderProxyFailure(proxyResult, visionCapable),
    ].join('\n');
  }

  private readNotebook(absolutePath: string, filePath: string, visiblePath: string): string {
    const content = fs.readFileSync(absolutePath, 'utf-8');
    const notebook = JSON.parse(content);

    let result = `文件: ${filePath}\nPath: ${visiblePath}\nJupyter Notebook\n单元格数量: ${notebook.cells?.length || 0}\n\n`;

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
