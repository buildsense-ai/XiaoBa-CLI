import * as fs from 'fs';
import * as path from 'path';
import { ContentBlock } from '../types';

const SUPPORTED_FORMATS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export function imageToBase64(filePath: string): { mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string } | null {
  if (!fs.existsSync(filePath)) return null;

  const ext = path.extname(filePath).toLowerCase();
  const mediaType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.png' ? 'image/png'
    : ext === '.gif' ? 'image/gif'
    : ext === '.webp' ? 'image/webp'
    : null;

  if (!mediaType || !SUPPORTED_FORMATS.includes(mediaType)) return null;

  const data = fs.readFileSync(filePath, 'base64');
  return { mediaType, data };
}

export function createImageBlock(filePath: string): ContentBlock | null {
  const result = imageToBase64(filePath);
  if (!result) return null;

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: result.mediaType,
      data: result.data,
    },
    filePath,
  } as any;
}

export function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
}
