import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { Logger } from '../utils/logger';

export type CatsUploadType = 'image' | 'file';

export interface UploadResult {
  url: string;
  name: string;
  size: number;
}

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

function limitLogText(value: string, maxLength = 500): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function multipartSafeFilename(filename: string): string {
  return filename.replace(/[\r\n"]/g, '_');
}

function uploadTimeoutMs(fileSize: number): number {
  const mb = Math.ceil(fileSize / (1024 * 1024));
  return Math.max(60_000, Math.min(30 * 60_000, 60_000 + mb * 10_000));
}

export function isCatsImageFileName(fileName: string): boolean {
  return IMAGE_EXTS.has(path.extname(fileName).toLowerCase());
}

export function inferCatsUploadType(fileName: string): CatsUploadType {
  return isCatsImageFileName(fileName) ? 'image' : 'file';
}

export async function uploadCatsLocalFile(options: {
  httpBaseUrl: string;
  filePath: string;
  type?: CatsUploadType;
  authHeader: string;
  timeoutMs?: number;
}): Promise<UploadResult> {
  const resolvedPath = path.resolve(options.filePath);
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new Error(`不是可上传的文件: ${resolvedPath}`);
  }

  const httpBaseUrl = options.httpBaseUrl.replace(/\/$/, '');
  const uploadType = options.type || inferCatsUploadType(resolvedPath);
  const url = `${httpBaseUrl}/api/upload?type=${uploadType}`;
  const filename = path.basename(resolvedPath);
  const mimeType = MIME_BY_EXT[path.extname(filename).toLowerCase()] || 'application/octet-stream';
  const boundary = `----CatsCoFormBoundary${crypto.randomBytes(16).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${multipartSafeFilename(filename)}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const contentLength = head.length + stat.size + tail.length;

  async function* multipartBody() {
    yield head;
    const fileStream = fs.createReadStream(resolvedPath);
    try {
      for await (const chunk of fileStream) {
        yield chunk as Buffer;
      }
    } finally {
      fileStream.destroy();
    }
    yield tail;
  }

  try {
    Logger.info(`[CatsCompany] 开始上传文件: ${filename}, type=${uploadType}, size=${stat.size} bytes, mime=${mimeType}`);

    const requestInit: RequestInit & { duplex?: 'half' } = {
      method: 'POST',
      headers: {
        Authorization: options.authHeader,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(contentLength),
      },
      body: Readable.from(multipartBody()) as any,
      duplex: 'half',
      signal: AbortSignal.timeout(options.timeoutMs || uploadTimeoutMs(stat.size)),
    };
    const res = await fetch(url, requestInit);

    if (!res.ok) {
      const errorText = await res.text();
      Logger.error(`[CatsCompany] 上传失败: status=${res.status}, body=${limitLogText(errorText)}`);
      const error = new Error(`Upload failed: ${res.status} - ${errorText}`);
      (error as any).status = res.status;
      throw error;
    }

    const result = await res.json() as UploadResult;
    Logger.info(`[CatsCompany] 上传成功: ${result.name || filename}, size=${result.size || stat.size} bytes`);
    return {
      url: result.url,
      name: result.name || filename,
      size: result.size || stat.size,
    };
  } catch (err: any) {
    Logger.error(`[CatsCompany] 上传异常: ${err.message || 'unknown error'}`);
    const error = new Error(`Upload failed: ${err.message || 'unknown error'}`);
    (error as any).status = err.status;
    throw error;
  }
}
