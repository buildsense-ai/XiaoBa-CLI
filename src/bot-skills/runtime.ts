import * as crypto from 'crypto';
import * as path from 'path';
import type { CatsCoAuthSnapshot } from '../catscompany/local-config';
import { FileBotDefinitionRepository } from '../bot-definition/repository';
import type { BotDefinition } from '../bot-definition/types';
import { bootstrapDefaultSkillHubSkills } from '../skillhub/default-skill-bootstrap';
import { loadSkillHubConfig } from '../skillhub/config';
import { FileBotSkillSyncBaseStore } from './base-store';
import type { BotDefinitionCloudClient } from './definition-cloud';
import { HttpBotDefinitionCloudClient } from './definition-cloud';
import { FileBotDefinitionCloudClient } from './file-definition-cloud';
import { FileBotPrivateSkillPackageClient } from './file-private-package';
import { HttpBotPrivateSkillPackageClient } from './http-private-package';
import type { BotPrivateSkillPackageClient } from './private-package';
import { FileBotSkillPendingCommitStore } from './pending-commit-store';
import {
  BotSkillSyncService,
  type BotSkillSyncRepairStrategy,
  type BotSkillSyncRequest,
  type BotSkillSyncResult,
} from './sync-service';
import { BotSkillWorkspaceService, type BotSkillWorkspaceOwner } from './workspace';
import { withBotSkillWorkspaceLock } from './workspace-lock';

export interface BotSkillRuntimeOptions {
  runtimeRoot: string;
  auth: CatsCoAuthSnapshot;
  botId?: string;
  skillsRoot?: string;
  cloud?: BotDefinitionCloudClient;
  packages?: BotPrivateSkillPackageClient;
  skillHubBaseUrl?: string;
  transport?: 'http' | 'file';
  fetchImpl?: typeof fetch;
  debounceMs?: number;
  canRunScheduledSync?(): boolean;
  onBackgroundError?(error: unknown): void;
}

export interface BotSkillRuntimeSyncOptions {
  definitionForCreate?: BotDefinition;
  allowLegacyClaim?: boolean;
  allowNewWorkspaceCreate?: boolean;
  initializeDefaultSkill?: boolean;
}

export interface BotSkillRuntimeSyncOutcome {
  result: BotSkillSyncResult;
  definition?: BotDefinition;
}

export class BotSkillRuntime {
  readonly owner: BotSkillWorkspaceOwner;
  readonly workspace: BotSkillWorkspaceService;
  private readonly syncService: BotSkillSyncService;
  private readonly definitions: FileBotDefinitionRepository;
  private readonly runtimeRoot: string;
  private readonly debounceMs: number;
  private timer?: NodeJS.Timeout;
  private running?: Promise<BotSkillRuntimeSyncOutcome>;
  private rerun = false;
  private lastOptions: BotSkillRuntimeSyncOptions = {};
  private readonly onBackgroundError?: (error: unknown) => void;
  private readonly canRunScheduledSync?: () => boolean;

  constructor(options: BotSkillRuntimeOptions) {
    this.runtimeRoot = path.resolve(options.runtimeRoot);
    const botId = String(options.botId || options.auth.botUid || '').trim();
    const apiKey = String(options.auth.apiKey || '').trim();
    if (!botId || !apiKey) throw runtimeError('Bound Bot credentials are incomplete.', 'BOT_SKILL_RUNTIME_AUTH_INCOMPLETE');
    const authority = normalizeAuthority(options.auth.httpBaseUrl);
    this.owner = {
      botId,
      authority,
      ...(String(options.auth.uid || '').trim() ? { ownerUserId: String(options.auth.uid).trim() } : {}),
    };
    const skillsRoot = path.resolve(options.skillsRoot ?? path.join(this.runtimeRoot, 'skills'));
    this.workspace = new BotSkillWorkspaceService({ runtimeRoot: this.runtimeRoot, skillsRoot });
    this.definitions = new FileBotDefinitionRepository({ runtimeRoot: this.runtimeRoot });
    const transport = options.transport ?? 'http';
    const cloud = options.cloud ?? (transport === 'file'
      ? new FileBotDefinitionCloudClient({
        root: path.join(this.runtimeRoot, 'data', 'bot-skill-test-cloud', 'definitions'),
        botId,
      })
      : new HttpBotDefinitionCloudClient({
        botId,
        auth: options.auth,
        fetchImpl: options.fetchImpl,
        allowInsecureHttp: isLocalHttp(options.auth.httpBaseUrl),
      }));
    const packages = options.packages ?? (transport === 'file'
      ? new FileBotPrivateSkillPackageClient({
        root: path.join(this.runtimeRoot, 'data', 'bot-skill-test-cloud', 'packages'),
        botId,
        authority,
      })
      : new HttpBotPrivateSkillPackageClient({
        baseUrl: options.skillHubBaseUrl ?? loadSkillHubConfig().baseUrl,
        botId,
        apiKey,
        fetchImpl: options.fetchImpl,
      }));
    this.syncService = new BotSkillSyncService({
      workspace: this.workspace,
      baseStore: new FileBotSkillSyncBaseStore({ runtimeRoot: this.runtimeRoot, authority }),
      cloud,
      packages,
      definitionCache: this.definitions,
      pendingStore: new FileBotSkillPendingCommitStore({
        runtimeRoot: this.runtimeRoot,
        authority,
        botId,
      }),
    });
    this.debounceMs = Math.max(0, options.debounceMs ?? 1_000);
    this.onBackgroundError = options.onBackgroundError;
    this.canRunScheduledSync = options.canRunScheduledSync;
  }

