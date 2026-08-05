import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface ToolResultArtifactStoreOptions {
  enabled: boolean;
  rootDirectory?: string;
  sessionId?: string;
  /** @deprecated Artifact paths are content-addressed and no longer scoped by model turn. */
  turn?: number;
}

export interface ToolResultArtifactReference {
  artifactId: string;
  /** Whether the complete raw tool result was durably written to an artifact. */
  persisted: boolean;
  ref?: string;
  filePath?: string;
  fileUri?: string;
  writeError?: string;
}

export interface PersistToolResultArtifactParams {
  artifactId: string;
  toolName: string;
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
    return { artifactId, persisted: false };
  }

  const sessionSegment = sanitizeFileSegment(resolved.sessionId || 'unknown-session');
  // Artifact references are part of provider-visible historical tool results. Keep
  // them independent of the current inference turn so folding the same durable
  // history remains byte-identical across requests.
  const directory = path.resolve(resolved.rootDirectory, sessionSegment);
  const filePath = path.join(directory, `${artifactId}.txt`);
  const ref = `tool-result://${sessionSegment}/${artifactId}`;
  const payload = buildArtifactPayload(params);

  try {
    fs.mkdirSync(directory, { recursive: true });
    if (!hasArtifactPayload(filePath, payload)) {
      writeArtifactPayloadAtomically(filePath, payload);
    }
    if (!hasArtifactPayload(filePath, payload)) {
      throw new Error(`Tool result artifact verification failed: ${filePath}`);
    }
    return {
      artifactId,
      persisted: true,
      ref,
      filePath,
      fileUri: toFileUri(filePath),
    };
  } catch (error: any) {
    return {
      artifactId,
      persisted: false,
      ref,
      writeError: error?.message || String(error),
    };
  }
}

function hasArtifactPayload(filePath: string, payload: string): boolean {
  try {
    if (!fs.lstatSync(filePath).isFile()) return false;
    return fs.readFileSync(filePath, 'utf8') === payload;
  } catch {
    return false;
  }
}

function writeArtifactPayloadAtomically(filePath: string, payload: string): void {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  try {
    const descriptor = fs.openSync(temporaryPath, 'wx');
    try {
      fs.writeFileSync(descriptor, payload, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporaryPath, filePath);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function buildArtifactPayload(params: PersistToolResultArtifactParams): string {
  return [
    `tool_name: ${params.toolName}`,
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
