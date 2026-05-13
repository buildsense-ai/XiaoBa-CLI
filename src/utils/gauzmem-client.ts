import * as path from 'path';
import {
  ensureManagedGauzMemSidecar,
  shouldUseManagedGauzMem,
} from './gauzmem-managed-sidecar';
import { resolveGauzMemProjectPath } from './gauzmem-paths';

export const GAUZMEM_TRANSIENT_PREFIX = '[transient_gauzmem_recall]';

export interface GauzMemRetrieveOptions {
  query: string;
  sessionId: string;
  sessionType?: string;
  rootPaths?: string[];
  maxTerms?: number;
  maxEvidence?: number;
  maxGraphHops?: number;
}

export interface GauzMemRetrieveResult {
  runId: string;
  promptBundle: string;
  memoryBundle?: {
    text?: string;
    evidenceIds?: string[];
    edgeIds?: string[];
  };
  evidence?: unknown[];
  disclosedGraph?: {
    nodes?: unknown[];
    edges?: unknown[];
  };
  searchTrace?: unknown[];
  stats?: unknown;
}

export interface GauzMemTurnMetadataOptions {
  turnId?: string;
  sessionId: string;
  sessionType?: string;
  userTextHash?: string;
  assistantTextHash?: string;
  gauzmemRunIds: string[];
  metadata?: Record<string, unknown>;
}

export interface GauzMemClientOptions {
  enabled?: boolean;
  managed?: boolean;
  baseUrl?: string;
  timeoutMs?: number;
  rootPaths?: string[];
  token?: string;
  moduleRoot?: string;
  storeRoot?: string;
  env?: NodeJS.ProcessEnv;
}

function isEnabled(env: NodeJS.ProcessEnv): boolean {
  return String(env.GAUZMEM_ENABLED || '').toLowerCase() === 'true';
}

function parseTimeout(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.GAUZMEM_TIMEOUT_MS || 1500);
  return Number.isFinite(raw) && raw > 0 ? raw : 1500;
}

function parseRootPaths(env: NodeJS.ProcessEnv): string[] {
  const raw = env.GAUZMEM_ROOTS || env.GAUZMEM_ROOT_PATHS;
  if (!raw || !raw.trim()) return [resolveGauzMemProjectPath('logs/sessions')];
  return raw
    .split(path.delimiter)
    .map(item => item.trim())
    .filter(Boolean)
    .map(resolveGauzMemProjectPath);
}

export class GauzMemClient {
  readonly enabled: boolean;
  readonly managed: boolean;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly rootPaths: string[];
  readonly token?: string;
  private readonly moduleRoot?: string;
  private readonly storeRoot?: string;

  constructor(options: GauzMemClientOptions = {}) {
    const env = options.env ?? process.env;
    this.enabled = options.enabled ?? isEnabled(env);
    this.managed = options.managed ?? shouldUseManagedGauzMem(env);
    this.baseUrl = (options.baseUrl || env.GAUZMEM_URL || 'http://127.0.0.1:8788').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? parseTimeout(env);
    this.rootPaths = options.rootPaths ?? parseRootPaths(env);
    this.token = options.token ?? env.GAUZMEM_HTTP_TOKEN ?? env.GAUZMEM_AUTH_TOKEN ?? env.GAUZMEM_TOKEN;
    this.moduleRoot = options.moduleRoot ?? env.GAUZMEM_MODULE_ROOT;
    this.storeRoot = options.storeRoot ?? env.GAUZMEM_STORE_ROOT;
  }

  async retrieve(options: GauzMemRetrieveOptions): Promise<GauzMemRetrieveResult | null> {
    return this.retrieveFrom('/v1/retrieve', options);
  }

  async toolSearch(options: GauzMemRetrieveOptions): Promise<GauzMemRetrieveResult | null> {
    return this.retrieveFrom('/v1/tool/search', options);
  }

  async retrievePrompt(options: GauzMemRetrieveOptions): Promise<string | null> {
    const result = await this.retrieve(options);
    if (!result?.promptBundle?.trim()) return null;
    return formatGauzMemPrompt(result);
  }

  async recordTurnMetadata(options: GauzMemTurnMetadataOptions): Promise<void> {
    if (!this.enabled || options.gauzmemRunIds.length === 0) return;
    await this.postJson('/v1/events/turn', {
      agent: 'xiaoba',
      turnId: options.turnId,
      sessionId: options.sessionId,
      sessionType: options.sessionType,
      userTextHash: options.userTextHash,
      assistantTextHash: options.assistantTextHash,
      gauzmemRunIds: options.gauzmemRunIds,
      metadata: options.metadata || {},
    });
  }

  private async retrieveFrom(pathname: string, options: GauzMemRetrieveOptions): Promise<GauzMemRetrieveResult | null> {
    if (!this.enabled) return null;
    const query = options.query.trim();
    if (!query) return null;

    const response = await this.postJson(pathname, {
      agent: 'xiaoba',
      sessionId: options.sessionId,
      sessionType: options.sessionType,
      query,
      rootPaths: options.rootPaths ?? this.rootPaths,
      budget: {
        maxTerms: options.maxTerms ?? 12,
        maxEvidence: options.maxEvidence ?? 12,
        maxGraphHops: options.maxGraphHops ?? 1,
      },
    });

    if (!response || typeof response.promptBundle !== 'string') return null;
    return response as GauzMemRetrieveResult;
  }

  private async postJson(pathname: string, body: unknown): Promise<any> {
    const baseUrl = this.managed
      ? await ensureManagedGauzMemSidecar({
        baseUrl: this.baseUrl,
        rootPaths: this.rootPaths,
        token: this.token,
        timeoutMs: this.timeoutMs,
        moduleRoot: this.moduleRoot,
        storeRoot: this.storeRoot,
      })
      : this.baseUrl;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      const response = await fetch(`${baseUrl}${pathname}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.text().catch(() => '');
        throw new Error(`GauzMem HTTP ${response.status}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

export function formatGauzMemPrompt(result: GauzMemRetrieveResult): string | null {
  if (!result.promptBundle?.trim()) return null;
  return `${GAUZMEM_TRANSIENT_PREFIX}\nrunId: ${result.runId}\n${result.promptBundle}`;
}
