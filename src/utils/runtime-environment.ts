import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

export type RuntimeBinaryName = 'node' | 'python' | 'git';
export type RuntimeBinarySource = 'bundled' | 'system' | 'missing';

export interface RuntimeBinary {
  name: RuntimeBinaryName;
  executable?: string;
  source: RuntimeBinarySource;
  directory?: string;
  version?: string;
  searchRoots: string[];
  diagnostics: string[];
}

export interface RuntimeEnvironmentOptions {
  env?: NodeJS.ProcessEnv;
  appRoot?: string;
  runtimeRoot?: string;
  isPackaged?: boolean;
  includeSystemFallback?: boolean;
  probeVersion?: boolean;
  shimDirectory?: string;
}

export interface RuntimeEnvironment {
  env: NodeJS.ProcessEnv;
  binaries: Record<RuntimeBinaryName, RuntimeBinary>;
  pathKey: string;
  prependedPaths: string[];
  runtimeRoot?: string;
  shimDirectory?: string;
}

const IS_WINDOWS = process.platform === 'win32';
const MODULE_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DEV_RUNTIME_ROOT = path.join(MODULE_ROOT, 'build-resources', 'runtime');
const LEGACY_DEV_RUNTIME_ROOT = path.join(MODULE_ROOT, 'build-resources');
const DEFAULT_SHIM_DIRECTORY = path.join(os.tmpdir(), 'xiaoba-runtime-shims');

const BUNDLED_RELATIVE_PATHS: Record<RuntimeBinaryName, string[]> = {
  node: IS_WINDOWS
    ? [path.join('node', 'node.exe')]
    : [path.join('node', 'bin', 'node'), path.join('node', 'node')],
  python: IS_WINDOWS
    ? [path.join('python', 'python.exe'), path.join('python', 'bin', 'python.exe')]
    : [path.join('python', 'bin', 'python3'), path.join('python', 'bin', 'python')],
  git: IS_WINDOWS
    ? [path.join('git', 'cmd', 'git.exe'), path.join('git', 'bin', 'git.exe')]
    : [path.join('git', 'bin', 'git')],
};

const SYSTEM_COMMANDS: Record<RuntimeBinaryName, string[]> = {
  node: ['node'],
  python: IS_WINDOWS ? ['python', 'python3', 'py'] : ['python3', 'python'],
  git: ['git'],
};

const SHIM_COMMAND_NAMES: Record<RuntimeBinaryName, string[]> = {
  node: ['node'],
  python: ['python', 'python3'],
  git: ['git'],
};

export function resolveRuntimeEnvironment(options: RuntimeEnvironmentOptions = {}): RuntimeEnvironment {
  const env: NodeJS.ProcessEnv = { ...(options.env || process.env) };
  const pathKey = getPathKey(env);
  const runtimeRoot = resolveRuntimeRoot(env, options);
  const includeSystemFallback = options.includeSystemFallback !== false;
  const probeVersion = options.probeVersion !== false;

  const binaries: Record<RuntimeBinaryName, RuntimeBinary> = {
    node: resolveBinary('node', env, runtimeRoot, includeSystemFallback, probeVersion),
    python: resolveBinary('python', env, runtimeRoot, includeSystemFallback, probeVersion),
    git: resolveBinary('git', env, runtimeRoot, includeSystemFallback, probeVersion),
  };

  const shimDirectory = ensureRuntimeShims(
    binaries,
    options.shimDirectory || env.XIAOBA_RUNTIME_SHIM_DIR || DEFAULT_SHIM_DIRECTORY,
  );

  const currentPathEntries = splitPathEntries(env[pathKey]);
  const bundledDirectories = orderedUnique(
    Object.values(binaries)
      .filter((binary): binary is RuntimeBinary & { directory: string } => binary.source === 'bundled' && Boolean(binary.directory))
      .map(binary => binary.directory),
  );
  const preferredEntries = orderedUnique(
    [shimDirectory, ...bundledDirectories].filter((value): value is string => Boolean(value)),
  );
  const prependedPaths = preferredEntries.filter(entry => !containsPath(currentPathEntries, entry));
  const nextPath = orderedUnique([...preferredEntries, ...currentPathEntries]);

  if (nextPath.length > 0) {
    setPathValue(env, pathKey, nextPath.join(path.delimiter));
  }

  if (runtimeRoot) {
    env.XIAOBA_RUNTIME_ROOT = runtimeRoot;
  }

  if (shimDirectory) {
    env.XIAOBA_RUNTIME_SHIM_DIR = shimDirectory;
  }

  return {
    env,
    binaries,
    pathKey,
    prependedPaths,
    runtimeRoot,
    shimDirectory,
  };
}

export function formatRuntimeSummary(binary: RuntimeBinary): string {
  if (!binary.executable) {
    return `${binary.name}: missing`;
  }

  const versionSuffix = binary.version ? ` (${binary.version})` : '';
  return `${binary.name}: ${binary.source} -> ${binary.executable}${versionSuffix}`;
}

