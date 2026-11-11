import { createHash } from 'crypto';
import type { ContentBlock } from '../types';
import type { SessionAttachmentLog, SessionTranscriptContent } from './session-log-schema';

/** Record content, not runtime capabilities or binary attachments. */
export function sessionTranscriptContent(content: string | ContentBlock[]): SessionTranscriptContent {
  if (typeof content === 'string') return { text: content };
  const attachments: SessionAttachmentLog[] = [];
  const text = content.map(block => {
    if (block.type === 'text') return block.text;
    if (block.type === 'image') {
      attachments.push({
        name: `image_${attachments.length}`,
        type: 'image',
        media_type: block.source.media_type,
        sha256: createHash('sha256').update(Buffer.from(block.source.data, 'base64')).digest('hex'),
      });
    }
    return '';
  }).join('');
  return { text, ...(attachments.length && { attachments }) };
}

export function sessionAttachmentReference(attachment: SessionAttachmentLog): SessionAttachmentLog {
  let url: string | undefined;
  if (attachment.url) {
    try {
      const relative = attachment.url.startsWith('/') && !attachment.url.startsWith('//');
      const parsed = new URL(attachment.url, relative ? 'https://attachment.invalid' : undefined);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        parsed.username = '';
        parsed.password = '';
        parsed.search = '';
        parsed.hash = '';
        url = relative ? parsed.pathname : parsed.toString();
      }
    } catch { /* Invalid/binary URLs are not durable references. */ }
  }
  return {
    name: attachment.name,
    ...(attachment.type && { type: attachment.type }),
    ...(url && { url }),
    ...(attachment.reference && { reference: attachment.reference }),
  };
}

/** Tools may return a direct-image wrapper instead of ordinary ContentBlocks. */
export function sessionToolTranscriptContent(content: unknown): SessionTranscriptContent {
  if (typeof content === 'string' || Array.isArray(content)) return sessionTranscriptContent(content);
  if (content && typeof content === 'object' && '_imageForNewMessage' in content && content._imageForNewMessage === true
    && 'imageBlock' in content && content.imageBlock && typeof content.imageBlock === 'object'
    && 'type' in content.imageBlock && content.imageBlock.type === 'image') {
    return sessionTranscriptContent([content.imageBlock as ContentBlock]);
  }
  return { text: '' };
}
