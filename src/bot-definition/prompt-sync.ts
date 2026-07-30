import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { createCatsCoLocalConfigService } from '../catscompany/local-config';
import { Logger } from '../utils/logger';
import { PathResolver } from '../utils/path-resolver';
import {
  normalizePromptText,
  readRequiredBundledPromptFile,
  SYSTEM_PROMPT_RELATIVE_PATH,
} from '../utils/prompt-template';
import { createBotDefinitionSyncService, type BotDefinitionSyncService } from './service';
import {
  createBotDefinitionCloudSyncService,
  type BotDefinitionCloudSyncService,
} from './cloud-sync';
import type { BotDefinition, BotPromptDefinition } from './types';

const PROMPT_SYNC_STATE_SCHEMA = 'xiaoba.active-prompt-sync.v1';
const RECENT_WRITE_GRACE_MS = 100;

export interface ActivePromptSyncState {
  schema: typeof PROMPT_SYNC_STATE_SCHEMA;
  activeBotId: string;
  lastSyncedHash: string;
  materializedSelection: 'default' | 'custom';
}

export interface PromptSelectionState {
  botId: string;
  definitionReady: boolean;
  selected: 'default' | 'custom';
  customSystemPrompt?: string;
  effectiveSystemPrompt: string;
  bundledDefaultSystemPrompt: string;
}

export interface ActivePromptSnapshot {
  fileExisted: boolean;
  content?: string;
  state?: ActivePromptSyncState;
}

export interface PromptReconcileCoordinatorOptions {
  runtimeRoot?: string;
  env?: NodeJS.ProcessEnv;
  definitionService?: BotDefinitionSyncService;
  cloudSyncService?: BotDefinitionCloudSyncService;
}

export class PromptReconcileCoordinator {
  private readonly runtimeRoot: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly definitionService: BotDefinitionSyncService;
  private readonly cloudSyncService: BotDefinitionCloudSyncService;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly cloudRetries = new Set<string>();

  constructor(options: PromptReconcileCoordinatorOptions = {}) {
    this.runtimeRoot = path.resolve(options.runtimeRoot ?? PathResolver.getRuntimeDataRoot());
    this.env = options.env ?? process.env;
    this.definitionService = options.definitionService ?? createBotDefinitionSyncService({
      runtimeRoot: this.runtimeRoot,
      env: this.env,
    });
    this.cloudSyncService = options.cloudSyncService ?? createBotDefinitionCloudSyncService({
      runtimeRoot: this.runtimeRoot,
      env: this.env,
      definitionService: this.definitionService,
    });
  }

  getActivePromptPath(): string {
    return path.join(this.runtimeRoot, 'prompt-overrides', SYSTEM_PROMPT_RELATIVE_PATH);
  }

  getStatePath(): string {
    return path.join(this.runtimeRoot, 'data', 'bot-prompt-sync', 'active.json');
  }

  getCurrentBotId(): string | undefined {
    const localConfig = createCatsCoLocalConfigService({
      runtimeRoot: this.runtimeRoot,
      env: this.env,
    }).load();
    const botId = String(localConfig.currentBot?.uid || '').trim();
    return botId || undefined;
  }

  getSelection(botId: string): PromptSelectionState {
    const bundledDefaultSystemPrompt = this.readBundledDefault();
    const definition = this.definitionService.read(botId);
    if (!definition) {
      const state = this.readState();
      const active = this.readActivePrompt({ force: true });
      const activeBelongsToBot = Boolean(
        active
        && (
          !state
          || (
            state.activeBotId === botId
            && (
              state.materializedSelection === 'custom'
              || active.hash !== state.lastSyncedHash
            )
          )
        ),
      );
      return {
        botId,
        definitionReady: false,
        selected: activeBelongsToBot ? 'custom' : 'default',
        ...(activeBelongsToBot ? { customSystemPrompt: active!.text } : {}),
        effectiveSystemPrompt: activeBelongsToBot ? active!.text : bundledDefaultSystemPrompt,
        bundledDefaultSystemPrompt,
      };
    }
    const prompt = definition.prompt ?? { selected: 'default' as const };
    const effectiveSystemPrompt = prompt.selected === 'custom'
      ? prompt.customSystemPrompt || bundledDefaultSystemPrompt
      : bundledDefaultSystemPrompt;
    return {
      botId,
      definitionReady: true,
      selected: prompt.selected,
      ...(prompt.customSystemPrompt ? { customSystemPrompt: prompt.customSystemPrompt } : {}),
      effectiveSystemPrompt,
      bundledDefaultSystemPrompt,
    };
  }

