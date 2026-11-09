import * as fs from 'fs';
import * as path from 'path';
import { createCatsCoLocalConfigService } from '../catscompany/local-config';
import { withCurrentBotSkillWorkspaceWrite } from '../bot-skills/runtime';
import { BotSkillSyncService } from '../bot-skills/sync-service';
import { BotSkillBaseStore } from '../bot-skills/base-store';
import { BotSkillWorkspaceService } from '../bot-skills/workspace';
import { scanBotSkillWorkspace } from '../bot-skills/local-manifest';
import type { ToolExecutionContext } from '../types/tool';
import type { SkillHubService } from './service';

/** Publication of external packages never installs them or changes Bot refs. */
export async function shareConversationSkill(
  service: Pick<SkillHubService, 'shareLocalSkill'>,
  input: any,
  options: NonNullable<Parameters<SkillHubService['shareLocalSkill']>[1]>,
  context: ToolExecutionContext,
): Promise<any> {
  const scope = context.executionScope;
  if (context.surface !== 'catscompany' || scope?.source !== 'catscompany'
    || !scope.isTrusted || scope.identityTrust !== 'server_canonical') {
    return service.shareLocalSkill(input, options);
  }
  let acceptedResult: any;
  try { return await withCurrentBotSkillWorkspaceWrite(async workspace => {
    const configService = createCatsCoLocalConfigService({ runtimeRoot: workspace.runtimeRoot });
    const auth = configService.getAuthState();
    const validateScope = (): void => {
      const current = configService.getAuthState();
      if (workspace.deviceConnectorMode || !workspace.botId || workspace.activeBotId !== workspace.botId
        || normalizeUid(scope.agentId) !== workspace.botId || normalizeUid(current.botUid) !== workspace.botId
        || new BotSkillWorkspaceService(workspace.runtimeRoot, workspace.skillsRoot).getActiveBotId() !== workspace.botId
        || !current.ownerUid || normalizeUid(scope.actorUserId) !== normalizeUid(current.ownerUid)
        || current.ownerUid !== auth.ownerUid || context.abortSignal?.aborted) {
        throw new Error('The current Bot publication scope changed.');
      }
    };
    // Device/external publications retain their existing behavior.
    if (workspace.deviceConnectorMode || !workspace.botId || workspace.activeBotId !== workspace.botId
      || normalizeUid(scope.agentId) !== workspace.botId || normalizeUid(scope.actorUserId) !== normalizeUid(auth.ownerUid)) {
      return service.shareLocalSkill(input, options);
    }
    if (options.localSkillPath) {
      const root = fs.realpathSync(workspace.skillsRoot);
      const source = fs.realpathSync(options.localSkillPath);
      const relative = path.relative(root, source);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return service.shareLocalSkill(input, options);
    }
    const entries = scanBotSkillWorkspace(workspace.skillsRoot, { onValidationFailure: () => {} });
    const matches = entries.filter(entry => options.localSkillPath
      ? fs.realpathSync(entry.path) === fs.realpathSync(options.localSkillPath)
      : entry.name === input.skillName || entry.installName === input.skillName);
    const selected = matches.length === 1 ? matches[0] : undefined;
    const base = new BotSkillBaseStore(workspace.runtimeRoot).read(workspace.botId);
    if (!selected || !base?.skills.some(entry => entry.localSkillId === selected.localSkillId)) return service.shareLocalSkill(input, options);
    validateScope();
    const result = await service.shareLocalSkill(input, { ...options, writeLocalMetadata: false });
    if (result.requiresConfirmation) return result;
    acceptedResult = result;
    // Publication has already been accepted. A linkage failure must never be
    // reported as a failed upload or cause the model to upload it again.
    try {
      validateScope();
      const reference = { source: 'skillhub' as const, skillId: result.skill?.id,
        version: result.latestVersion, contentHash: result.contentHash };
      await new BotSkillSyncService({ runtimeRoot: workspace.runtimeRoot, botId: workspace.botId,
        auth, skillsRoot: workspace.skillsRoot, workspaceExisted: true,
      }).finalizePublicSkill({ localSkillId: selected.localSkillId, skillName: selected.name, reference }, {
        bindSelectedReference: true, expectedLocalContentHash: selected.contentHash, validateScope,
      });
      return { ...result, publicationStatus: 'published', botReferenceSync: { status: 'updated', botId: workspace.botId } };
    } catch (error: any) {
      return { ...result, botReferenceSync: { status: 'pending', botId: workspace.botId,
        message: String(error?.message || error) } };
    }
  }); } catch (error: any) {
    if (!acceptedResult) throw error;
    return { ...acceptedResult, botReferenceSync: { status: 'pending', message: String(error?.message || error) } };
  }
}

function normalizeUid(value: unknown): string {
  return String(value || '').trim().replace(/^usr(?=\d+$)/i, '');
}
