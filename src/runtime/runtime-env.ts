import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { PathResolver } from '../utils/path-resolver';

export interface RuntimeEnvLoadResult {
  sources: string[];
  loadedKeys: string[];
}

/**
 * Precedence is shell/process env > Data Root .env > legacy cwd .env.
 * DOTENV_CONFIG_PATH remains an explicit single-file override for tests and
 * advanced launchers.
 */
export function loadRuntimeEnvFiles(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): RuntimeEnvLoadResult {
  const explicit = String(env.DOTENV_CONFIG_PATH || '').trim();
  const runtimeRoot = PathResolver.getRuntimeDataRoot(env, cwd);
  const candidates = explicit
    ? [path.resolve(explicit)]
    : Array.from(new Set([
      path.resolve(cwd, '.env'),
      path.join(runtimeRoot, '.env'),
    ]));
  const originalKeys = new Set(Object.keys(env));
  const merged: Record<string, string> = {};
  const sources: string[] = [];

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    Object.assign(merged, dotenv.parse(fs.readFileSync(filePath, 'utf8')));
    sources.push(filePath);
  }

  const loadedKeys: string[] = [];
  for (const [key, value] of Object.entries(merged)) {
    if (originalKeys.has(key)) continue;
    env[key] = value;
    loadedKeys.push(key);
  }

  return { sources, loadedKeys };
}