  activateBot(
    botId: string,
    options: { preferDefinition?: boolean } = {},
  ): Promise<PromptSelectionState> {
    return this.enqueue(() => this.activateBotNow(botId, options));
  }

  reconcileCurrent(options: { force?: boolean } = {}): Promise<boolean> {
    return this.enqueue(async () => {
      const botId = this.getCurrentBotId();
      if (!botId) return false;
      this.schedulePendingCloudRetry(botId);
      return this.reconcileBotNow(botId, options);
    });
  }

  prepareCurrentBotForSwitch(): Promise<PromptSelectionState | undefined> {
    return this.enqueue(async () => {
      const botId = this.getCurrentBotId();
      if (!botId) return undefined;
      if (!this.definitionService.read(botId)) {
        this.definitionService.pullOrBootstrap(botId);
      }
      if (!this.definitionService.read(botId)) {
        const active = await this.readStableActivePrompt();
        if (active) {
          this.writeState({
            schema: PROMPT_SYNC_STATE_SCHEMA,
            activeBotId: botId,
            lastSyncedHash: active.hash,
            materializedSelection: 'custom',
          });
        }
        return undefined;
      }
      await this.reconcileBotNow(botId, { force: true });
      return this.activateBotNow(botId);
    });
  }

  scheduleCurrent(): void {
    void this.reconcileCurrent().catch(error => {
      Logger.warning(`Prompt sync retry deferred: ${errorMessage(error)}`);
    });
  }

  select(
    botId: string,
    selected: 'default' | 'custom',
    customSystemPrompt?: string,
  ): Promise<PromptSelectionState> {
    return this.enqueue(async () => {
      const definition = this.requireDefinition(botId);
      const bundledDefault = this.readBundledDefault();
      const previousCustom = definition.prompt?.customSystemPrompt;
      const normalizedCustom = customSystemPrompt === undefined
        ? previousCustom
        : normalizePromptText(customSystemPrompt);
      if (customSystemPrompt !== undefined && !normalizedCustom) {
        throw new Error('Custom system prompt cannot be empty');
      }
      const prompt: BotPromptDefinition = {
        selected,
        ...(normalizedCustom || previousCustom
          ? { customSystemPrompt: normalizedCustom || previousCustom }
          : selected === 'custom'
            ? { customSystemPrompt: bundledDefault }
            : {}),
      };
      const effective = selected === 'custom'
        ? prompt.customSystemPrompt || bundledDefault
        : bundledDefault;
      const snapshot = this.captureActiveSnapshot();
      try {
        this.writeActivePrompt(effective);
        this.writeState({
          schema: PROMPT_SYNC_STATE_SCHEMA,
          activeBotId: botId,
          lastSyncedHash: hashPrompt(effective),
          materializedSelection: selected,
        });
        this.definitionService.updatePrompt(botId, prompt);
      } catch (error) {
        this.restoreActiveSnapshot(snapshot);
        throw error;
      }
      try {
        const auth = createCatsCoLocalConfigService({
          runtimeRoot: this.runtimeRoot,
          env: this.env,
        }).getAuthState();
        await this.cloudSyncService.pushPrompt(botId, auth, prompt);
      } catch (error) {
        Logger.warning(`Prompt cloud sync deferred: ${errorMessage(error)}`);
        this.schedulePendingCloudRetry(botId);
      }
      return this.getSelection(botId);
    });
  }

  captureActiveSnapshot(): ActivePromptSnapshot {
    const filePath = this.getActivePromptPath();
    const state = this.readState();
    return {
      fileExisted: fs.existsSync(filePath),
      ...(fs.existsSync(filePath) ? { content: fs.readFileSync(filePath, 'utf-8') } : {}),
      ...(state ? { state } : {}),
    };
  }

  restoreActiveSnapshot(snapshot: ActivePromptSnapshot): void {
    const filePath = this.getActivePromptPath();
    if (snapshot.fileExisted) {
      this.writeFileAtomic(filePath, snapshot.content || '');
    } else {
      fs.rmSync(filePath, { force: true });
    }
    if (snapshot.state) {
      this.writeState(snapshot.state);
    } else {
      fs.rmSync(this.getStatePath(), { force: true });
    }
  }

