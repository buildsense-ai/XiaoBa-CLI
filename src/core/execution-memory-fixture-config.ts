import fs from 'node:fs';
import path from 'node:path';

export type ExecutionFixtureRole = 'session_a' | 'session_b' | 'both';
export interface ExecutionFixtureAnchor {
  kind: 'source_memory_projection_node';
  source_projection_ref: string;
  revision: string;
  id: string;
}
export interface ExecutionFixtureConfig {
  role: ExecutionFixtureRole;
  sessionId: string;
  fixturePath: string;
  baseUrl?: string;
  token?: string;
  anchor?: ExecutionFixtureAnchor;
}

const anchorRefPattern = /^ref_[a-f0-9]{64}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const nodeIdPattern = /^(?:output-)?[a-f0-9]{64}$/;

function asRecord(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Fixture config must be a JSON object.');
  return value as Record<string, any>;
}
function readJsonFile(filePath: string, name: string): unknown {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { throw new Error(`Could not read ${name} JSON file.`); }
}
function parseAnchor(value: unknown): ExecutionFixtureAnchor {
  const anchor = asRecord(value);
  if (anchor.kind !== 'source_memory_projection_node' || !anchorRefPattern.test(anchor.source_projection_ref)
    || !digestPattern.test(anchor.revision) || !nodeIdPattern.test(anchor.id)) {
    throw new Error('Fixture anchor must be a typed source_memory_projection_node with ref, revision, and id.');
  }
  return {
    kind: anchor.kind,
    source_projection_ref: anchor.source_projection_ref,
    revision: anchor.revision,
    id: anchor.id,
  };
}

/** Resolve the verifier's env adapter and the reusable JSON-file interface. */
export function resolveExecutionFixtureConfig(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (filePath: string, name: string) => unknown = readJsonFile,
): ExecutionFixtureConfig {
  const configPath = env.CATSLOG_EXECUTION_FIXTURE_CONFIG;
  const fileConfig = configPath ? asRecord(readFile(configPath, 'execution fixture config')) : {};
  const role = (env.CATSLOG_EXECUTION_FIXTURE_ROLE || fileConfig.role || fileConfig.mode || 'both') as ExecutionFixtureRole;
  if (!['session_a', 'session_b', 'both'].includes(role)) throw new Error('Fixture role must be session_a, session_b, or both.');

  const sessionId = env.CATSLOG_EXECUTION_SESSION_ID || fileConfig.sessionId || fileConfig.session_id;
  if (typeof sessionId !== 'string' || !sessionId.trim() || Buffer.byteLength(sessionId) > 256) {
    throw new Error('CATSLOG_EXECUTION_SESSION_ID or config sessionId is required.');
  }
  const configuredPath = env.CATSLOG_EXECUTION_FIXTURE_PATH || fileConfig.fixturePath || fileConfig.fixture_path;
  const outputDir = fileConfig.outputDir || fileConfig.output_dir;
  const fixturePath = typeof configuredPath === 'string' && configuredPath.trim()
    ? path.resolve(configuredPath)
    : typeof outputDir === 'string' && outputDir.trim()
      ? path.resolve(outputDir, `${role}.runtime.jsonl`)
      : undefined;
  if (!fixturePath) throw new Error('CATSLOG_EXECUTION_FIXTURE_PATH or config outputDir is required.');

  const baseUrl = env.CATSLOG_GRAPH_API || fileConfig.baseUrl || fileConfig.base_url;
  const token = env.CATSLOG_GRAPH_TOKEN || fileConfig.token;
  if (baseUrl !== undefined) {
    try {
      const parsed = new URL(baseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch { throw new Error('Fixture base URL must be an absolute HTTP(S) URL.'); }
  }
  let anchor: ExecutionFixtureAnchor | undefined;
  const anchorFile = env.CATSLOG_PROJECTION_ANCHOR_FILE || fileConfig.anchorFile || fileConfig.anchor_file;
  if (anchorFile) anchor = parseAnchor(readFile(anchorFile, 'projection anchor'));
  else if (fileConfig.anchor) anchor = parseAnchor(fileConfig.anchor);
  if (role !== 'session_a' && (!baseUrl || typeof token !== 'string' || !token.trim() || !anchor)) {
    throw new Error('Session B requires a base URL, token, and typed projection anchor.');
  }
  return {
    role, sessionId: sessionId.trim(), fixturePath, baseUrl, token, anchor,
  };
}
