import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const LOCAL_FILE_GRANT_TTL_MS = 10 * 60 * 1000;
export const LOCAL_FILE_GRANT_MAX_SIZE_BYTES = 50 * 1024 * 1024;

export interface LocalFileGrant {
  token: string;
  filePath: string;
  name: string;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  createdAt: number;
}

const grants = new Map<string, LocalFileGrant>();

function cleanupExpiredGrants(now = Date.now()): void {
  for (const [token, grant] of grants.entries()) {
    if (now - grant.createdAt > LOCAL_FILE_GRANT_TTL_MS) {
      grants.delete(token);
    }
  }
}

function grantError(message: string, status = 400): Error {
  const error = new Error(message);
  (error as any).status = status;
  return error;
}

export function createLocalFileGrant(filePath: string): Pick<LocalFileGrant, 'token' | 'name' | 'size'> {
  cleanupExpiredGrants();
  const resolvedPath = fs.realpathSync(path.resolve(filePath));
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    throw grantError('local file grant must point to a file');
  }
  if (stat.size > LOCAL_FILE_GRANT_MAX_SIZE_BYTES) {
    throw grantError(`local file is too large; max size is ${LOCAL_FILE_GRANT_MAX_SIZE_BYTES} bytes`, 413);
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const grant: LocalFileGrant = {
    token,
    filePath: resolvedPath,
    name: path.basename(resolvedPath),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    dev: stat.dev,
    ino: stat.ino,
    createdAt: Date.now(),
  };
  grants.set(token, grant);

  return {
    token,
    name: grant.name,
    size: grant.size,
  };
}

export function consumeLocalFileGrant(token: string): LocalFileGrant {
  cleanupExpiredGrants();
  const grant = grants.get(token);
  if (!grant) {
    throw grantError('file_token is invalid or expired');
  }
  grants.delete(token);
  return grant;
}

export function validateLocalFileGrant(grant: LocalFileGrant): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(grant.filePath);
  } catch (_error) {
    throw grantError('authorized file is no longer available; please choose it again');
  }
  if (!stat.isFile()) {
    throw grantError('file_token must point to a file');
  }
  if (
    stat.size !== grant.size ||
    stat.mtimeMs !== grant.mtimeMs ||
    stat.dev !== grant.dev ||
    stat.ino !== grant.ino
  ) {
    throw grantError('authorized file changed after selection; please choose it again');
  }
  return stat;
}
