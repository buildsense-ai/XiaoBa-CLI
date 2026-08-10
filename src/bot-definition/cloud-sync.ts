import * as fs from 'fs';
import * as path from 'path';
import type { CatsCoAuthSnapshot } from '../catscompany/local-config';
import { PathResolver } from '../utils/path-resolver';
import {
  acknowledgeCloudBotDefinition,
  patchCloudBotDefinitionModel,
  patchCloudBotDefinitionPrompt,
  pullCloudBotDefinition,
  type CloudBotDefinitionSnapshot,
} from './cloud-client';
import { createBotDefinitionSyncService, type BotDefinitionSyncService } from './service';
import type {
  BotDefinition,
  BotModelDefinition,
  BotPromptDefinition,
  CloudBotDefinition,
} from './types';

const CLOUD_SYNC_STATE_SCHEMA = 'xiaoba.bot-definition-cloud-sync.v1';

export interface BotDefinitionCloudSyncState {
  schema: typeof CLOUD_SYNC_STATE_SCHEMA;
  botId: string;
  revision: number;
  pendingModel: boolean;
  pendingPrompt: boolean;
}

export interface BotDefinitionCloudSyncOptions {
  runtimeRoot?: string;
  env?: NodeJS.ProcessEnv;
  definitionService?: BotDefinitionSyncService;
  fetchImpl?: typeof fetch;
}

export function resolveRunnableCloudDefinition(
  definition: CloudBotDefinition,
  local?: BotDefinition,
): BotDefinition | undefined {
  if (definition.model.kind !== 'local') return definition as BotDefinition;
  return local ? { ...definition, model: local.model } : undefined;
}

/**
 * Keeps the existing local Definition cache as the runtime input while
 * treating CatsCompany as the canonical source. Only revision and retry flags
 * are stored here; model and prompt data remain in the normal cache.
 */
export class BotDefinitionCloudSyncService {
  private readonly runtimeRoot: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly definitionService: BotDefinitionSyncService;
  private readonly fetchImpl?: typeof fetch;
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(options: BotDefinitionCloudSyncOptions = {}) {
    this.runtimeRoot = path.resolve(options.runtimeRoot ?? PathResolver.getRuntimeDataRoot());
    this.env = options.env ?? process.env;
    this.definitionService = options.definitionService ?? createBotDefinitionSyncService({
      runtimeRoot: this.runtimeRoot,
      env: this.env,
    });
    this.fetchImpl = options.fetchImpl;
  }

  pull(botId: string, auth: CatsCoAuthSnapshot): Promise<CloudBotDefinitionSnapshot | undefined> {
    return this.enqueue(botId, async () => {
      const snapshot = await pullCloudBotDefinition({
        botId,
        auth,
        fetchImpl: this.fetchImpl,
      });
      if (!snapshot) return undefined;
      if (snapshot.configured && snapshot.definition) {
        this.acceptCloudDefinition(snapshot.definition);
      }
      this.writeState({
        ...this.readState(botId),
        schema: CLOUD_SYNC_STATE_SCHEMA,
        botId,
        revision: snapshot.revision,
      });
      return snapshot;
    });
  }

  markModelPending(botId: string): void {
    const state = this.readState(botId);
    this.writeState({ ...state, pendingModel: true });
  }

  markPromptPending(botId: string): void {
    const state = this.readState(botId);
    this.writeState({ ...state, pendingPrompt: true });
  }

  pushModel(
    botId: string,
    auth: CatsCoAuthSnapshot,
    model?: BotModelDefinition,
  ): Promise<CloudBotDefinitionSnapshot | undefined> {
    return this.enqueue(botId, async () => {
      const selected = model ?? this.requireLocal(botId).model;
      this.markModelPending(botId);
      return this.pushField(botId, auth, 'model', selected);
    });
  }

  pushPrompt(
    botId: string,
    auth: CatsCoAuthSnapshot,
    prompt?: BotPromptDefinition,
  ): Promise<CloudBotDefinitionSnapshot | undefined> {
    return this.enqueue(botId, async () => {
      const selected = prompt ?? this.requireLocal(botId).prompt;
      if (!selected) throw new Error(`BotDefinition prompt does not exist for bot ${botId}`);
      this.markPromptPending(botId);
      return this.pushField(botId, auth, 'prompt', selected);
    });
  }

  flushPending(
    botId: string,
    auth: CatsCoAuthSnapshot,
  ): Promise<CloudBotDefinitionSnapshot | undefined> {
    return this.enqueue(botId, async () => {
      let snapshot: CloudBotDefinitionSnapshot | undefined;
      const state = this.readState(botId);
      const definition = this.definitionService.read(botId);
      if (!definition) return this.pullUnlocked(botId, auth);
      const pendingPrompt = definition.prompt;
      if (state.pendingModel) {
        snapshot = await this.pushFieldUnlocked(botId, auth, 'model', definition.model);
      }
      if (this.readState(botId).pendingPrompt && pendingPrompt) {
        snapshot = await this.pushFieldUnlocked(botId, auth, 'prompt', pendingPrompt);
      }
      return snapshot ?? this.pullUnlocked(botId, auth);
    });
  }

