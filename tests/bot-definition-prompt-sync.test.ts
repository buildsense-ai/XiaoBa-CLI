import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import { PromptReconcileCoordinator } from '../src/bot-definition/prompt-sync';
import { FileBotDefinitionRepository } from '../src/bot-definition/repository';
import { createBotDefinitionSyncService } from '../src/bot-definition/service';
import { BOT_DEFINITION_SCHEMA, type BotDefinition } from '../src/bot-definition/types';
import { getPromptOverridesDir, readRequiredBundledPromptFile } from '../src/utils/prompt-template';

class FailingCanonicalRepository extends FileBotDefinitionRepository {
  failCanonicalWrite = false;

  override writeCanonical(definition: BotDefinition): void {
    if (this.failCanonicalWrite) throw new Error('simulated canonical write failure');
    super.writeCanonical(definition);
  }
}

describe('BotDefinition system prompt sync', () => {
  let runtimeRoot: string;
  let simulatedCloudRoot: string;
  let appRoot: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-prompt-sync-runtime-'));
    simulatedCloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-prompt-sync-cloud-'));
    appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-prompt-sync-app-'));
    fs.mkdirSync(path.join(appRoot, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(appRoot, 'prompts', 'system-prompt.md'), 'bundled v1\n', 'utf-8');
    env = {
      XIAOBA_APP_ROOT: appRoot,
      XIAOBA_USER_DATA_DIR: runtimeRoot,
      XIAOBA_BOT_DEFINITION_SIMULATED_CLOUD_DIR: simulatedCloudRoot,
    } as NodeJS.ProcessEnv;
  });

  afterEach(() => {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.rmSync(simulatedCloudRoot, { recursive: true, force: true });
    fs.rmSync(appRoot, { recursive: true, force: true });
  });

  function createCoordinator(
    botId = 'bot-a',
    repository = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot }),
    initializeDefinition = true,
  ): {
    coordinator: PromptReconcileCoordinator;
    repository: FileBotDefinitionRepository;
  } {
    createCatsCoLocalConfigService({ runtimeRoot, env }).save({
      version: 1,
      currentBot: {
        uid: botId,
        apiKey: 'bot-api-key',
        boundByUserUid: 'owner-a',
        bindingSource: 'test',
      },
    });
    if (initializeDefinition) {
      repository.writeCanonical({
        schema: BOT_DEFINITION_SCHEMA,
        botId,
        model: { kind: 'catalog', modelId: 'minimax-m3' },
      });
      repository.writeCache(repository.readCanonical(botId)!);
    }
    const definitionService = createBotDefinitionSyncService({
      runtimeRoot,
      simulatedCloudRoot,
      env,
      repository,
    });
    return {
      coordinator: new PromptReconcileCoordinator({ runtimeRoot, env, definitionService }),
      repository,
    };
  }

  test('bundled reader ignores prompt and override directories', () => {
    const fakePrompts = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-prompt-fake-'));
    const fakeOverrides = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-prompt-override-'));
    try {
      fs.writeFileSync(path.join(fakePrompts, 'system-prompt.md'), 'wrong base\n', 'utf-8');
      fs.writeFileSync(path.join(fakeOverrides, 'system-prompt.md'), 'wrong override\n', 'utf-8');
      assert.equal(readRequiredBundledPromptFile('system-prompt.md', {
        ...env,
        XIAOBA_PROMPTS_DIR: fakePrompts,
        XIAOBA_PROMPT_OVERRIDES_DIR: fakeOverrides,
      }), 'bundled v1');
    } finally {
      fs.rmSync(fakePrompts, { recursive: true, force: true });
      fs.rmSync(fakeOverrides, { recursive: true, force: true });
    }
  });

  test('returns a default read view when the bound bot Definition is not initialized yet', () => {
    const { coordinator, repository } = createCoordinator(
      'legacy-bound-bot',
      new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot }),
      false,
    );

    const selection = coordinator.getSelection('legacy-bound-bot');

    assert.equal(selection.definitionReady, false);
    assert.equal(selection.selected, 'default');
    assert.equal(selection.effectiveSystemPrompt, 'bundled v1');
    assert.equal(selection.customSystemPrompt, undefined);
    assert.equal(repository.readCache('legacy-bound-bot'), undefined);
    assert.equal(repository.readCanonical('legacy-bound-bot'), undefined);
  });

  test('preserves a legacy system override as a custom read view before Definition bootstrap', () => {
    const { coordinator, repository } = createCoordinator(
      'legacy-custom-bot',
      new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot }),
      false,
    );
    fs.mkdirSync(path.dirname(coordinator.getActivePromptPath()), { recursive: true });
    fs.writeFileSync(coordinator.getActivePromptPath(), 'Legacy custom prompt\n', 'utf-8');

    const selection = coordinator.getSelection('legacy-custom-bot');

    assert.equal(selection.definitionReady, false);
    assert.equal(selection.selected, 'custom');
    assert.equal(selection.customSystemPrompt, 'Legacy custom prompt');
    assert.equal(selection.effectiveSystemPrompt, 'Legacy custom prompt');
    assert.equal(repository.readCache('legacy-custom-bot'), undefined);
    assert.equal(repository.readCanonical('legacy-custom-bot'), undefined);
  });

  test('bound bots always use the runtime-root prompt override directory', () => {
    assert.equal(getPromptOverridesDir({
      ...env,
      CATSCO_BOT_UID: 'bot-a',
      XIAOBA_RUNTIME_ROOT: runtimeRoot,
      XIAOBA_PROMPT_OVERRIDES_DIR: path.join(runtimeRoot, 'wrong-overrides'),
    }), path.join(runtimeRoot, 'prompt-overrides'));
  });

  test('initializes default and follows a newer bundled prompt', async () => {
    const { coordinator, repository } = createCoordinator();
    await coordinator.activateBot('bot-a');

    assert.equal(coordinator.getSelection('bot-a').definitionReady, true);
    assert.equal(repository.readCanonical('bot-a')?.prompt?.selected, 'default');
    assert.equal(fs.readFileSync(coordinator.getActivePromptPath(), 'utf-8'), 'bundled v1\n');

    fs.writeFileSync(path.join(appRoot, 'prompts', 'system-prompt.md'), 'bundled v2\n', 'utf-8');
    await coordinator.activateBot('bot-a');

    assert.equal(fs.readFileSync(coordinator.getActivePromptPath(), 'utf-8'), 'bundled v2\n');
    assert.equal(repository.readCanonical('bot-a')?.prompt?.selected, 'default');
  });

  test('captures a locally edited default as custom instead of overwriting it', async () => {
    const { coordinator, repository } = createCoordinator();
    await coordinator.activateBot('bot-a');
    fs.writeFileSync(coordinator.getActivePromptPath(), 'agent edited prompt\n', 'utf-8');

    await coordinator.activateBot('bot-a');

    assert.deepStrictEqual(repository.readCanonical('bot-a')?.prompt, {
      selected: 'custom',
      customSystemPrompt: 'agent edited prompt',
    });
    assert.equal(fs.readFileSync(coordinator.getActivePromptPath(), 'utf-8'), 'agent edited prompt\n');
  });

  test('keeps custom text across upgrades and restores it after using default', async () => {
    const { coordinator, repository } = createCoordinator();
    await coordinator.activateBot('bot-a');
    await coordinator.select('bot-a', 'custom', '# My prompt\n\n- item\tvalue');
    fs.writeFileSync(path.join(appRoot, 'prompts', 'system-prompt.md'), 'bundled v2\n', 'utf-8');

    await coordinator.activateBot('bot-a');
    assert.equal(fs.readFileSync(coordinator.getActivePromptPath(), 'utf-8'), '# My prompt\n\n- item\tvalue\n');

    await coordinator.select('bot-a', 'default');
    assert.equal(fs.readFileSync(coordinator.getActivePromptPath(), 'utf-8'), 'bundled v2\n');
    assert.equal(
      repository.readCanonical('bot-a')?.prompt?.customSystemPrompt,
      '# My prompt\n\n- item\tvalue',
    );

    await coordinator.select('bot-a', 'custom');
    assert.equal(fs.readFileSync(coordinator.getActivePromptPath(), 'utf-8'), '# My prompt\n\n- item\tvalue\n');
  });

  test('keeps an unsynced custom file edit across restart activation', async () => {
    const { coordinator, repository } = createCoordinator();
    await coordinator.activateBot('bot-a');
    await coordinator.select('bot-a', 'custom', 'saved custom prompt');
    fs.writeFileSync(coordinator.getActivePromptPath(), 'last local edit\n', 'utf-8');

    await coordinator.activateBot('bot-a');

    assert.deepStrictEqual(repository.readCanonical('bot-a')?.prompt, {
      selected: 'custom',
      customSystemPrompt: 'last local edit',
    });
    assert.equal(fs.readFileSync(coordinator.getActivePromptPath(), 'utf-8'), 'last local edit\n');
  });

  test('model and prompt field updates preserve each other', async () => {
    const { coordinator, repository } = createCoordinator();
    await coordinator.activateBot('bot-a');
    await coordinator.select('bot-a', 'custom', 'portable prompt');
    const service = createBotDefinitionSyncService({
      runtimeRoot,
      simulatedCloudRoot,
      env,
      repository,
    });

    service.updateModel('bot-a', { kind: 'catalog', modelId: 'deepseek-v4-flash' });
    assert.equal(repository.readCanonical('bot-a')?.prompt?.customSystemPrompt, 'portable prompt');

    service.updatePrompt('bot-a', { selected: 'default', customSystemPrompt: 'portable prompt' });
    assert.deepStrictEqual(repository.readCanonical('bot-a')?.model, {
      kind: 'catalog',
      modelId: 'deepseek-v4-flash',
    });
  });

  test('separate process services merge model and prompt fields from the latest Definition', async () => {
    const { coordinator, repository } = createCoordinator();
    await coordinator.activateBot('bot-a');
    const dashboardService = createBotDefinitionSyncService({
      runtimeRoot,
      simulatedCloudRoot,
      env,
      repository: new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot }),
    });
    const connectorService = createBotDefinitionSyncService({
      runtimeRoot,
      simulatedCloudRoot,
      env,
      repository: new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot }),
    });

    dashboardService.updateModel('bot-a', { kind: 'catalog', modelId: 'deepseek-v4-flash' });
    connectorService.updatePrompt('bot-a', {
      selected: 'custom',
      customSystemPrompt: 'cross-process prompt',
    });

    assert.deepStrictEqual(repository.readCanonical('bot-a'), {
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-a',
      model: { kind: 'catalog', modelId: 'deepseek-v4-flash' },
      prompt: {
        selected: 'custom',
        customSystemPrompt: 'cross-process prompt',
      },
    });
  });

  test('does not replace Definition with an empty active file', async () => {
    const { coordinator, repository } = createCoordinator();
    await coordinator.activateBot('bot-a');
    fs.writeFileSync(coordinator.getActivePromptPath(), '  \n\n', 'utf-8');

    assert.equal(await coordinator.reconcileCurrent({ force: true }), false);
    assert.deepStrictEqual(repository.readCanonical('bot-a')?.prompt, { selected: 'default' });
  });

  test('does not advance the sync baseline when canonical persistence fails', async () => {
    const repository = new FailingCanonicalRepository({ runtimeRoot, simulatedCloudRoot });
    const { coordinator } = createCoordinator('bot-a', repository);
    await coordinator.activateBot('bot-a');
    const stateBefore = fs.readFileSync(coordinator.getStatePath(), 'utf-8');
    fs.writeFileSync(coordinator.getActivePromptPath(), 'retry this prompt\n', 'utf-8');
    repository.failCanonicalWrite = true;

    await assert.rejects(
      () => coordinator.reconcileCurrent({ force: true }),
      /simulated canonical write failure/,
    );
    assert.equal(fs.readFileSync(coordinator.getStatePath(), 'utf-8'), stateBefore);
    assert.deepStrictEqual(repository.readCanonical('bot-a')?.prompt, { selected: 'default' });

    repository.failCanonicalWrite = false;
    assert.equal(await coordinator.reconcileCurrent({ force: true }), true);
    assert.deepStrictEqual(repository.readCanonical('bot-a')?.prompt, {
      selected: 'custom',
      customSystemPrompt: 'retry this prompt',
    });
  });

  test('restores the active prompt when an explicit selection cannot persist', async () => {
    const repository = new FailingCanonicalRepository({ runtimeRoot, simulatedCloudRoot });
    const { coordinator } = createCoordinator('bot-a', repository);
    await coordinator.activateBot('bot-a');
    const promptBefore = fs.readFileSync(coordinator.getActivePromptPath(), 'utf-8');
    const stateBefore = fs.readFileSync(coordinator.getStatePath(), 'utf-8');
    repository.failCanonicalWrite = true;

    await assert.rejects(
      () => coordinator.select('bot-a', 'custom', 'should roll back'),
      /simulated canonical write failure/,
    );
    assert.equal(fs.readFileSync(coordinator.getActivePromptPath(), 'utf-8'), promptBefore);
    assert.equal(fs.readFileSync(coordinator.getStatePath(), 'utf-8'), stateBefore);
    assert.deepStrictEqual(repository.readCanonical('bot-a')?.prompt, { selected: 'default' });
  });

  test('migrates an existing active override only for the active bot', async () => {
    const { coordinator, repository } = createCoordinator('bot-a');
    fs.mkdirSync(path.dirname(coordinator.getActivePromptPath()), { recursive: true });
    fs.writeFileSync(coordinator.getActivePromptPath(), 'legacy override\n', 'utf-8');

    await coordinator.activateBot('bot-a');
    assert.equal(repository.readCanonical('bot-a')?.prompt?.selected, 'custom');
    assert.equal(repository.readCanonical('bot-a')?.prompt?.customSystemPrompt, 'legacy override');

    repository.writeCanonical({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-b',
      model: { kind: 'catalog', modelId: 'minimax-m3' },
    });
    repository.writeCache(repository.readCanonical('bot-b')!);
    await coordinator.activateBot('bot-b');

    assert.equal(repository.readCanonical('bot-b')?.prompt?.selected, 'default');
    assert.equal(fs.readFileSync(coordinator.getActivePromptPath(), 'utf-8'), 'bundled v1\n');
  });

  test('assigns a legacy override to the old bot before the first switch', async () => {
    const { coordinator, repository } = createCoordinator('bot-a');
    repository.writeCanonical({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-b',
      model: { kind: 'catalog', modelId: 'minimax-m3' },
    });
    repository.writeCache(repository.readCanonical('bot-b')!);
    fs.mkdirSync(path.dirname(coordinator.getActivePromptPath()), { recursive: true });
    fs.writeFileSync(coordinator.getActivePromptPath(), 'legacy prompt from bot A\n', 'utf-8');

    await coordinator.prepareCurrentBotForSwitch();
    createCatsCoLocalConfigService({ runtimeRoot, env }).save({
      version: 1,
      currentBot: {
        uid: 'bot-b',
        apiKey: 'bot-api-key',
        boundByUserUid: 'owner-a',
        bindingSource: 'test',
      },
    });
    await coordinator.activateBot('bot-b');

    assert.deepStrictEqual(repository.readCanonical('bot-a')?.prompt, {
      selected: 'custom',
      customSystemPrompt: 'legacy prompt from bot A',
    });
    assert.deepStrictEqual(repository.readCanonical('bot-b')?.prompt, {
      selected: 'default',
    });
    assert.equal(fs.readFileSync(coordinator.getActivePromptPath(), 'utf-8'), 'bundled v1\n');
  });
});
