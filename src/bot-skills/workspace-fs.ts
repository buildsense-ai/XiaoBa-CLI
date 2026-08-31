import * as fs from 'fs';

const DEFAULT_MAX_RETRIES = 8;
const DEFAULT_RETRY_DELAY_MS = 50;
const TRANSIENT_RENAME_ERROR_CODES = new Set(['EBUSY', 'EACCES', 'EPERM']);

export interface RenameBotSkillWorkspaceOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  renameSync?: typeof fs.renameSync;
  waitSync?: (milliseconds: number) => void;
}

/**
 * Retries whole-workspace directory renames that can fail briefly on Windows
 * while antivirus, indexing, or another reader is releasing a file handle.
 * Callers still own their restore/switch journals and fail-closed rollback.
 */
export function renameBotSkillWorkspaceSync(
  sourcePath: string,
  targetPath: string,
  options: RenameBotSkillWorkspaceOptions = {},
): void {
  const maxRetries = nonNegativeInteger(options.maxRetries, DEFAULT_MAX_RETRIES);
  const retryDelayMs = nonNegativeInteger(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS);
  const renameSync = options.renameSync ?? fs.renameSync;
  const waitSync = options.waitSync ?? blockFor;
  let retry = 0;

  while (true) {
    try {
      renameSync(sourcePath, targetPath);
      return;
    } catch (error: any) {
      if (!TRANSIENT_RENAME_ERROR_CODES.has(String(error?.code || '')) || retry >= maxRetries) {
        throw error;
      }
      retry += 1;
      waitSync(retryDelayMs * retry);
    }
  }
}

function blockFor(milliseconds: number): void {
  if (milliseconds <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}
