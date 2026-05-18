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

export interface CatscoLogAgentState {
  schemaVersion?: 1;
  deviceId?: string;
  userId?: string;
  externalProvider?: string;
  externalUserId?: string;
  tokenId?: string;
  token?: string;
  tokenIssuedAt?: string;
  stateCorrupt?: boolean;
  uploaded: Record<string, CatscoUploadedFileState>;
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
    };
  } catch {
    quarantineCorruptState(stateFilePath);
    return { schemaVersion: 1, uploaded: {}, stateCorrupt: true };
  }
}

export function saveCatscoLogAgentState(stateFilePath: string, state: CatscoLogAgentState): void {
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  const payload: CatscoLogAgentState = {
    ...state,
    schemaVersion: 1,
    uploaded: state.uploaded || {},
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
