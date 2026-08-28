import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// The upload scheduler and memory provider can bootstrap concurrently at
// runtime startup. Reuse one generated identity per state file in this
// process so those handshakes cannot accidentally create two device scopes.
const processDeviceIds = new Map<string, string>();

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
  /** Short-lived device-bound read capability returned by CatsLog bootstrap. */
  skillTokenId?: string;
  skillToken?: string;
  skillTokenExpiresAt?: string;
  skillsUrl?: string;
  skillGraphUrl?: string;
  memoryUrl?: string;
  memoryRecallUrl?: string;
  memoryNotesUrl?: string;
  sessionsUrl?: string;
  /** Separate write-only capability; never use it for reads. */
  memoryWriteTokenId?: string;
  memoryWriteToken?: string;
  memoryWriteTokenExpiresAt?: string;
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

export function ensureCatscoDeviceId(
  state: CatscoLogAgentState,
  stateFilePath?: string,
): string {
  const cacheKey = stateFilePath ? path.resolve(stateFilePath) : undefined;
  const current = typeof state.deviceId === 'string' ? state.deviceId.trim() : '';
  if (current) {
    state.deviceId = current;
    if (cacheKey) processDeviceIds.set(cacheKey, current);
    return current;
  }
  if (cacheKey) {
    const cached = processDeviceIds.get(cacheKey);
    if (cached) {
      state.deviceId = cached;
      return cached;
    }
  }
  state.deviceId = `device_${crypto.randomUUID().replace(/-/g, '')}`;
  if (cacheKey) processDeviceIds.set(cacheKey, state.deviceId);
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

/** Clear read capabilities while preserving the upload token/session. */
export function clearCatscoSkillToken(state: CatscoLogAgentState): void {
  delete state.skillTokenId;
  delete state.skillToken;
  delete state.skillTokenExpiresAt;
  delete state.skillsUrl;
  delete state.skillGraphUrl;
  delete state.memoryUrl;
  delete state.memoryRecallUrl;
  delete state.sessionsUrl;
}

/** Clear only the note write capability while preserving read credentials. */
export function clearCatscoMemoryWriteToken(state: CatscoLogAgentState): void {
  delete state.memoryWriteTokenId;
  delete state.memoryWriteToken;
  delete state.memoryWriteTokenExpiresAt;
  delete state.memoryNotesUrl;
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