  async sync(options: BotSkillRuntimeSyncOptions = {}): Promise<BotSkillRuntimeSyncOutcome> {
    this.lastOptions = { ...this.lastOptions, ...options };
    const definitionForCreate = options.definitionForCreate
      ?? this.definitions.readCache(this.owner.botId);
    const request: BotSkillSyncRequest = {
      owner: this.owner,
      ...options,
      ...(definitionForCreate ? { definitionForCreate } : {}),
      ...(options.allowNewWorkspaceCreate && options.initializeDefaultSkill
        ? {
          initializeNewWorkspace: async () => {
            const stateKey = crypto
              .createHash('sha256')
              .update(`${this.owner.authority}\0${this.owner.botId}`)
              .digest('hex');
            const results = await bootstrapDefaultSkillHubSkills({
              skillsRoot: this.workspace.root,
              statePath: path.join(
                this.runtimeRoot,
                'data',
                'bot-skills',
                'default-bootstrap',
                `${stateKey}.json`,
              ),
            });
            const failed = results.find(result => result.state === 'failed');
            if (failed) {
              throw runtimeError(
                `Default Skill initialization failed: ${failed.key}`,
                'BOT_SKILL_DEFAULT_INITIALIZATION_FAILED',
              );
            }
          },
        }
        : {}),
    };
    const result = await this.syncService.sync(request);
    return {
      result,
      definition: this.definitions.readCache(this.owner.botId),
    };
  }

  async repair(strategy: BotSkillSyncRepairStrategy): Promise<BotSkillRuntimeSyncOutcome> {
    const definitionForCreate = this.definitions.readCache(this.owner.botId);
    const result = await this.syncService.repair({
      owner: this.owner,
      ...(definitionForCreate ? { definitionForCreate } : {}),
    }, strategy);
    return {
      result,
      definition: this.definitions.readCache(this.owner.botId),
    };
  }

  schedule(options: BotSkillRuntimeSyncOptions = {}): void {
    this.lastOptions = { ...this.lastOptions, ...options };
    if (this.running) {
      this.rerun = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.canRunScheduledSync && !this.canRunScheduledSync()) {
        this.schedule();
        return;
      }
      void this.runScheduled();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  async mutate<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = await withBotSkillWorkspaceLock(this.workspace.root, async () => operation());
    this.schedule();
    return result;
  }

  async flush(): Promise<BotSkillRuntimeSyncOutcome | undefined> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      return this.runScheduled();
    }
    return this.running;
  }

  private runScheduled(): Promise<BotSkillRuntimeSyncOutcome> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    const run = this.sync(this.lastOptions);
    this.running = run;
    const finish = () => {
      if (this.running === run) this.running = undefined;
      if (this.rerun) {
        this.rerun = false;
        this.schedule();
      }
    };
    void run.then(
      finish,
      error => {
        this.onBackgroundError?.(error);
        finish();
      },
    );
    return run;
  }
}

export function isBotSkillRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env.XIAOBA_BOT_SKILL_SYNC_ENABLED || '').trim());
}

export function resolveBotSkillRuntimeTransport(
  env: NodeJS.ProcessEnv = process.env,
): 'http' | 'file' {
  return String(env.XIAOBA_BOT_SKILL_SYNC_TRANSPORT || '').trim().toLowerCase() === 'file'
    ? 'file'
    : 'http';
}

export function assertBotSkillStartupReady(
  outcome: BotSkillRuntimeSyncOutcome,
  workspace: BotSkillWorkspaceService,
  owner: BotSkillWorkspaceOwner,
): void {
  const localIsValid = workspace.inspect(owner).kind === 'valid';
  if (
    outcome.result.action === 'blocked'
    || (outcome.result.action === 'conflict' && !localIsValid)
  ) {
    throw runtimeError(
      `Bot Skill workspace is not ready: ${outcome.result.reason || outcome.result.action}`,
      'BOT_SKILL_STARTUP_BLOCKED',
    );
  }
  if (outcome.result.action === 'degraded_local' && !localIsValid) {
    throw runtimeError(
      'Bot Skill cloud is unavailable and no valid local workspace exists.',
      'BOT_SKILL_STARTUP_BLOCKED',
    );
  }
}

function normalizeAuthority(value: string): string {
  let url: URL;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw runtimeError('CatsCo authority is invalid.', 'BOT_SKILL_RUNTIME_AUTHORITY_INVALID');
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw runtimeError('CatsCo authority is invalid.', 'BOT_SKILL_RUNTIME_AUTHORITY_INVALID');
  }
  return url.origin.toLowerCase();
}

function isLocalHttp(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function runtimeError(message: string, code: string): Error {
  const error: any = new Error(message);
  error.code = code;
  return error;
}
