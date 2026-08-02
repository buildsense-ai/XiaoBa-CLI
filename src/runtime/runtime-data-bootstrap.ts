import * as path from 'path';
import { normalizeProfileName } from '../utils/path-resolver';

export interface RuntimeDataBootstrapResult {
  dataDir?: string;
  profile?: string;
}

/**
 * Runtime data options must be applied before command modules are imported.
 * Some command modules load profile configuration during module evaluation.
 */
export function applyRuntimeDataOptionsFromArgv(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): RuntimeDataBootstrapResult {
  const dataDir = readOption(argv, '--data-dir');
  const rawProfile = readOption(argv, '--profile');
  const profile = rawProfile === undefined ? undefined : normalizeProfileName(rawProfile);

  if (dataDir !== undefined) {
    if (!dataDir.trim()) throw new Error('--data-dir requires a non-empty path');
    env.XIAOBA_USER_DATA_DIR = path.resolve(cwd, dataDir);
  }
  if (profile !== undefined) env.XIAOBA_PROFILE = profile;

  return {
    dataDir: dataDir === undefined ? undefined : env.XIAOBA_USER_DATA_DIR,
    profile,
  };
}

function readOption(argv: string[], name: string): string | undefined {
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === name) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error(`${name} requires a value`);
      }
      return next;
    }
    if (value.startsWith(`${name}=`)) return value.slice(name.length + 1);
  }
  return undefined;
}