  private async activateBotNow(
    botId: string,
    options: { preferDefinition?: boolean } = {},
  ): Promise<PromptSelectionState> {
    let definition = this.requireDefinition(botId);
    const state = this.readState();
    const active = await this.readStableActivePrompt();
    const bundledDefault = this.readBundledDefault();
    let migratedLegacyDefault = false;

    if (!definition.prompt) {
      const canMigrateActive = Boolean(active && (!state || state.activeBotId === botId));
      const activeIsTrackedCustom = Boolean(
        active
        && state?.activeBotId === botId
        && (
          state.materializedSelection === 'custom'
          || active.hash !== state.lastSyncedHash
        ),
      );
      const prompt: BotPromptDefinition = canMigrateActive
        ? activeIsTrackedCustom
          ? { selected: 'custom', customSystemPrompt: active!.text }
          : { selected: 'default', customSystemPrompt: active!.text }
        : { selected: 'default' };
      definition = this.definitionService.updatePrompt(botId, prompt).definition;
      migratedLegacyDefault = canMigrateActive && !activeIsTrackedCustom;
    } else if (
      active
      && !state
      && definition.prompt.selected === 'default'
    ) {
      definition = this.definitionService.updatePrompt(botId, {
        ...definition.prompt,
        customSystemPrompt: definition.prompt.customSystemPrompt || active.text,
      }).definition;
      migratedLegacyDefault = true;
    }

    if (migratedLegacyDefault) {
      this.writeActivePrompt(bundledDefault);
      this.writeState({
        schema: PROMPT_SYNC_STATE_SCHEMA,
        activeBotId: botId,
        lastSyncedHash: hashPrompt(bundledDefault),
        materializedSelection: 'default',
      });
      return this.toSelection(definition, bundledDefault, bundledDefault);
    }

    const prompt = definition.prompt!;
    const expected = prompt.selected === 'custom'
      ? prompt.customSystemPrompt || bundledDefault
      : bundledDefault;
    const activeHasUnsyncedChange = Boolean(
      !options.preferDefinition
      &&
      active
      && (
        (state?.activeBotId === botId && active.hash !== state.lastSyncedHash)
        || (!state && active.hash !== hashPrompt(expected))
      ),
    );
    if (active && activeHasUnsyncedChange) {
      const migrated = this.definitionService.updatePrompt(botId, {
        selected: 'custom',
        customSystemPrompt: active.text,
      }).definition;
      this.writeState({
        schema: PROMPT_SYNC_STATE_SCHEMA,
        activeBotId: botId,
        lastSyncedHash: active.hash,
        materializedSelection: 'custom',
      });
      return this.toSelection(migrated, bundledDefault, active.text);
    }

    const effective = prompt.selected === 'custom'
      ? prompt.customSystemPrompt || bundledDefault
      : bundledDefault;
    if (prompt.selected === 'custom' && !prompt.customSystemPrompt) {
      definition = this.definitionService.updatePrompt(botId, {
        selected: 'custom',
        customSystemPrompt: effective,
      }).definition;
    }
    this.writeActivePrompt(effective);
    this.writeState({
      schema: PROMPT_SYNC_STATE_SCHEMA,
      activeBotId: botId,
      lastSyncedHash: hashPrompt(effective),
      materializedSelection: prompt.selected,
    });
    return this.toSelection(definition, bundledDefault, effective);
  }

  private async reconcileBotNow(botId: string, options: { force?: boolean }): Promise<boolean> {
    const state = this.readState();
    if (!state || state.activeBotId !== botId) return false;
    const active = this.readActivePrompt(options);
    if (!active || active.hash === state.lastSyncedHash) return false;

    this.requireDefinition(botId);
    const prompt: BotPromptDefinition = {
      selected: 'custom',
      customSystemPrompt: active.text,
    };
    this.definitionService.updatePrompt(botId, prompt);
    const auth = createCatsCoLocalConfigService({
      runtimeRoot: this.runtimeRoot,
      env: this.env,
    }).getAuthState();
    await this.cloudSyncService.pushPrompt(botId, auth, prompt);
    this.writeState({
      schema: PROMPT_SYNC_STATE_SCHEMA,
      activeBotId: botId,
      lastSyncedHash: active.hash,
      materializedSelection: 'custom',
    });
    return true;
  }

  private readActivePrompt(options: { force?: boolean }): { text: string; hash: string } | undefined {
    const filePath = this.getActivePromptPath();
    if (!fs.existsSync(filePath)) return undefined;
    const stat = fs.statSync(filePath);
    if (!options.force && Date.now() - stat.mtimeMs < RECENT_WRITE_GRACE_MS) return undefined;
    const text = normalizePromptText(fs.readFileSync(filePath, 'utf-8'));
    if (!text) return undefined;
    return { text, hash: hashPrompt(text) };
  }

