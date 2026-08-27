import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ReviewRunProjection, ReviewTaskRecord } from './review-runtime-types';

const SCHEMA_VERSION = 1 as const;

export interface ApprovalRequest {
  schemaVersion: typeof SCHEMA_VERSION;
  requestId: string;
  sessionKey: string;
  message: string;
  actor: string;
  createdAt: string;
}

export interface ApprovalCommandResult {
  schemaVersion: typeof SCHEMA_VERSION;
  requestId: string;
  ok: boolean;
  completedAt: string;
  projection?: ReviewRunProjection;
  errorCode?: 'APPROVAL_SYNTAX' | 'APPROVAL_AMBIGUOUS' | 'APPROVAL_REASON_REQUIRED' | 'APPROVAL_NOT_PENDING' | 'APPROVAL_EXECUTION_FAILED';
}

export interface ReviewApprovalInboxOptions {
  workspace: string;
  pollIntervalMs?: number;
}

/** Private cross-process handoff from CLI/human input to the persistent Review owner. */
export class ReviewApprovalInbox {
  private readonly requestDir: string;
  private readonly resultDir: string;
  private readonly pollIntervalMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<void>;

  constructor(options: ReviewApprovalInboxOptions) {
    const workspace = path.resolve(options.workspace);
    this.requestDir = path.join(workspace, '.review-approval-inbox');
    this.resultDir = path.join(workspace, '.review-approval-results');
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    if (this.pollIntervalMs < 50) throw new Error('Approval inbox poll interval must be at least 50ms');
  }

  async submit(
    input: Pick<ApprovalRequest, 'sessionKey' | 'message' | 'actor'>,
    timeoutMs = 30_000,
  ): Promise<ApprovalCommandResult> {
    const requestId = randomUUID();
    const request: ApprovalRequest = {
      schemaVersion: SCHEMA_VERSION,
      requestId,
      sessionKey: requireText(input.sessionKey, 'sessionKey'),
      message: requireText(input.message, 'message'),
      actor: requireText(input.actor, 'actor'),
      createdAt: new Date().toISOString(),
    };
    ensurePrivateDir(this.requestDir);
    ensurePrivateDir(this.resultDir);
    atomicWriteJson(path.join(this.requestDir, `${requestId}.json`), request);

    const deadline = Date.now() + timeoutMs;
    const resultPath = path.join(this.resultDir, `${requestId}.json`);
    while (Date.now() < deadline) {
      if (fs.existsSync(resultPath)) {
        const result = readResult(resultPath, requestId);
        try { fs.unlinkSync(resultPath); } catch { /* one-shot result cleanup */ }
        return result;
      }
      await delay(100);
    }
    throw new Error(`Timed out waiting for persistent Review owner (${requestId})`);
  }

  start(handler: (request: ApprovalRequest) => Promise<ReviewRunProjection>): void {
    if (this.timer) return;
    ensurePrivateDir(this.requestDir);
    ensurePrivateDir(this.resultDir);
    this.recoverProcessing();
    const pulse = () => {
      if (this.inFlight) return this.inFlight;
      const current = this.consume(handler).finally(() => {
        if (this.inFlight === current) this.inFlight = undefined;
      });
      this.inFlight = current;
      return current;
    };
    void pulse();
    this.timer = setInterval(() => void pulse(), this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  private async consume(handler: (request: ApprovalRequest) => Promise<ReviewRunProjection>): Promise<void> {
    for (const name of listRequests(this.requestDir)) {
      const requestPath = path.join(this.requestDir, name);
      const processingPath = `${requestPath}.processing`;
      try { fs.renameSync(requestPath, processingPath); } catch { continue; }
      let requestId = name.slice(0, -5);
      let result: ApprovalCommandResult;
      try {
        const request = readRequest(processingPath, requestId);
        requestId = request.requestId;
        const projection = await handler(request);
        result = { schemaVersion: SCHEMA_VERSION, requestId, ok: true, completedAt: new Date().toISOString(), projection };
      } catch (error) {
        result = {
          schemaVersion: SCHEMA_VERSION,
          requestId,
          ok: false,
          completedAt: new Date().toISOString(),
          errorCode: controlledErrorCode(error),
        };
      }
      atomicWriteJson(path.join(this.resultDir, `${requestId}.json`), result);
      try { fs.unlinkSync(processingPath); } catch { /* result is already durable */ }
    }
  }

  private recoverProcessing(): void {
    for (const name of safeList(this.requestDir).filter(item => item.endsWith('.json.processing'))) {
      const processing = path.join(this.requestDir, name);
      const request = processing.slice(0, -'.processing'.length);
      try {
        if (fs.existsSync(request)) fs.unlinkSync(processing);
        else fs.renameSync(processing, request);
      } catch { /* retry on a later owner start */ }
    }
  }
}

export function approvalHandlerForAdapter(adapter: {
  handleHumanSessionReply(sessionKey: string, message: string, actor: string): Promise<ReviewTaskRecord>;
  getProjection(runId: string): ReviewRunProjection;
}): (request: ApprovalRequest) => Promise<ReviewRunProjection> {
  return async request => {
    const task = await adapter.handleHumanSessionReply(request.sessionKey, request.message, request.actor);
    return adapter.getProjection(task.runId);
  };
}

function controlledErrorCode(error: unknown): NonNullable<ApprovalCommandResult['errorCode']> {
  const message = error instanceof Error ? error.message : String(error);
  if (/start with 批准|Reply must start/i.test(message)) return 'APPROVAL_SYNTAX';
  if (/Multiple Tasks|exact Task ID/i.test(message)) return 'APPROVAL_AMBIGUOUS';
  if (/rejection must include|include a reason/i.test(message)) return 'APPROVAL_REASON_REQUIRED';
  if (/no Task awaiting|cannot be approved|cannot be rejected/i.test(message)) return 'APPROVAL_NOT_PENDING';
  return 'APPROVAL_EXECUTION_FAILED';
}

function readRequest(filePath: string, expectedId: string): ApprovalRequest {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<ApprovalRequest>;
  if (value.schemaVersion !== SCHEMA_VERSION || value.requestId !== expectedId) throw new Error('Invalid approval request');
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId: expectedId,
    sessionKey: requireText(value.sessionKey, 'sessionKey'),
    message: requireText(value.message, 'message'),
    actor: requireText(value.actor, 'actor'),
    createdAt: requireText(value.createdAt, 'createdAt'),
  };
}

function readResult(filePath: string, expectedId: string): ApprovalCommandResult {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ApprovalCommandResult;
  if (value.schemaVersion !== SCHEMA_VERSION || value.requestId !== expectedId || typeof value.ok !== 'boolean') {
    throw new Error('Invalid approval command result');
  }
  return value;
}

function listRequests(directory: string): string[] {
  return safeList(directory).filter(name => /^[a-f0-9-]+\.json$/i.test(name)).sort();
}
function safeList(directory: string): string[] {
  try { return fs.readdirSync(directory); } catch { return []; }
}
function ensurePrivateDir(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* Windows */ }
}
function atomicWriteJson(filePath: string, value: unknown): void {
  ensurePrivateDir(path.dirname(filePath));
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(temp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* Windows */ }
}
function requireText(value: string | undefined, field: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`${field} is required`);
  return text;
}
function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
