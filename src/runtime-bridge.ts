#!/usr/bin/env node

/**
 * Stable process contract for a host such as CatsLog to wake XiaoBa Runtime
 * Learning against one already-isolated runtime root.
 *
 * This file is deliberately a top-level compiled entry point rather than a
 * private utils import. Hosts may depend on its command names and JSON shape,
 * but not on XiaoBa's internal module layout.
 */

import * as fs from 'fs';
import * as path from 'path';
import { APP_VERSION } from './version';
import { getDistillationHeartbeatConfig } from './utils/distillation-heartbeat-config';
import { buildRuntimeLearningStack } from './utils/runtime-command-support';

export const RUNTIME_BRIDGE_PROTOCOL_VERSION = 1;

export interface RuntimeBridgeDescription {
  protocol_version: number;
  xiaoba_version: string;
  commands: readonly ['describe', 'wake'];
}

export interface RuntimeBridgeWakeResult {
  protocol_version: number;
  status: 'completed' | 'deferred';
  ran: boolean;
  units_processed: number;
  advanced_files: number;
}

interface RuntimeWakeSummary {
  ran: boolean;
  unitsProcessed: number;
  advancedFiles: number;
}

export type RuntimeBridgeCommand = 'describe' | 'wake';

export function describeRuntimeBridge(): RuntimeBridgeDescription {
  return {
    protocol_version: RUNTIME_BRIDGE_PROTOCOL_VERSION,
    xiaoba_version: APP_VERSION,
    commands: ['describe', 'wake'],
  };
}

export function parseRuntimeBridgeCommand(args: readonly string[]): RuntimeBridgeCommand {
  if (args.length === 1 && args[0] === 'describe') return 'describe';
  if (args.length === 1 && args[0] === 'wake') return 'wake';
  throw new Error('usage: runtime-bridge <describe|wake>');
}

export async function wakeRuntimeBridge(runtimeRoot: string): Promise<RuntimeBridgeWakeResult> {
  const resolvedRoot = requiredRuntimeRoot(runtimeRoot);
  // A bridge must never bootstrap CatsLog itself or let a tenant runtime read
  // arbitrary configured external history while consuming canonical evidence.
  process.env.CATSCO_LOG_UPLOAD_ENABLED = 'false';
  process.env.XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED = 'false';
  process.env.DISTILLATION_HEARTBEAT_LOG_ROOT = 'logs';

  const config = getDistillationHeartbeatConfig(resolvedRoot);
  const stack = buildRuntimeLearningStack(resolvedRoot, config);
  const result = await stack.runtimeLearning.wake('session-log-append');
  return summarizeRuntimeBridgeWake(result, readHeartbeatRunStatus(config.heartbeatRecordPath));
}

// RuntimeLearning records a caught cycle exception as a durable `failed`
// heartbeat while returning its partial result with `ran: true`. The bridge is
// the process boundary CatsLog relies on, so it must turn that state into a
// child-process failure rather than silently acknowledging the durable job.
export function summarizeRuntimeBridgeWake(
  result: RuntimeWakeSummary,
  heartbeatRunStatus?: string,
): RuntimeBridgeWakeResult {
  if (heartbeatRunStatus === 'failed') {
    throw new Error('Runtime Learning reported a failed heartbeat');
  }
  return {
    protocol_version: RUNTIME_BRIDGE_PROTOCOL_VERSION,
    status: result.ran ? 'completed' : 'deferred',
    ran: result.ran,
    units_processed: result.unitsProcessed,
    advanced_files: result.advancedFiles,
  };
}

async function main(): Promise<void> {
  const command = parseRuntimeBridgeCommand(process.argv.slice(2));
  if (command === 'describe') {
    writeJSON(describeRuntimeBridge());
    return;
  }
  const runtimeRoot = String(process.env.CATSLOG_RUNTIME_ROOT || '').trim();
  const resolvedRoot = requiredRuntimeRoot(runtimeRoot);
  const workingDirectory = fs.realpathSync(path.resolve(process.cwd()));
  if (workingDirectory !== resolvedRoot) {
    throw new Error('CATSLOG_RUNTIME_ROOT must match the bridge working directory');
  }
  writeJSON(await wakeRuntimeBridge(resolvedRoot));
}

function requiredRuntimeRoot(rawValue: string): string {
  const value = String(rawValue || '').trim();
  if (!value) throw new Error('CATSLOG_RUNTIME_ROOT is required');
  const candidate = path.resolve(value);
  let resolved: string;
  try {
    resolved = fs.realpathSync(candidate);
  } catch {
    throw new Error('CATSLOG_RUNTIME_ROOT must reference an existing directory');
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error('CATSLOG_RUNTIME_ROOT must reference an existing directory');
  }
  return resolved;
}

function readHeartbeatRunStatus(recordPath: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(recordPath, 'utf-8')) as { lastRunStatus?: unknown };
    return typeof parsed.lastRunStatus === 'string' ? parsed.lastRunStatus : undefined;
  } catch {
    // A direct wake can fail before Runtime Learning creates its first record;
    // the process error in that case still reaches CatsLog through stderr.
    return undefined;
  }
}

function writeJSON(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({
      protocol_version: RUNTIME_BRIDGE_PROTOCOL_VERSION,
      error: 'runtime_bridge_failed',
      message,
    })}\n`);
    process.exitCode = 1;
  });
}
