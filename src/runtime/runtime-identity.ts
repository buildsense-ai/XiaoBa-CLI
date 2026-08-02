import * as path from 'path';
import { spawnSync } from 'child_process';
import { PathResolver, RuntimeDataRootSource } from '../utils/path-resolver';

export interface RuntimeCodeIdentity {
  commit?: string;
  branch?: string;
  dirty?: boolean;
}

export interface RuntimeIdentity {
  codeRoot: string;
  workspaceRoot: string;
  dataRoot: string;
  dataRootSource: RuntimeDataRootSource;
  profile: string;
  code: RuntimeCodeIdentity;
}

export interface RuntimeIdentityOptions {
  env?: NodeJS.ProcessEnv;
  codeRoot?: string;
  workspaceRoot?: string;
}

export function resolveCodeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(env.XIAOBA_APP_ROOT || '').trim();
  if (explicit) return path.resolve(explicit);
  return path.resolve(__dirname, '../..');
}

export function resolveRuntimeIdentity(options: RuntimeIdentityOptions = {}): RuntimeIdentity {
  const env = options.env ?? process.env;
  const codeRoot = path.resolve(options.codeRoot ?? resolveCodeRoot(env));
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const data = PathResolver.resolveRuntimeDataRoot(env, workspaceRoot);
  return {
    codeRoot,
    workspaceRoot,
    dataRoot: data.path,
    dataRootSource: data.source,
    profile: data.profile,
    code: readGitIdentity(codeRoot, env),
  };
}

function readGitIdentity(codeRoot: string, env: NodeJS.ProcessEnv): RuntimeCodeIdentity {
  const commit = runGit(['rev-parse', 'HEAD'], codeRoot, env);
  if (!commit) return {};
  const branch = runGit(['branch', '--show-current'], codeRoot, env) || undefined;
  const dirtyOutput = runGit(['status', '--porcelain', '--untracked-files=no'], codeRoot, env, true);
  return {
    commit,
    branch,
    dirty: dirtyOutput === undefined ? undefined : dirtyOutput.length > 0,
  };
}

function runGit(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  preserveEmpty: boolean = false,
): string | undefined {
  const result = spawnSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 1_500,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) return undefined;
  const output = String(result.stdout || '').trim();
  return output || (preserveEmpty ? '' : undefined);
}