  private async readStableActivePrompt(): Promise<{ text: string; hash: string } | undefined> {
    const filePath = this.getActivePromptPath();
    if (!fs.existsSync(filePath)) return undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const first = this.readActivePrompt({ force: true });
      await new Promise(resolve => setTimeout(resolve, RECENT_WRITE_GRACE_MS));
      const second = this.readActivePrompt({ force: true });
      if (!first && !second) return undefined;
      if (first && second && first.hash === second.hash) return second;
    }
    throw new Error('System prompt is still being written; retry after the current edit finishes');
  }

  private readBundledDefault(): string {
    return readRequiredBundledPromptFile(SYSTEM_PROMPT_RELATIVE_PATH, this.env);
  }

  private requireDefinition(botId: string): BotDefinition {
    const definition = this.definitionService.read(botId);
    if (!definition) throw new Error(`BotDefinition does not exist for bot ${botId}`);
    return definition;
  }

  private toSelection(
    definition: BotDefinition,
    bundledDefaultSystemPrompt: string,
    effectiveSystemPrompt: string,
  ): PromptSelectionState {
    const prompt = definition.prompt ?? { selected: 'default' as const };
    return {
      botId: definition.botId,
      definitionReady: true,
      selected: prompt.selected,
      ...(prompt.customSystemPrompt ? { customSystemPrompt: prompt.customSystemPrompt } : {}),
      effectiveSystemPrompt,
      bundledDefaultSystemPrompt,
    };
  }

  private writeActivePrompt(text: string): void {
    const normalized = normalizePromptText(text);
    if (!normalized) throw new Error('System prompt cannot be empty');
    this.writeFileAtomic(this.getActivePromptPath(), `${normalized}\n`);
  }

  private readState(): ActivePromptSyncState | undefined {
    const statePath = this.getStatePath();
    if (!fs.existsSync(statePath)) return undefined;
    try {
      const value = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as ActivePromptSyncState;
      if (
        value.schema !== PROMPT_SYNC_STATE_SCHEMA
        || !String(value.activeBotId || '').trim()
        || !/^[a-f0-9]{64}$/.test(String(value.lastSyncedHash || ''))
        || (value.materializedSelection !== 'default' && value.materializedSelection !== 'custom')
      ) {
        return undefined;
      }
      return value;
    } catch {
      return undefined;
    }
  }

  private writeState(state: ActivePromptSyncState): void {
    this.writeFileAtomic(this.getStatePath(), `${JSON.stringify(state, null, 2)}\n`);
  }

  private writeFileAtomic(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, content, 'utf-8');
    fs.renameSync(temporary, filePath);
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const next = this.tail.then(operation, operation);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  private schedulePendingCloudRetry(botId: string): void {
    if (
      this.cloudRetries.has(botId)
      || !this.cloudSyncService.readState(botId).pendingPrompt
    ) {
      return;
    }
    this.cloudRetries.add(botId);
    const auth = createCatsCoLocalConfigService({
      runtimeRoot: this.runtimeRoot,
      env: this.env,
    }).getAuthState();
    void this.cloudSyncService.flushPending(botId, auth)
      .catch(error => {
        Logger.warning(`Prompt cloud sync retry deferred: ${errorMessage(error)}`);
      })
      .finally(() => {
        this.cloudRetries.delete(botId);
      });
  }
}

const coordinators = new Map<string, PromptReconcileCoordinator>();

export function getPromptReconcileCoordinator(
  options: PromptReconcileCoordinatorOptions = {},
): PromptReconcileCoordinator {
  const runtimeRoot = path.resolve(options.runtimeRoot ?? PathResolver.getRuntimeDataRoot());
  const existing = coordinators.get(runtimeRoot);
  if (existing && !options.definitionService && !options.cloudSyncService && !options.env) return existing;
  const coordinator = new PromptReconcileCoordinator({ ...options, runtimeRoot });
  if (!options.definitionService && !options.cloudSyncService && !options.env) {
    coordinators.set(runtimeRoot, coordinator);
  }
  return coordinator;
}

export function reconcileCurrentBotPromptBeforeTurn(): Promise<boolean> {
  return getPromptReconcileCoordinator().reconcileCurrent();
}

export function scheduleCurrentBotPromptReconcile(): void {
  getPromptReconcileCoordinator().scheduleCurrent();
}

export function hashPrompt(text: string): string {
  return createHash('sha256').update(normalizePromptText(text), 'utf-8').digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
