import * as fs from 'fs';
import * as path from 'path';

export interface ToolResultArtifactStoreOptions {
  enabled: boolean;
  rootDirectory?: string;
  sessionId?: string;
  turn?: number;
}

export interface ToolResultArtifactReference {
  artifactId: string;
  ref?: string;
  filePath?: string;
  fileUri?: string;
  writeError?: string;
}

export interface PersistToolResultArtifactParams {
  artifactId: string;
  toolName: string;
  toolCallId?: string;
  sha256: string;
  rawText: string;
  store?: Partial<ToolResultArtifactStoreOptions>;
}

const DEFAULT_STORE_OPTIONS: ToolResultArtifactStoreOptions = {
  enabled: false,
};

export function resolveToolResultArtifactStoreOptions(
  env: NodeJS.ProcessEnv = process.env,
  defaults: Partial<ToolResultArtifactStoreOptions> = {},
): ToolResultArtifactStoreOptions {
  const fallback = { ...DEFAULT_STORE_OPTIONS, ...defaults };
  const envRootDirectory = stringEnv(env.XIAOBA_TOOL_RESULT_ARTIFACT_DIR);
  const rootDirectory = envRootDirectory || fallback.rootDirectory;
  const defaultEnabled = fallback.enabled || Boolean(envRootDirectory);
  return {
    enabled: readBooleanEnv(env.XIAOBA_TOOL_RESULT_ARTIFACTS, defaultEnabled),
    rootDirectory,
    sessionId: fallback.sessionId,
    turn: fallback.turn,
  };
}

export function persistToolResultArtifact(
  params: PersistToolResultArtifactParams,
): ToolResultArtifactReference {
  const resolved = { ...DEFAULT_STORE_OPTIONS, ...params.store };
  const artifactId = sanitizeFileSegment(params.artifactId);
  if (!resolved.enabled || !resolved.rootDirectory) {
    return { artifactId };
  }

  const sessionSegment = sanitizeFileSegment(resolved.sessionId || 'unknown-session');
  const turnSegment = typeof resolved.turn === 'number' && Number.isFinite(resolved.turn)
    ? `turn-${String(Math.max(0, Math.floor(resolved.turn))).padStart(4, '0')}`
    : 'turn-unknown';
  const directory = path.resolve(resolved.rootDirectory, sessionSegment, turnSegment);
  const filePath = path.join(directory, `${artifactId}.txt`);
  const ref = `tool-result://${sessionSegment}/${turnSegment}/${artifactId}`;

  try {
    fs.mkdirSync(directory, { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, buildArtifactPayload(params), 'utf8');
    }
    return {
      artifactId,
      ref,
      filePath,
      fileUri: toFileUri(filePath),
    };
  } catch (error: any) {
    return {
      artifactId,
      ref,
      writeError: error?.message || String(error),
    };
  }
}

function buildArtifactPayload(params: PersistToolResultArtifactParams): string {
  return [
    `tool_name: ${params.toolName}`,
    params.toolCallId ? `tool_call_id: ${params.toolCallId}` : '',
    `sha256: ${params.sha256}`,
    '',
    params.rawText,
  ].filter(Boolean).join('\n');
}

function toFileUri(filePath: string): string {
  const normalized = path.resolve(filePath).replace(/\\/g, '/');
  return normalized.startsWith('/')
    ? `file://${normalized}`
    : `file:///${normalized}`;
}

function sanitizeFileSegment(value: string): string {
  const sanitized = String(value || '')
    .replace(/[%/\\:*?"<>|\s]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized || 'unknown';
}

function stringEnv(value: string | undefined, fallback?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function readBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return fallback;
}
