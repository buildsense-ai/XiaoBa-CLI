import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Message } from '../types';

export const TRANSIENT_CURRENT_DIRECTORY_PREFIX = '[transient_current_directory]';

export interface GitRepositoryInfo {
  root: string;
  branch?: string;
  trackedChanges?: number;
}

export interface BuildTransientEnvironmentHintOptions {
  currentDirectory?: string;
  provider?: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  gitInfo?: GitRepositoryInfo | null;
}

export function buildTransientEnvironmentHint(
  options: BuildTransientEnvironmentHintOptions,
): Message | null {
  const currentDirectory = options.currentDirectory?.trim();
  if (!currentDirectory) return null;

  const env = options.env ?? process.env;
  const gitInfo = options.gitInfo === undefined
    ? resolveGitRepositoryInfo(currentDirectory)
    : options.gitInfo;

  const lines = [
    TRANSIENT_CURRENT_DIRECTORY_PREFIX,
    'Runtime context only. Not a user request. Do not answer.',
    `cwd: ${currentDirectory}`,
    renderModelInfo(options.provider, options.model),
    `os: ${process.platform}`,
    `shell: ${resolveShellName(env)}`,
    gitInfo ? renderGitInfo(gitInfo, currentDirectory) : '',
    'Use cwd for relative file and shell paths.',
  ].filter(Boolean);

  return {
    role: 'user',
    content: lines.join('\n'),
    __injected: true,
  };
}

export function resolveShellName(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32' && env.PSModulePath) return 'powershell';
  const raw = env.SHELL || env.ComSpec || env.COMSPEC || (env.PSModulePath ? 'powershell' : '');
  if (!raw) return 'unknown';
  const basename = path.win32.basename(raw);
  return basename.replace(/\.(exe|cmd|bat)$/i, '') || raw;
}

export function resolveGitRepositoryInfo(currentDirectory: string): GitRepositoryInfo | null {
  const gitRoot = findGitRoot(currentDirectory);
  if (!gitRoot) return null;

  try {
    const status = execFileSync(
      'git',
      ['-C', currentDirectory, 'status', '--short', '--branch', '--untracked-files=no'],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 500,
      },
    );
    const lines = status.split(/\r?\n/).filter(Boolean);
    const branch = parseBranch(lines[0]);
    return {
      root: gitRoot,
      ...(branch ? { branch } : {}),
      trackedChanges: Math.max(0, lines.length - 1),
    };
  } catch {
    return { root: gitRoot };
  }
}

function findGitRoot(startDirectory: string): string | null {
  let current = path.resolve(startDirectory);
  if (!fs.existsSync(current)) return null;
  try {
    const stat = fs.statSync(current);
    if (!stat.isDirectory()) {
      current = path.dirname(current);
    }
  } catch {
    return null;
  }

  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function parseBranch(statusHeader?: string): string | undefined {
  if (!statusHeader?.startsWith('## ')) return undefined;
  const branch = statusHeader
    .slice(3)
    .split('...')[0]
    .trim();
  return branch || undefined;
}

function renderGitInfo(info: GitRepositoryInfo, currentDirectory: string): string {
  const relativeRoot = relativeOrAbsolute(currentDirectory, info.root);
  const parts = [
    `root=${relativeRoot}`,
    info.branch ? `branch=${info.branch}` : '',
    typeof info.trackedChanges === 'number' ? `tracked_changes=${info.trackedChanges}` : '',
  ].filter(Boolean);

  return `git: ${parts.join(', ')}`;
}

function renderModelInfo(provider?: string, model?: string): string {
  const normalizedProvider = provider?.trim();
  const normalizedModel = model?.trim();
  if (!normalizedProvider && !normalizedModel) return '';
  if (normalizedProvider && normalizedModel) return `model: ${normalizedProvider}/${normalizedModel}`;
  return `model: ${normalizedProvider || normalizedModel}`;
}

function relativeOrAbsolute(fromDirectory: string, targetDirectory: string): string {
  const relative = path.relative(fromDirectory, targetDirectory);
  if (!relative) return '.';
  if (relative.startsWith('..')) return targetDirectory;
  return relative;
}
