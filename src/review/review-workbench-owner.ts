import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { Logger } from '../utils/logger';

export interface ReviewWorkbenchOwner {
  pid?: number;
  stop(): Promise<void>;
}

export interface StartReviewWorkbenchOwnerOptions {
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
}

/** Own the read-only Finding Pool process inside the persistent Dashboard. */
export async function startReviewWorkbenchOwner(
  options: StartReviewWorkbenchOwnerOptions,
): Promise<ReviewWorkbenchOwner | undefined> {
  const projectRoot = path.resolve(options.projectRoot);
  const env = effectiveEnv(projectRoot, options.env ?? process.env);
  if (!/^(1|true|yes)$/i.test(String(env.XIAOBA_REVIEW_WORKBENCH_ENABLED || '').trim())) return undefined;

  const workspace = path.resolve(env.XIAOBA_REVIEW_WORKSPACE
    || path.join(projectRoot, 'review', 'evidence-envelopes'));
  const script = path.join(projectRoot, 'skills', 'build-evidence-envelope-review', 'scripts', 'webapp_server.py');
  if (!fs.existsSync(path.join(workspace, 'registry.sqlite3')) || !fs.existsSync(script)) return undefined;

  const host = String(env.XIAOBA_REVIEW_WORKBENCH_HOST || '127.0.0.1').trim();
  const port = parsePort(env.XIAOBA_REVIEW_WORKBENCH_PORT);
  const python = String(env.XIAOBA_PYTHON_EXECUTABLE || '/usr/bin/python3').trim();
  const child = spawn(python, [
    script,
    '--workspace', workspace,
    '--host', host,
    '--port', String(port),
    '--read-only',
  ], {
    cwd: projectRoot,
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout?.resume();
  child.stderr?.resume();
  await assertStarted(child);
  Logger.info(`Review Workbench owner started (${host}:${port}, read-only)`);

  return {
    pid: child.pid,
    stop: () => stopChild(child),
  };
}

function effectiveEnv(projectRoot: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const envPath = path.join(projectRoot, '.env');
  let fileEnv: Record<string, string> = {};
  try {
    if (fs.existsSync(envPath)) fileEnv = dotenv.parse(fs.readFileSync(envPath, 'utf-8'));
  } catch {
    // Invalid optional .env cannot alter the process environment.
  }
  return { ...fileEnv, ...env };
}

function parsePort(raw: string | undefined): number {
  const value = raw?.trim() ? Number(raw) : 18772;
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error('XIAOBA_REVIEW_WORKBENCH_PORT must be an integer from 1 to 65535');
  }
  return value;
}

function assertStarted(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      error ? reject(error) : resolve();
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null) => finish(new Error(`Review Workbench exited during startup (${code ?? 'signal'})`));
    const timer = setTimeout(() => finish(), 350);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      resolve();
    };
    child.once('exit', finish);
    try { child.kill('SIGTERM'); } catch { finish(); return; }
    forceTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      finish();
    }, 5_000);
  });
}
