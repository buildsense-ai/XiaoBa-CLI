import { createHash } from 'node:crypto';

export function outputBodyHash(kind: 'message' | 'tool_call', providerCallID: string, name: string, body: string): string {
  const hash = createHash('sha256');
  if (kind === 'message') return hash.update(body, 'utf8').digest('hex');
  for (const field of [providerCallID, name, body]) {
    const bytes = Buffer.from(field, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return hash.digest('hex');
}