function resolveBinary(
  name: RuntimeBinaryName,
  env: NodeJS.ProcessEnv,
  runtimeRoot: string | undefined,
  includeSystemFallback: boolean,
  probeVersion: boolean,
): RuntimeBinary {
  const diagnostics: string[] = [];
  const searchRoots = collectSearchRoots(runtimeRoot);

  for (const root of searchRoots) {
    for (const relativePath of BUNDLED_RELATIVE_PATHS[name]) {
      const candidate = path.join(root, relativePath);
      if (fs.existsSync(candidate)) {
        diagnostics.push(`Resolved bundled binary from ${candidate}`);
        return finalizeBinary(name, candidate, 'bundled', searchRoots, diagnostics, env, probeVersion);
      }
    }
  }

  if (includeSystemFallback) {
    for (const command of SYSTEM_COMMANDS[name]) {
      const systemExecutable = resolveSystemExecutable(command, env);
      if (systemExecutable) {
        diagnostics.push(`Resolved from system PATH using ${command}`);
        return finalizeBinary(name, systemExecutable, 'system', searchRoots, diagnostics, env, probeVersion);
      }
    }
  }

  diagnostics.push('Runtime binary not found');
  return {
    name,
    source: 'missing',
    searchRoots,
    diagnostics,
  };
}

function finalizeBinary(
  name: RuntimeBinaryName,
  executable: string,
  source: RuntimeBinarySource,
  searchRoots: string[],
  diagnostics: string[],
  env: NodeJS.ProcessEnv,
  probeVersion: boolean,
): RuntimeBinary {
  const version = probeVersion ? getVersion(executable, env) : undefined;
  return {
    name,
    executable,
    source,
    directory: path.dirname(executable),
    version,
    searchRoots,
    diagnostics,
  };
}

function resolveRuntimeRoot(env: NodeJS.ProcessEnv, options: RuntimeEnvironmentOptions): string | undefined {
  const candidates = orderedUnique(
    [
      options.runtimeRoot,
      env.XIAOBA_RUNTIME_ROOT,
      options.appRoot ? path.join(options.appRoot, 'build-resources', 'runtime') : undefined,
      DEFAULT_DEV_RUNTIME_ROOT,
    ].filter((value): value is string => Boolean(value)),
  );

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  return candidates[0];
}

function collectSearchRoots(runtimeRoot: string | undefined): string[] {
  if (runtimeRoot) {
    return [runtimeRoot];
  }

  return orderedUnique([DEFAULT_DEV_RUNTIME_ROOT, LEGACY_DEV_RUNTIME_ROOT]);
}

function resolveSystemExecutable(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const lookupCommand = IS_WINDOWS ? 'where' : 'which';
  const result = spawnSync(lookupCommand, [command], {
    encoding: 'utf8',
    env,
    windowsHide: true,
  });

  if (result.status !== 0) {
    return undefined;
  }

  const output = `${result.stdout || ''}${result.stderr || ''}`
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => Boolean(line));

  if (!output) {
    return undefined;
  }

  return fs.existsSync(output) ? output : undefined;
}

function getVersion(executable: string, env: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    env,
    windowsHide: true,
  });

  if (result.error) {
    return undefined;
  }

  const output = `${result.stdout || ''}${result.stderr || ''}`
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => Boolean(line));

  return output || undefined;
}

function ensureRuntimeShims(
  binaries: Record<RuntimeBinaryName, RuntimeBinary>,
  shimDirectory: string,
): string | undefined {
  const availableBinaries = Object.values(binaries).filter(
    (binary): binary is RuntimeBinary & { executable: string } => Boolean(binary.executable),
  );
  if (availableBinaries.length === 0) {
    return undefined;
  }

  try {
    fs.mkdirSync(shimDirectory, { recursive: true });

    for (const binary of availableBinaries) {
      if (containsPath([shimDirectory], path.dirname(binary.executable))) {
        continue;
      }

      for (const commandName of SHIM_COMMAND_NAMES[binary.name]) {
        const shimPath = path.join(shimDirectory, IS_WINDOWS ? `${commandName}.cmd` : commandName);
        const shimContent = buildShimContent(binary.executable);
        fs.writeFileSync(shimPath, shimContent, 'utf8');
        if (!IS_WINDOWS) {
          fs.chmodSync(shimPath, 0o755);
        }
      }
    }

    return shimDirectory;
  } catch {
    return undefined;
  }
}

function buildShimContent(executable: string): string {
  if (IS_WINDOWS) {
    return `@echo off\r\n"${executable}" %*\r\n`;
  }

  return `#!/bin/sh\n"${executable}" "$@"\n`;
}

function getPathKey(env: NodeJS.ProcessEnv): string {
  if (IS_WINDOWS && Object.prototype.hasOwnProperty.call(env, 'Path')) {
    return 'Path';
  }

  const existingKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
  return existingKey || (IS_WINDOWS ? 'Path' : 'PATH');
}

function setPathValue(env: NodeJS.ProcessEnv, pathKey: string, value: string): void {
  for (const key of Object.keys(env)) {
    if (key !== pathKey && key.toLowerCase() === 'path') {
      delete env[key];
    }
  }

  env[pathKey] = value;
}

function splitPathEntries(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(entry => Boolean(entry));
}

function containsPath(entries: string[], candidate: string): boolean {
  const normalizedCandidate = normalizePath(candidate);
  return entries.some(entry => normalizePath(entry) === normalizedCandidate);
}

function orderedUnique(entries: string[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const entry of entries) {
    const normalized = normalizePath(entry);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    results.push(entry);
  }

  return results;
}

function normalizePath(value: string): string {
  const normalized = path.normalize(value);
  return IS_WINDOWS ? normalized.toLowerCase() : normalized;
}
