import crypto from 'crypto';

function pkcs7Pad(buffer: Buffer): Buffer {
  const blockSize = 16;
  const padding = blockSize - (buffer.length % blockSize);
  return Buffer.concat([buffer, Buffer.alloc(padding, padding)]);
}

function pkcs7Unpad(buffer: Buffer): Buffer {
  const padding = buffer[buffer.length - 1];
  return buffer.slice(0, buffer.length - padding);
}

export function encryptAESECB(plaintext: Buffer, key: Buffer): Buffer {
  const padded = pkcs7Pad(plaintext);
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

export function decryptAESECB(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return pkcs7Unpad(decrypted);
}

function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32) {
    const hexStr = decoded.toString('ascii');
    if (/^[0-9a-fA-F]{32}$/.test(hexStr)) {
      return Buffer.from(hexStr, 'hex');
    }
  }
  throw new Error(`Invalid aes_key format: ${decoded.length} bytes after base64`);
}

export function aesECBPaddedSize(plaintextLen: number): number {
  const blockSize = 16;
  return Math.floor((plaintextLen + blockSize) / blockSize) * blockSize;
}

export async function uploadBufferToCDN(
  cdnBaseUrl: string,
  uploadParam: string,
  filekey: string,
  plaintext: Buffer,
  aesKey: Buffer
): Promise<string> {
  const ciphertext = encryptAESECB(plaintext, aesKey);
  const url = `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;

  const maxRetries = 3;
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
      });

      if (response.status >= 400 && response.status < 500) {
        const errMsg = response.headers.get('x-error-message') || await response.text();
        throw new Error(`CDN client error ${response.status}: ${errMsg}`);
      }

      if (response.status !== 200) {
        const errMsg = response.headers.get('x-error-message') || `status ${response.status}`;
        throw new Error(`CDN server error: ${errMsg}`);
      }

      const downloadParam = response.headers.get('x-encrypted-param');
      if (!downloadParam) throw new Error('CDN response missing x-encrypted-param');

      return downloadParam;
    } catch (err: any) {
      lastError = err;
      if (err.message?.includes('client error')) throw err;
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  throw lastError || new Error(`CDN upload failed after ${maxRetries} attempts`);
}

export async function downloadAndDecryptCDN(
  cdnBaseUrl: string,
  encryptedQueryParam: string,
  aesKeyBase64: string
): Promise<Buffer> {
  const key = parseAesKey(aesKeyBase64);
  const url = `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`CDN download failed: ${response.status}`);
  }

  const ciphertext = Buffer.from(await response.arrayBuffer());
  return decryptAESECB(ciphertext, key);
}
