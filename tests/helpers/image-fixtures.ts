import * as fs from 'fs';

export function writeBmpHeader(filePath: string, width: number, height: number): void {
  const buffer = Buffer.alloc(58);
  buffer.write('BM', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(4, 34);
  buffer.set([0, 0, 255, 0], 54);
  fs.writeFileSync(filePath, buffer);
}

export function writeOnePixelBmp(filePath: string): void {
  writeBmpHeader(filePath, 1, 1);
}
