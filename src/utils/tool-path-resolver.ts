import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolExecutionContext } from '../types/tool';

export interface ResolvedToolPath {
  inputPath: string;
  absolutePath: string;
  exists: boolean;
  isFile: boolean;
  isDirectory: boolean;
}

export function resolveToolPath(inputPath: string, context: ToolExecutionContext): ResolvedToolPath {
  const expanded = expandHome(inputPath.trim());
  const absolutePath = path.resolve(
    path.isAbsolute(expanded) ? expanded : path.join(context.workingDirectory, expanded),
  );
  let exists = false;
  let isFile = false;
  let isDirectory = false;

  try {
    const stats = fs.statSync(absolutePath);
    exists = true;
    isFile = stats.isFile();
    isDirectory = stats.isDirectory();
  } catch {
    exists = false;
  }

  return {
    inputPath,
    absolutePath,
    exists,
    isFile,
    isDirectory,
  };
}

function expandHome(inputPath: string): string {
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith(`~${path.sep}`) || inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}
