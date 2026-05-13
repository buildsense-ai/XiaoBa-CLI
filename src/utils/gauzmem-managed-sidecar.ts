import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { resolveGauzMemProjectPath, resolveGauzMemProjectRoot } from './gauzmem-paths';

export interface ManagedGauzMemOptions {
  baseUrl: string;
  rootPaths: string[];
  token?: string;
  timeoutMs: number;
  moduleRoot?: string;
  storeRoot?: string;
  env?: NodeJS.ProcessEnv;
}

let managedStart: Promise<string> | null = null;
let managedChild: ChildProcess | null = null;
let cleanupRegistered = false;

export function shouldUseManagedGauzMem(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = String(env.GAUZMEM_MODE || env.GAUZMEM_TRANSPORT || '').trim().toLowerCase();
  return mode === 'managed' || mode === 'auto' || String(env.GAUZMEM_MANAGED || '').toLowerCase() === 'true';
}

export async function ensureManagedGauzMemSidecar(options: ManagedGauzMemOptions): Promise<string> {
  if (await isHealthy(options.baseUrl, options.token, 500)) {
    return options.baseUrl;
  }

  if (!managedStart) {
    managedStart = startManagedSidecar(options).catch(error => {
      managedStart = null;
      throw error;
    });
  }

  return managedStart;
}

export async function stopManagedGauzMemSidecar(): Promise<void> {
  const child = managedChild;
  managedChild = null;
  managedStart = null;
  if (!child || child.exitCode !== null) return;

  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 1000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

async function startManagedSidecar(options: ManagedGauzMemOptions): Promise<string> {
  const env = options.env ?? process.env;
  const moduleRoot = resolveModuleRoot(options.moduleRoot, env);
  const cliPath = path.join(moduleRoot, 'src', 'cli.js');
  if (!fs.existsSync(cliPath)) {
    throw new Error(`GauzMem managed module not found: ${cliPath}`);
  }

  const parsedUrl = new URL(options.baseUrl);
  const host = parsedUrl.hostname || '127.0.0.1';
  const port = parsedUrl.port || '8788';
  const storeRoot = resolveStoreRoot(options.storeRoot || env.GAUZMEM_STORE_ROOT, moduleRoot);
  const envFile = resolveEnvFile(env.GAUZMEM_ENV_FILE, moduleRoot);
  const allowedRoots = resolveAllowedRoots(options.rootPaths, env);
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    GAUZMEM_ENV_FILE: envFile,
    GAUZMEM_ALLOWED_ROOTS: allowedRoots,
  };

  const child = spawn(process.execPath, [
    cliPath,
    'serve',
    '--store', storeRoot,
    '--host', host,
    '--port', port,
  ], {
    cwd: moduleRoot,
    env: childEnv,
    stdio: 'ignore',
  });
  child.unref();
  managedChild = child;
  registerCleanup();

  let stderr = '';
  child.stderr?.on('data', chunk => {
    stderr += String(chunk);
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  const readyTimeoutMs = parsePositiveInt(env.GAUZMEM_MANAGED_START_TIMEOUT_MS, Math.max(5000, options.timeoutMs));
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`GauzMem managed sidecar exited early (${child.exitCode}): ${stderr.trim()}`);
    }
    if (await isHealthy(options.baseUrl, options.token, 500)) {
      return options.baseUrl;
    }
    await delay(150);
  }

  throw new Error(`GauzMem managed sidecar did not become ready at ${options.baseUrl}: ${stderr.trim()}`);
}

function resolveModuleRoot(moduleRoot: string | undefined, env: NodeJS.ProcessEnv): string {
  const configured = moduleRoot || env.GAUZMEM_MODULE_ROOT;
  if (configured) return resolveGauzMemProjectPath(configured);
  return path.resolve(resolveGauzMemProjectRoot(), 'modules', 'gauzmem');
}

function resolveStoreRoot(storeRoot: string | undefined, moduleRoot: string): string {
  if (!storeRoot || !storeRoot.trim()) return path.join(moduleRoot, '.gauzmem-zero');
  return resolveGauzMemProjectPath(storeRoot);
}

function resolveEnvFile(envFile: string | undefined, moduleRoot: string): string {
  if (!envFile || !envFile.trim()) return path.join(moduleRoot, '.env');
  return resolveGauzMemProjectPath(envFile);
}

function resolveAllowedRoots(rootPaths: string[], env: NodeJS.ProcessEnv): string {
  const explicit = env.GAUZMEM_ALLOWED_ROOTS;
  const roots = explicit && explicit.trim()
    ? explicit.split(path.delimiter).map(item => item.trim()).filter(Boolean)
    : rootPaths.length > 0
      ? rootPaths
      : [resolveGauzMemProjectPath('logs/sessions')];
  return roots.map(resolveGauzMemProjectPath).join(path.delimiter);
}

async function isHealthy(baseUrl: string, token: string | undefined, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`${baseUrl}/v1/health`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null) as any;
    return body?.ok === true && body?.mode === 'zero-index';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once('exit', () => {
    if (managedChild && managedChild.exitCode === null) {
      managedChild.kill();
    }
  });
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
