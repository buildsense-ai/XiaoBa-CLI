import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolves a directory that must be a real directory. Symbolic links are
 * rejected so a caller can never be redirected outside the scope it validated.
 */
export function requireSafeDirectory(value: string, label: string): string {
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} is not a safe directory: ${resolved}`);
  }
  return resolved;
}

/**
 * Resolves `<runtimeRoot>/data`.
 *
 * Release deployments point that one deployment-owned segment at a shared data
 * directory instead of copying the directory into every release, so it may be a
 * symbolic link. The Runtime root itself and every directory below `data` must
 * still be real directories, and the lexical path is returned so callers keep
 * addressing the Runtime through its own release directory.
 */
export function requireSafeRuntimeDataDirectory(runtimeRoot: string, label: string): string {
  const dataRoot = path.join(runtimeRoot, 'data');
  if (!fs.existsSync(dataRoot)) {
    try {
      fs.mkdirSync(dataRoot, { recursive: false });
    } catch (error: any) {
      // Another Runtime process may have created the same safe scope first.
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  if (!fs.existsSync(dataRoot)) throw new Error(`${label} does not exist: ${dataRoot}`);
  const resolved = fs.realpathSync(dataRoot);
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`${label} is not a safe directory: ${dataRoot}`);
  }
  return dataRoot;
}
