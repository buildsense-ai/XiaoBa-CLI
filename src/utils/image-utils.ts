import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { ContentBlock } from '../types';

const MAX_DIMENSION = 1568;
const DEFAULT_MAX_TOKENS = 5000;
const MAX_IMAGE_PIXELS = 64_000_000;
export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_PREPARED_IMAGE_BYTES = 4 * 1024 * 1024;

export interface ImageDimensions {
  originalWidth?: number;
  originalHeight?: number;
  displayWidth?: number;
  displayHeight?: number;
}

export interface PreparedImage {
  buffer: Buffer;
  mediaType: 'image/jpeg';
  dimensions?: ImageDimensions;
}

function assertBmpDimensionsWithinLimit(buffer: Buffer): void {
  if (buffer.length < 26) {
    throw new Error('BMP header is incomplete');
  }
  const dibHeaderSize = buffer.readUInt32LE(14);
  const width = dibHeaderSize === 12
    ? buffer.readUInt16LE(18)
    : dibHeaderSize >= 40
      ? buffer.readInt32LE(18)
      : 0;
  const rawHeight = dibHeaderSize === 12
    ? buffer.readUInt16LE(20)
    : dibHeaderSize >= 40
      ? buffer.readInt32LE(22)
      : 0;
  const height = Math.abs(rawHeight);
  if (width <= 0 || height <= 0) {
    throw new Error('BMP dimensions are invalid');
  }
  if (width > MAX_IMAGE_PIXELS || height > Math.floor(MAX_IMAGE_PIXELS / width)) {
    throw new Error(`BMP dimensions exceed the ${MAX_IMAGE_PIXELS} pixel limit`);
  }
}

async function readImageFileWithinLimit(filePath: string): Promise<Buffer> {
  const stats = await fs.promises.stat(filePath);
  if (!stats.isFile()) {
    throw new Error('Image path is not a file');
  }
  if (stats.size > MAX_IMAGE_INPUT_BYTES) {
    throw new Error(`Image exceeds the ${MAX_IMAGE_INPUT_BYTES} byte input limit`);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const input = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_IMAGE_INPUT_BYTES) {
      input.destroy();
      throw new Error(`Image exceeds the ${MAX_IMAGE_INPUT_BYTES} byte input limit`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes);
}

async function normalizeImageBuffer(buffer: Buffer): Promise<Buffer> {
  if (buffer.subarray(0, 2).toString('ascii') !== 'BM') {
    return buffer;
  }

  assertBmpDimensionsWithinLimit(buffer);
  const image = await loadImage(buffer);
  if (!image.width || !image.height || image.width * image.height > MAX_IMAGE_PIXELS) {
    throw new Error('BMP dimensions exceed the image pixel limit');
  }
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  return canvas.toBuffer('image/png');
}

export async function prepareImageForModel(
  filePath: string,
  maxTokens: number = DEFAULT_MAX_TOKENS,
): Promise<PreparedImage> {
  const originalBuffer = await readImageFileWithinLimit(filePath);
  const buffer = await normalizeImageBuffer(originalBuffer);
  const metadata = await sharp(buffer, { limitInputPixels: 64_000_000 }).metadata();
  const originalWidth = metadata.width;
  const originalHeight = metadata.height;
  const targetBytes = Math.min(
    MAX_PREPARED_IMAGE_BYTES,
    Math.max(32 * 1024, Math.floor(Math.max(1, maxTokens) * 6)),
  );
  const variants = [
    { dimension: MAX_DIMENSION, quality: 85 },
    { dimension: 1200, quality: 75 },
    { dimension: 800, quality: 60 },
    { dimension: 512, quality: 45 },
    { dimension: 384, quality: 30 },
  ];

  let smallest: Buffer | undefined;
  for (const variant of variants) {
    const processed = await sharp(buffer, { limitInputPixels: 64_000_000 })
      .rotate()
      .resize(variant.dimension, variant.dimension, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: variant.quality })
      .toBuffer();
    smallest = processed;
    if (processed.length <= targetBytes) {
      const resizedMetadata = await sharp(processed).metadata();
      return {
        buffer: processed,
        mediaType: 'image/jpeg',
        dimensions: {
          originalWidth,
          originalHeight,
          displayWidth: resizedMetadata.width,
          displayHeight: resizedMetadata.height,
        },
      };
    }
  }

  throw new Error(
    `Processed image exceeds the ${targetBytes} byte model-input budget`
      + (smallest ? ` (${smallest.length} bytes)` : ''),
  );
}

export async function createImageBlock(filePath: string, maxTokens: number = DEFAULT_MAX_TOKENS): Promise<ContentBlock | null> {
  if (!fs.existsSync(filePath)) return null;

  try {
    const processed = await prepareImageForModel(filePath, maxTokens);

    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: processed.mediaType,
        data: processed.buffer.toString('base64'),
      },
      // Store dimensions for coordinate mapping
      ...(processed.dimensions && { dimensions: processed.dimensions }),
      filePath,
    } as any;
  } catch (error) {
    console.error(`Failed to process image ${filePath}:`, error);
    return null;
  }
}

export function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(ext);
}
