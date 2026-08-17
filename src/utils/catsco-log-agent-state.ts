import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface CatscoUploadedFileState {
  size: number;
  mtimeMs: number;
  uploadedAt: string;
  uploadId?: string;
  sha256?: string;
}

export interface CatscoUploadConflictState {
  size: number;
  mtimeMs: number;
  detectedAt: string;
  status?: string;
  parseStatus?: string;
  uploadId?: string;
  sha256?: string;
  acceptedOffset?: number;
  revision?: string;
}

export interface CatscoBlockedFileState {
  size: number;
  mtimeMs: number;
  blockedAt: string;
  reason: 'file_too_large' | 'append_line_too_large';
  maxFileBytes: number;
}

export interface CatscoAppendInFlightState {
  requestId: string;
  expectedOffset: number;
  expectedRevision: string;
  length: number;
  sha256: string;
}

export interface CatscoAppendFileState {
  offset: number;
  revision: string;
  updatedAt: string;
  inFlight?: CatscoAppendInFlightState;
}

export interface CatscoLogAgentState {
  schemaVersion?: 1;
  deviceId?: string;
  userId?: string;
  externalProvider?: string;
  externalUserId?: string;
  tokenId?: string;
  token?: string;
  tokenIssuedAt?: string;
  tokenExpiresAt?: string;
  uploadProtocol?: 1 | 2;
  appendUrl?: string;
  stateCorrupt?: boolean;
  uploaded: Record<string, CatscoUploadedFileState>;
  conflicts?: Record<string, CatscoUploadConflictState>;
  blocked?: Record<string, CatscoBlockedFileState>;
  appends?: Record<string, CatscoAppendFileState>;
}

export function loadCatscoLogAgentState(stateFilePath: string): CatscoLogAgentState {
  try {
    if (!fs.existsSync(stateFilePath)) {
      return { uploaded: {} };
    }
    const parsed = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8')) as Partial<CatscoLogAgentState>;
    return {
      ...parsed,
      schemaVersion: 1,
      uploaded: parsed.uploaded || {},
      conflicts: parsed.conflicts || {},
      blocked: parsed.blocked || {},
      appends: parsed.appends || {},
    };
  } catch {
    quarantineCorruptState(stateFilePath);
    return { schemaVersion: 1, uploaded: {}, conflicts: {}, blocked: {}, stateCorrupt: true };
  }
}

export function saveCatscoLogAgentState(stateFilePath: string, state: CatscoLogAgentState): void {
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  const payload: CatscoLogAgentState = {
    ...state,
    schemaVersion: 1,
    uploaded: state.uploaded || {},
    conflicts: state.conflicts || {},
    blocked: state.blocked || {},
    appends: state.appends || {},
  };
  const tmpPath = `${stateFilePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmpPath, stateFilePath);
}

export function ensureCatscoDeviceId(state: CatscoLogAgentState): string {
  if (!state.deviceId) {
    state.deviceId = `device_${crypto.randomUUID().replace(/-/g, '')}`;
  }
  return state.deviceId;
}

export function clearCatscoLogToken(state: CatscoLogAgentState): void {
  delete state.userId;
  delete state.externalProvider;
  delete state.externalUserId;
  delete state.tokenId;
  delete state.token;
  delete state.tokenIssuedAt;
  delete state.tokenExpiresAt;
  delete state.uploadProtocol;
  delete state.appendUrl;
}

function quarantineCorruptState(stateFilePath: string): void {
  try {
    if (!fs.existsSync(stateFilePath)) return;
    const corruptPath = `${stateFilePath}.corrupt.${Date.now()}`;
    fs.renameSync(stateFilePath, corruptPath);
  } catch {
    // Best-effort quarantine only. The scheduler will pause upload for this cycle.
  }
}
