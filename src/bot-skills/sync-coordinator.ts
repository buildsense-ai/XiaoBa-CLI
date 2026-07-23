import * as path from 'node:path';
import { createCatsCoLocalConfigService } from '../catscompany/local-config';
import { Logger } from '../utils/logger';
import { PathResolver } from '../utils/path-resolver';
import { createBotSkillWorkspaceService } from './workspace-service';

export interface BotSkillSyncRequest {
  runtimeRoot: string;
  botId: string;
  workspaceId: string;
}

type SyncRunner = (request: BotSkillSyncRequest) => Promise<void>;

interface QueueEntry {
  request: BotSkillSyncRequest;
  dirty: boolean;
  running?: Promise<void>;
  timer?: NodeJS.Timeout;
}

const queue = new Map<string, QueueEntry>();
let runnerOverride: SyncRunner | undefined;

export function scheduleBotSkillSync(request: BotSkillSyncRequest): void {
  const normalized = normalizeRequest(request);
  const key = requestKey(normalized);
  let entry = queue.get(key);
  if (!entry) {
    entry = { request: normalized, dirty: true };
    queue.set(key, entry);
  } else {
    entry.request = normalized;
    entry.dirty = true;
  }
  if (entry.running || entry.timer) return;
  entry.timer = setTimeout(() => {
    entry!.timer = undefined;
    entry!.running = drain(key, entry!)
      .finally(() => {
        entry!.running = undefined;
        if (entry!.dirty) {
          scheduleBotSkillSync(entry!.request);
        } else {
          queue.delete(key);
        }
      });
  }, 0);
  entry.timer.unref?.();
}

export function scheduleActiveBotSkillSync(
  runtimeRoot = PathResolver.getRuntimeDataRoot(),
): void {
  const root = path.resolve(runtimeRoot);
  try {
    const workspace = createBotSkillWorkspaceService({ runtimeRoot: root });
    const state = workspace.readState();
    const botId = String(
      createCatsCoLocalConfigService({ runtimeRoot: root }).load().currentBot?.uid || '',
    ).trim();
    if (
      !state
      || state.switchJournal
      || !botId
      || state.workspaceOwnerBotId !== botId
    ) return;
    scheduleBotSkillSync({
      runtimeRoot: root,
      botId,
      workspaceId: state.workspaceId,
    });
  } catch (error) {
    Logger.warning(`Bot Skill 后台同步调度失败: ${errorMessage(error)}`);
  }
}

export async function flushBotSkillSyncQueue(runtimeRoot?: string): Promise<void> {
  const selectedRoot = runtimeRoot ? path.resolve(runtimeRoot) : undefined;
  while (true) {
    for (const entry of queue.values()) {
      if (selectedRoot && entry.request.runtimeRoot !== selectedRoot) continue;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
        const key = requestKey(entry.request);
        entry.running = drain(key, entry)
          .finally(() => {
            entry.running = undefined;
            if (!entry.dirty) queue.delete(key);
          });
      }
    }
    const running = [...queue.values()]
      .filter(entry => !selectedRoot || entry.request.runtimeRoot === selectedRoot)
      .map(entry => entry.running)
      .filter((value): value is Promise<void> => Boolean(value));
    if (!running.length) return;
    await Promise.all(running);
  }
}

export function cancelPendingBotSkillSync(runtimeRoot: string): void {
  const selectedRoot = path.resolve(runtimeRoot);
  for (const [key, entry] of queue) {
    if (entry.request.runtimeRoot !== selectedRoot || entry.running) continue;
    if (entry.timer) clearTimeout(entry.timer);
    queue.delete(key);
  }
}

export function setBotSkillSyncRunnerForTests(runner?: SyncRunner): void {
  runnerOverride = runner;
}

export function resetBotSkillSyncCoordinatorForTests(): void {
  for (const entry of queue.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  queue.clear();
  runnerOverride = undefined;
}

async function drain(key: string, entry: QueueEntry): Promise<void> {
  while (entry.dirty) {
    entry.dirty = false;
    const request = entry.request;
    try {
      const runner = runnerOverride ?? defaultRunner;
      await runner(request);
    } catch (error) {
      Logger.warning(
        `Bot ${request.botId} 的 Skill 后台同步暂未完成，将在下次触发时重试: ${errorMessage(error)}`,
      );
    }
    const latest = queue.get(key);
    if (latest !== entry) return;
  }
}

async function defaultRunner(request: BotSkillSyncRequest): Promise<void> {
  const workspace = createBotSkillWorkspaceService({ runtimeRoot: request.runtimeRoot });
  const state = workspace.readState();
  if (
    !state
    || state.switchJournal
    || state.workspaceOwnerBotId !== request.botId
    || state.workspaceId !== request.workspaceId
  ) return;
  const { createBotSkillSyncService } = await import('./sync-service');
  await createBotSkillSyncService({
    runtimeRoot: request.runtimeRoot,
    expectedBotId: request.botId,
    workspaceService: workspace,
  }).syncAfterTurn(request.botId);
}

function normalizeRequest(request: BotSkillSyncRequest): BotSkillSyncRequest {
  const runtimeRoot = path.resolve(request.runtimeRoot);
  const botId = String(request.botId || '').trim();
  const workspaceId = String(request.workspaceId || '').trim();
  if (!botId || !workspaceId) throw new Error('Bot Skill sync request identity is incomplete');
  return { runtimeRoot, botId, workspaceId };
}

function requestKey(request: BotSkillSyncRequest): string {
  return `${request.runtimeRoot}\0${request.botId}\0${request.workspaceId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