  reconcileStartup(
    botId: string,
    auth: CatsCoAuthSnapshot,
  ): Promise<CloudBotDefinitionSnapshot | undefined> {
    return this.enqueue(botId, async () => {
      const state = this.readState(botId);
      const pendingDefinition = (
        state.pendingModel || state.pendingPrompt
          ? this.definitionService.read(botId)
          : undefined
      );
      const snapshot = await this.pullUnlocked(botId, auth);
      if (!snapshot || (!state.pendingModel && !state.pendingPrompt)) return snapshot;

      if (snapshot.revision !== state.revision) {
        this.writeState({
          ...this.readState(botId),
          pendingModel: false,
          pendingPrompt: false,
        });
        return snapshot;
      }
      if (!pendingDefinition) return snapshot;

      let applied = snapshot;
      if (state.pendingModel) {
        applied = await this.pushFieldUnlocked(
          botId,
          auth,
          'model',
          pendingDefinition.model,
        ) ?? applied;
      }
      if (state.pendingPrompt && pendingDefinition.prompt) {
        applied = await this.pushFieldUnlocked(
          botId,
          auth,
          'prompt',
          pendingDefinition.prompt,
        ) ?? applied;
      }
      return applied;
    });
  }

  acknowledge(
    botId: string,
    auth: CatsCoAuthSnapshot,
    revision: number,
    applyError = '',
  ): Promise<void> {
    return acknowledgeCloudBotDefinition(
      { botId, auth, fetchImpl: this.fetchImpl },
      revision,
      applyError,
    );
  }

  readState(botId: string): BotDefinitionCloudSyncState {
    const filePath = this.statePath(botId);
    if (fs.existsSync(filePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as BotDefinitionCloudSyncState;
        if (
          parsed.schema === CLOUD_SYNC_STATE_SCHEMA
          && parsed.botId === botId
          && Number.isInteger(parsed.revision)
          && parsed.revision >= 0
        ) {
          return parsed;
        }
      } catch {
        // Recreate malformed local sync metadata without touching Definition data.
      }
    }
    return {
      schema: CLOUD_SYNC_STATE_SCHEMA,
      botId,
      revision: 0,
      pendingModel: false,
      pendingPrompt: false,
    };
  }

  private pushField(
    botId: string,
    auth: CatsCoAuthSnapshot,
    field: 'model' | 'prompt',
    value: BotModelDefinition | BotPromptDefinition,
  ): Promise<CloudBotDefinitionSnapshot | undefined> {
    return this.pushFieldUnlocked(botId, auth, field, value);
  }

  private async pushFieldUnlocked(
    botId: string,
    auth: CatsCoAuthSnapshot,
    field: 'model' | 'prompt',
    value: BotModelDefinition | BotPromptDefinition,
  ): Promise<CloudBotDefinitionSnapshot | undefined> {
    let state = this.readState(botId);
    let revision: number | undefined;
    try {
      revision = await this.patchField(botId, auth, field, value, state.revision);
    } catch (error) {
      if (errorStatus(error) !== 409) throw error;
      const latest = await this.pullUnlocked(botId, auth);
      state = this.readState(botId);
      revision = await this.patchField(botId, auth, field, value, latest?.revision ?? state.revision);
    }
    if (revision === undefined) return undefined;

    state = this.readState(botId);
    this.writeState({
      ...state,
      revision,
      ...(field === 'model' ? { pendingModel: false } : { pendingPrompt: false }),
    });
    const snapshot = await this.pullUnlocked(botId, auth);
    return snapshot ?? {
      configured: true,
      revision,
      definition: this.requireLocal(botId),
    };
  }

  private patchField(
    botId: string,
    auth: CatsCoAuthSnapshot,
    field: 'model' | 'prompt',
    value: BotModelDefinition | BotPromptDefinition,
    revision: number,
  ): Promise<number | undefined> {
    const options = { botId, auth, fetchImpl: this.fetchImpl };
    return field === 'model'
      ? patchCloudBotDefinitionModel(options, value as BotModelDefinition, revision)
      : patchCloudBotDefinitionPrompt(options, value as BotPromptDefinition, revision);
  }

  private async pullUnlocked(
    botId: string,
    auth: CatsCoAuthSnapshot,
  ): Promise<CloudBotDefinitionSnapshot | undefined> {
    const snapshot = await pullCloudBotDefinition({
      botId,
      auth,
      fetchImpl: this.fetchImpl,
    });
    if (!snapshot) return undefined;
    if (snapshot.configured && snapshot.definition) {
      this.acceptCloudDefinition(snapshot.definition);
    }
    this.writeState({
      ...this.readState(botId),
      revision: snapshot.revision,
    });
    return snapshot;
  }

  private acceptCloudDefinition(definition: CloudBotDefinition): void {
    const local = this.definitionService.read(definition.botId);
    const runnable = resolveRunnableCloudDefinition(definition, local);
    if (!runnable) return;
    const { skills: _cloudSkills, ...portableDefinition } = runnable;
    this.definitionService.acceptCanonical({
      ...portableDefinition,
      ...(local?.skills !== undefined ? { skills: local.skills } : {}),
    });
  }

  private requireLocal(botId: string): BotDefinition {
    const definition = this.definitionService.read(botId);
    if (!definition) throw new Error(`BotDefinition does not exist for bot ${botId}`);
    return definition;
  }

  private statePath(botId: string): string {
    return path.join(this.runtimeRoot, 'data', 'bot-definition-sync', 'bots', `${botId}.json`);
  }

  private writeState(state: BotDefinitionCloudSyncState): void {
    const filePath = this.statePath(state.botId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    fs.renameSync(temporary, filePath);
  }

  private enqueue<T>(botId: string, operation: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(botId) ?? Promise.resolve();
    const next = tail.then(operation, operation);
    this.tails.set(botId, next.then(() => undefined, () => undefined));
    return next;
  }
}

export function createBotDefinitionCloudSyncService(
  options: BotDefinitionCloudSyncOptions = {},
): BotDefinitionCloudSyncService {
  return new BotDefinitionCloudSyncService(options);
}

function errorStatus(error: unknown): number | undefined {
  return (error as { status?: number } | undefined)?.status;
}
