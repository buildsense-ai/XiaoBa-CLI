import { createCatsCoLocalConfigService } from '../catscompany/local-config';
import {
  BotSkillRuntime,
  isBotSkillRuntimeEnabled,
  resolveBotSkillRuntimeTransport,
} from '../bot-skills/runtime';
import { PathResolver } from '../utils/path-resolver';
import { Logger } from '../utils/logger';

export async function mutateCurrentBotSkills<T>(
  operation: () => Promise<T> | T,
): Promise<T> {
  const runtime = currentBotSkillRuntime();
  if (!runtime) return operation();
  return runtime.mutate(async () => {
    const current = currentBotSkillRuntime();
    if (
      !current
      || current.owner.botId !== runtime.owner.botId
      || current.owner.authority !== runtime.owner.authority
      || runtime.workspace.inspect(runtime.owner).kind !== 'valid'
    ) {
      const error: any = new Error('The active Bot changed while its Skill workspace was waiting for mutation.');
      error.code = 'BOT_SKILL_ACTIVE_OWNER_CHANGED';
      error.status = 409;
      throw error;
    }
    return operation();
  });
}

export function scheduleCurrentBotSkillSync(): void {
  currentBotSkillRuntime()?.schedule({ allowLegacyClaim: true });
}

function currentBotSkillRuntime(): BotSkillRuntime | undefined {
  if (!isBotSkillRuntimeEnabled()) return undefined;
  const runtimeRoot = PathResolver.getRuntimeDataRoot();
  const auth = createCatsCoLocalConfigService({ runtimeRoot }).getAuthState();
  if (!auth.botUid || !auth.apiKey) return undefined;
  try {
    return new BotSkillRuntime({
      runtimeRoot,
      auth,
      transport: resolveBotSkillRuntimeTransport(),
      onBackgroundError: error => {
        const code = String((error as any)?.code || 'BOT_SKILL_BACKGROUND_SYNC_FAILED');
        Logger.warning(`Bot Skill background sync failed: ${code}`);
      },
    });
  } catch (error) {
    const code = String((error as any)?.code || 'BOT_SKILL_RUNTIME_UNAVAILABLE');
    Logger.warning(`Bot Skill runtime is unavailable: ${code}`);
    return undefined;
  }
}
