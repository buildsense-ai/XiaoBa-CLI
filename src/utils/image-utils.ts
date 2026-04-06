import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { ContentBlock } from '../types';

const SUPPORTED_FORMATS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_DIMENSION = 1568;
const DEFAULT_MAX_TOKENS = 5000;

export interface ImageDimensions {
  originalWidth?: number;
  originalHeight?: number;
  displayWidth?: number;
  displayHeight?: number;
}

interface ProcessedImage {
  buffer: Buffer;
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  dimensions?: ImageDimensions;
}

function getMediaType(filePath: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return null;
}

async function resizeImage(buffer: Buffer, maxTokens: number): Promise<ProcessedImage> {
  const image = sharp(buffer);
  const metadata = await image.metadata();
  
  const originalWidth = metadata.width;
  const originalHeight = metadata.height;
  
  // Standard resize
  let processed = await image
    .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  
  const resizedMetadata = await sharp(processed).metadata();
  const dimensions: ImageDimensions = {
    originalWidth,
    originalHeight,
    displayWidth: resizedMetadata.width,
    displayHeight: resizedMetadata.height,
  };
  
  // Check token budget (base64 length * 0.125 ≈ tokens)
  let estimatedTokens = Math.ceil((processed.length * 4 / 3) * 0.125);
  
  // Aggressive compression if needed
  if (estimatedTokens > maxTokens) {
    const targetSize = Math.floor(maxTokens / 0.125 * 3 / 4);
    processed = await sharp(buffer)
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 60 })
      .toBuffer();
  }
  
  return { buffer: processed, mediaType: 'image/jpeg', dimensions };
}

export async function createImageBlock(filePath: string, maxTokens: number = DEFAULT_MAX_TOKENS): Promise<ContentBlock | null> {
  if (!fs.existsSync(filePath)) return null;
  
  const mediaType = getMediaType(filePath);
  if (!mediaType) return null;
  
  try {
    const buffer = fs.readFileSync(filePath);
    const processed = await resizeImage(buffer, maxTokens);
    
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
  return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
}
