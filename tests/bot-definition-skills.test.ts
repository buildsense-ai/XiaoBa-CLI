import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { FileBotDefinitionRepository } from '../src/bot-definition/repository';
import {
  createBotDefinitionSyncService,
  normalizeBotSkillRefs,
} from '../src/bot-definition/service';
import { BOT_DEFINITION_SCHEMA } from '../src/bot-definition/types';

describe('BotDefinition Skill contract', () => {
  let runtimeRoot: string;
  let simulatedCloudRoot: string;

  beforeEach(() => {
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-bot-skills-definition-'));
    simulatedCloudRoot = path.join(runtimeRoot, 'cloud');
  });

  afterEach(() => {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  test('distinguishes a legacy missing skills field from an explicit empty list', () => {
    const repository = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    repository.writeCanonical({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'model-a' },
    });
    repository.writeCache({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-beta',
      model: { kind: 'catalog', modelId: 'model-b' },
      skills: [],
    });

    assert.equal(repository.readCanonical('bot-alpha')?.skills, undefined);
    assert.deepStrictEqual(repository.readCache('bot-beta')?.skills, []);
  });

  test('normalizes exact Skill references with stable ordering and duplicate removal', () => {
    assert.deepStrictEqual(normalizeBotSkillRefs([
      { skillId: ' zed/weather ', version: ' 2.0.0 ' },
      { skillId: 'alice/browser', version: '1.0.3' },
      { skillId: 'alice/browser', version: '1.0.3' },
      { skillId: '中/skill', version: '1.0.0' },
    ]), [
      { skillId: 'alice/browser', version: '1.0.3' },
      { skillId: 'zed/weather', version: '2.0.0' },
      { skillId: '中/skill', version: '1.0.0' },
    ]);
    assert.throws(
      () => normalizeBotSkillRefs([
        { skillId: 'alice/browser', version: '1.0.3' },
        { skillId: 'alice/browser', version: '2.0.0' },
      ]),
      /multiple versions/,
    );
    assert.throws(
      () => normalizeBotSkillRefs([{ skillId: 123, version: {} }] as unknown as Array<{ skillId: string; version: string }>),
      /non-empty skillId and version/,
    );
    assert.throws(
      () => normalizeBotSkillRefs('not-an-array' as unknown as Array<{ skillId: string; version: string }>),
      /must be an array/,
    );
  });

  test('normalizes botId consistently in the file path and persisted Definition', () => {
    const repository = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    repository.writeCanonical({
      schema: BOT_DEFINITION_SCHEMA,
      botId: ' bot-alpha ',
      model: { kind: 'catalog', modelId: 'model-a' },
    });

    assert.deepStrictEqual(repository.readCanonical('bot-alpha'), {
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'model-a' },
    });
  });

  test('rejects malformed Skill references in persisted definitions', () => {
    const repository = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    const canonicalPath = repository.getCanonicalPath('bot-alpha');
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, JSON.stringify({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'model-a' },
      skills: [{ skillId: 'alice/browser', version: '' }],
    }));

    assert.equal(repository.readCanonical('bot-alpha'), undefined);

    fs.writeFileSync(canonicalPath, JSON.stringify({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'model-a' },
      skills: 'not-an-array',
    }));
    assert.equal(repository.readCanonical('bot-alpha'), undefined);

    fs.writeFileSync(canonicalPath, JSON.stringify({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'model-a' },
      skills: [
        { skillId: 'alice/browser', version: '1.0.3' },
        { skillId: 'alice/browser', version: '2.0.0' },
      ],
    }));
    assert.equal(repository.readCanonical('bot-alpha'), undefined);
  });

  test('normalizes harmless duplicate references into cache without mutating canonical on pull', () => {
    const repository = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    const canonicalPath = repository.getCanonicalPath('bot-alpha');
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, JSON.stringify({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'model-a' },
      skills: [
        { skillId: 'alice/browser', version: '1.0.3' },
        { skillId: 'alice/browser', version: '1.0.3' },
      ],
    }));
    const service = createBotDefinitionSyncService({ runtimeRoot, simulatedCloudRoot, repository });

    const definition = service.pull('bot-alpha');

    assert.deepStrictEqual(definition?.skills, [
      { skillId: 'alice/browser', version: '1.0.3' },
    ]);
    assert.equal(repository.readCanonical('bot-alpha')?.skills?.length, 2);
    assert.deepStrictEqual(repository.readCache('bot-alpha'), definition);
  });

  test('never bootstraps over an invalid canonical Definition', () => {
    const repository = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    const canonicalPath = repository.getCanonicalPath('bot-alpha');
    const original = JSON.stringify({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'model-a' },
      skills: [{ skillId: 'alice/browser', version: '' }],
    });
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, original);
    const service = createBotDefinitionSyncService({
      runtimeRoot,
      simulatedCloudRoot,
      repository,
      env: {
        CATSCO_MODEL_SOURCE: 'relay',
        CATSCO_RELAY_LLM_MODEL: 'gpt-5.6-terra',
      },
    });

    assert.throws(
      () => service.pullOrBootstrap('bot-alpha'),
      /canonical record is invalid.*refusing to overwrite/,
    );
    assert.equal(fs.readFileSync(canonicalPath, 'utf-8'), original);
  });

  test('uses a valid local cache when canonical is invalid without overwriting canonical', () => {
    const repository = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    repository.writeCache({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'local-model' },
      skills: [{ skillId: 'local/current', version: '2.0.0' }],
    });
    const canonicalPath = repository.getCanonicalPath('bot-alpha');
    const original = '{"schema":"xiaoba.bot-definition.v1","broken":true}';
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, original);
    const service = createBotDefinitionSyncService({ runtimeRoot, simulatedCloudRoot, repository });

    const result = service.pullOrBootstrap('bot-alpha');

    assert.deepStrictEqual(result?.definition, repository.readCache('bot-alpha'));
    assert.deepStrictEqual(result?.definition.skills, [
      { skillId: 'local/current', version: '2.0.0' },
    ]);
    assert.equal(fs.readFileSync(canonicalPath, 'utf-8'), original);
  });

  test('rejects updates over invalid canonical while preserving the local cache', () => {
    const repository = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    const localDefinition = {
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog' as const, modelId: 'local-model' },
      skills: [{ skillId: 'local/current', version: '2.0.0' }],
    };
    repository.writeCache(localDefinition);
    const canonicalPath = repository.getCanonicalPath('bot-alpha');
    const original = '{"schema":"xiaoba.bot-definition.v1","broken":true}';
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, original);
    const service = createBotDefinitionSyncService({ runtimeRoot, simulatedCloudRoot, repository });

    assert.throws(
      () => service.updateModel('bot-alpha', { kind: 'catalog', modelId: 'new-model' }),
      /canonical record is invalid.*refusing to overwrite/,
    );
    assert.deepStrictEqual(repository.readCache('bot-alpha'), localDefinition);
    assert.equal(fs.readFileSync(canonicalPath, 'utf-8'), original);
  });

  test('updating a legacy model does not mark Skill migration complete', () => {
    const repository = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    repository.writeCache({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'old-model' },
    });
    const service = createBotDefinitionSyncService({ runtimeRoot, simulatedCloudRoot, repository });

    const result = service.updateModel('bot-alpha', { kind: 'catalog', modelId: 'new-model' });

    assert.equal(Object.prototype.hasOwnProperty.call(result.definition, 'skills'), false);
  });

  test('updating the model preserves Skill references', () => {
    const repository = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    repository.writeCache({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'old-model' },
      skills: [{ skillId: 'alice/browser', version: '1.0.3' }],
    });
    const service = createBotDefinitionSyncService({ runtimeRoot, simulatedCloudRoot, repository });

    const result = service.updateModel('bot-alpha', { kind: 'catalog', modelId: 'new-model' });

    assert.deepStrictEqual(result.definition.skills, [
      { skillId: 'alice/browser', version: '1.0.3' },
    ]);
    assert.deepStrictEqual(repository.readCanonical('bot-alpha'), result.definition);
    assert.deepStrictEqual(repository.readCache('bot-alpha'), result.definition);
  });

  test('updating the model preserves canonical Skill state over stale cache state', () => {
    const repository = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    repository.writeCanonical({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'canonical-model' },
      skills: [{ skillId: 'cloud/old', version: '1.0.0' }],
    });
    repository.writeCache({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'local-model' },
      skills: [{ skillId: 'local/current', version: '2.0.0' }],
    });
    const service = createBotDefinitionSyncService({ runtimeRoot, simulatedCloudRoot, repository });

    const result = service.updateModel('bot-alpha', { kind: 'catalog', modelId: 'new-model' });

    assert.deepStrictEqual(result.definition.skills, [
      { skillId: 'cloud/old', version: '1.0.0' },
    ]);
  });

  test('updating the model inherits canonical Skills when a legacy cache has no Skills field', () => {
    const repository = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    repository.writeCanonical({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'canonical-model' },
      skills: [{ skillId: 'cloud/current', version: '2.0.0' }],
    });
    repository.writeCache({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'legacy-cache-model' },
    });
    const service = createBotDefinitionSyncService({ runtimeRoot, simulatedCloudRoot, repository });

    const result = service.updateModel('bot-alpha', { kind: 'catalog', modelId: 'new-model' });

    assert.deepStrictEqual(result.definition.skills, [
      { skillId: 'cloud/current', version: '2.0.0' },
    ]);
  });

  test('updating the model falls back to canonical Skill references when cache is missing', () => {
    const repository = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    repository.writeCanonical({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'old-model' },
      skills: [{ skillId: 'alice/browser', version: '1.0.3' }],
    });
    const service = createBotDefinitionSyncService({ runtimeRoot, simulatedCloudRoot, repository });

    const result = service.publish('bot-alpha', { kind: 'catalog', modelId: 'new-model' });

    assert.deepStrictEqual(result.definition.skills, [
      { skillId: 'alice/browser', version: '1.0.3' },
    ]);
  });

  test('updating Skill references preserves the model and normalizes the list', () => {
    const repository = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    repository.writeCanonical({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'model-a', reasoningEffort: 'high' },
    });
    const service = createBotDefinitionSyncService({ runtimeRoot, simulatedCloudRoot, repository });

    const result = service.updateSkills('bot-alpha', [
      { skillId: 'zed/weather', version: '2.0.0' },
      { skillId: 'alice/browser', version: '1.0.3' },
    ]);

    assert.deepStrictEqual(result.definition.model, {
      kind: 'catalog',
      modelId: 'model-a',
      reasoningEffort: 'high',
    });
    assert.deepStrictEqual(result.definition.skills, [
      { skillId: 'alice/browser', version: '1.0.3' },
      { skillId: 'zed/weather', version: '2.0.0' },
    ]);
  });

  test('updating Skill references preserves a complete custom model', () => {
    const repository = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    const customModel = {
      kind: 'custom' as const,
      protocol: 'openai-responses' as const,
      apiBase: 'https://models.example.test/v1',
      model: 'custom-model',
      apiKey: 'sk-custom',
      contextWindowTokens: 200_000,
      reasoningEffort: 'high' as const,
    };
    repository.writeCache({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: customModel,
    });
    const service = createBotDefinitionSyncService({ runtimeRoot, simulatedCloudRoot, repository });

    const result = service.updateSkills('bot-alpha', []);

    assert.deepStrictEqual(result.definition.model, customModel);
    assert.deepStrictEqual(result.definition.skills, []);
  });

  test('keeps an explicit empty Skill list through later model updates and pulls', () => {
    const repository = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    repository.writeCanonical({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'model-a' },
    });
    const service = createBotDefinitionSyncService({ runtimeRoot, simulatedCloudRoot, repository });

    service.updateSkills('bot-alpha', []);
    service.updateModel('bot-alpha', { kind: 'catalog', modelId: 'model-b' });
    const definition = service.pull('bot-alpha');

    assert.deepStrictEqual(definition?.skills, []);
  });

  test('pull keeps canonical Skill references authoritative over a stale cache', () => {
    const repository = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    repository.writeCanonical({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'model-a' },
      skills: [{ skillId: 'cloud/weather', version: '2.0.0' }],
    });
    repository.writeCache({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'stale-model' },
      skills: [{ skillId: 'local/old', version: '1.0.0' }],
    });
    const service = createBotDefinitionSyncService({ runtimeRoot, simulatedCloudRoot, repository });

    const definition = service.pull('bot-alpha');

    assert.deepStrictEqual(definition?.skills, [{ skillId: 'cloud/weather', version: '2.0.0' }]);
    assert.deepStrictEqual(repository.readCache('bot-alpha'), definition);
  });

  test('does not create an incomplete Definition from Skill references alone', () => {
    const service = createBotDefinitionSyncService({ runtimeRoot, simulatedCloudRoot });
    assert.throws(
      () => service.updateSkills('bot-alpha', [{ skillId: 'alice/browser', version: '1.0.3' }]),
      /before its model has been initialized/,
    );
  });

  test('keeps cloud model overrides model-only while returning an effective definition with local Skills', () => {
    const repository = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    repository.writeCache({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'local-model' },
      skills: [{ skillId: 'alice/browser', version: '1.0.3' }],
    });
    const service = createBotDefinitionSyncService({ runtimeRoot, simulatedCloudRoot, repository });

    const result = service.acceptCloud('bot-alpha', { kind: 'catalog', modelId: 'cloud-model' });
    const persistedOverride = service.readCloudModelOverride('bot-alpha');

    assert.deepStrictEqual(result.definition, {
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'cloud-model' },
      skills: [{ skillId: 'alice/browser', version: '1.0.3' }],
    });
    assert.deepStrictEqual(persistedOverride, {
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-alpha',
      model: { kind: 'catalog', modelId: 'cloud-model' },
    });
  });
});
