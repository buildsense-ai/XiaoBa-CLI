import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const LOCAL_FILE_GRANT_TTL_MS = 10 * 60 * 1000;

export interface LocalFileGrant {
  token: string;
  filePath: string;
  name: string;
  size: number;
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

  const token = crypto.randomBytes(32).toString('base64url');
  const grant: LocalFileGrant = {
    token,
    filePath: resolvedPath,
    name: path.basename(resolvedPath),
    size: stat.size,
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
