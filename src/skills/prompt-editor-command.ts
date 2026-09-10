import * as fs from 'fs';
import * as path from 'path';
import { createCatsCoLocalConfigService } from '../catscompany/local-config';
import { pullCloudBotDefinition, patchCloudBotDefinitionPrompt } from '../bot-definition/cloud-client';
import { createBotDefinitionCloudSyncService } from '../bot-definition/cloud-sync';
import { getPromptReconcileCoordinator, hashPrompt } from '../bot-definition/prompt-sync';
import { createBotDefinitionSyncService } from '../bot-definition/service';
import { BotPromptDefinition } from '../bot-definition/types';
import { PathResolver } from '../utils/path-resolver';
import { getPromptEditorFile, writePromptOverride, deletePromptOverride } from '../utils/prompt-editor';
import { normalizePromptText, readRequiredBundledPromptFile } from '../utils/prompt-template';

const MAX_BYTES = 256 * 1024;
const PROMPT_FILE = 'system-prompt.md';

export interface PromptCommandOptions {
  runtimeRoot?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

class PromptCommandError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function fail(code: string, message: string): never { throw new PromptCommandError(code, message); }

export async function runPromptEditorCommand(args: string[], options: PromptCommandOptions = {}): Promise<any> {
  let cloudWritten = false;
  let writeAttempted = false;
  try {
    const [operation, requestFile] = args;
    if (!['show', 'set', 'reset'].includes(operation) || args.length !== (operation === 'show' ? 1 : 2)) {
      fail('INVALID_ARGUMENTS', 'Use show, set <request.json>, or reset <request.json>.');
    }
    const env = options.env ?? process.env;
    const runtimeRoot = path.resolve(options.runtimeRoot ?? PathResolver.getRuntimeDataRoot(env));
    const config = createCatsCoLocalConfigService({ runtimeRoot, env });
    const auth = config.getAuthState();
    // An env-bound headless worker must never fall back to unbound local editing.
    const botId = config.load().currentBot?.uid?.trim() || auth.botUid?.trim() || null;
    const defaultContent = readRequiredBundledPromptFile(PROMPT_FILE, env);
    const definitionService = createBotDefinitionSyncService({ runtimeRoot, env });
    const cloud = createBotDefinitionCloudSyncService({ runtimeRoot, env, definitionService, fetchImpl: options.fetchImpl });
    const coordinator = getPromptReconcileCoordinator({ runtimeRoot, env, definitionService, cloudSyncService: cloud });
    const clientOptions = botId ? { botId, auth, fetchImpl: options.fetchImpl } : undefined;

    const show = async () => {
      let prompt: BotPromptDefinition;
      let revision: number | null = null;
      let localContent: string;
      if (botId) {
        const snapshot = await pullCloudBotDefinition(clientOptions!);
        if (!snapshot?.configured || !snapshot.definition?.prompt) {
          fail('CLOUD_UNAVAILABLE', 'Cannot read an initialized cloud prompt. No local fallback is used.');
        }
        prompt = snapshot.definition.prompt;
        revision = snapshot.revision;
        const file = coordinator.getActivePromptPath();
        localContent = fs.existsSync(file) ? normalizePromptText(fs.readFileSync(file, 'utf8')) : '';
      } else {
        // Local helpers run with the explicitly selected root, never an unrelated cwd.
        if (path.resolve(PathResolver.getRuntimeDataRoot()) !== runtimeRoot) {
          fail('RUNTIME_MISMATCH', 'Local editing requires the helper runtime root to match the active environment.');
        }
        const file = getPromptEditorFile(PROMPT_FILE);
        localContent = file.content;
        const override = path.join(runtimeRoot, 'prompt-overrides', PROMPT_FILE);
        prompt = fs.existsSync(override)
          ? { selected: 'custom', customSystemPrompt: file.content }
          : { selected: 'default' };
      }
      const content = prompt.selected === 'custom' ? prompt.customSystemPrompt! : defaultContent;
      return {
        ok: true, botId, selected: prompt.selected, content, defaultContent,
        customContent: prompt.customSystemPrompt ?? null,
        expectedRevision: revision,
        expectedHash: hashPrompt(JSON.stringify({ botId, prompt, defaultContent, localContent })),
        cloudVerified: Boolean(botId),
        localMatches: localContent === content,
      };
    };

    const before = await show();
    if (operation === 'show') return before;
    if (!requestFile || !path.isAbsolute(requestFile) || fs.statSync(requestFile).size > MAX_BYTES * 6 + 4096) {
      fail('INVALID_REQUEST', 'Use an absolute path to a bounded JSON request file.');
    }
    const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).some(key => !['botId', 'expectedHash', 'expectedRevision', 'content'].includes(key))) {
      fail('INVALID_REQUEST', 'Unexpected request fields. Only the main prompt can be edited.');
    }
    if (request.botId !== before.botId || request.expectedHash !== before.expectedHash
      || request.expectedRevision !== before.expectedRevision) {
      fail('CONFLICT', 'The bot or prompt changed since show. Read again and review before applying.');
    }
    if (operation === 'reset' && request.content !== undefined) fail('INVALID_REQUEST', 'Reset must not include content.');
    const content = typeof request.content === 'string' ? normalizePromptText(request.content) : '';
    if (operation === 'set' && (!content || Buffer.byteLength(content, 'utf8') > MAX_BYTES)) {
      fail('INVALID_CONTENT', 'Custom prompt must be nonempty and at most 256 KiB.');
    }
    const selected = operation === 'set' ? 'custom' : 'default';
    const prompt: BotPromptDefinition = {
      selected,
      ...(operation === 'set' ? { customSystemPrompt: content }
        : before.customContent ? { customSystemPrompt: before.customContent } : {}),
    };
    const assertCurrentBot = () => {
      const current = config.load().currentBot?.uid?.trim() || config.getAuthState().botUid?.trim() || null;
      if (current !== botId) fail('BOT_CHANGED', 'The active bot changed; local application was stopped.');
    };
    assertCurrentBot();
    if (botId) {
      if (!auth.token || !auth.uid || auth.uid !== auth.ownerUid) {
        fail('OWNER_AUTH_REQUIRED', 'A signed-in bot owner is required. No local edit was made.');
      }
      if (cloud.readState(botId).pendingPrompt) {
        fail('PENDING_LOCAL_EDIT', 'An earlier local prompt is pending sync. Resolve it before a new edit.');
      }
      // Cloud-first CAS. In contrast to background reconciliation, a user edit
      // must not silently retry a stale revision and overwrite another edit.
      writeAttempted = true;
      const revision = await patchCloudBotDefinitionPrompt(clientOptions!, prompt, before.expectedRevision!);
      if (revision === undefined) fail('CLOUD_UNAVAILABLE', 'Cloud prompt editing is unavailable. No local edit was made.');
      cloudWritten = true;
      assertCurrentBot();
      const snapshot = await cloud.pull(botId, auth);
      if (!snapshot?.definition || snapshot.revision !== revision
        || snapshot.definition.prompt?.selected !== selected
        || (snapshot.definition.prompt?.customSystemPrompt ?? null) !== (prompt.customSystemPrompt ?? null)) {
        fail('VERIFY_FAILED', 'Cloud changed or could not be verified after saving. Inspect before retrying.');
      }
      assertCurrentBot();
      await coordinator.activateBot(botId, { preferDefinition: true });
    } else if (operation === 'set') {
      writePromptOverride(PROMPT_FILE, content);
    } else {
      deletePromptOverride(PROMPT_FILE);
    }
    assertCurrentBot();
    const after = await show();
    if (after.selected !== selected || !after.localMatches
      || after.content !== (selected === 'custom' ? content : defaultContent)) {
      fail('VERIFY_FAILED', 'Saved state did not match the requested prompt; inspect before retrying.');
    }
    return { ...after, cloudWritten, takesEffect: 'next_user_turn' };
  } catch (error) {
    // Never echo raw upstream responses, credentials, or malformed JSON text.
    const status = (error as { status?: number })?.status;
    const known = error instanceof PromptCommandError;
    return {
      ok: false, cloudWritten,
      ...(writeAttempted && !cloudWritten ? { cloudWriteUnconfirmed: true } : {}),
      code: known ? error.code : status === 409 ? 'CONFLICT' : status === 401 || status === 403 ? 'PERMISSION_DENIED' : 'PROMPT_OPERATION_FAILED',
      message: known ? error.message : 'Prompt operation failed. Inspect state before retrying; no success is confirmed.',
    };
  }
}
