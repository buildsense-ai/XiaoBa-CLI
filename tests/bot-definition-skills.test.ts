import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pullCloudBotDefinition } from '../src/bot-definition/cloud-client';
import { FileBotDefinitionRepository } from '../src/bot-definition/repository';
import { createBotDefinitionSyncService } from '../src/bot-definition/service';
import { canonicalizeBotSkillRefs } from '../src/bot-skills/canonical';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('BotDefinition Skill slice', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  test('updates Skills without replacing model or prompt fields', () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-definition-skills-runtime-'));
    const simulatedCloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-definition-skills-cloud-'));
    roots.push(runtimeRoot, simulatedCloudRoot);
    const service = createBotDefinitionSyncService({ runtimeRoot, simulatedCloudRoot });
    service.publish('bot-a', { kind: 'catalog', modelId: 'minimax-m3' });
    service.updatePrompt('bot-a', {
      selected: 'custom',
      customSystemPrompt: 'Keep this prompt',
    });

    const result = service.updateSkills('bot-a', [
      { source: 'skillhub', skillId: 'zeta', version: '2.0.0', contentHash: HASH_B },
      { source: 'skillhub', skillId: 'alpha', version: '1.0.0', contentHash: HASH_A },
    ]);

    assert.deepStrictEqual(result.definition.model, { kind: 'catalog', modelId: 'minimax-m3' });
    assert.equal(result.definition.prompt?.customSystemPrompt, 'Keep this prompt');
    assert.deepStrictEqual(result.definition.skills, [
      { source: 'skillhub', skillId: 'alpha', version: '1.0.0', contentHash: HASH_A },
      { source: 'skillhub', skillId: 'zeta', version: '2.0.0', contentHash: HASH_B },
    ]);
  });

  test('rejects duplicate Skill IDs and control characters', () => {
    assert.throws(() => canonicalizeBotSkillRefs([
      { source: 'skillhub', skillId: 'same', version: '1', contentHash: HASH_A },
      { source: 'skillhub', skillId: 'same', version: '2', contentHash: HASH_B },
    ]), /duplicate skillId/);
    assert.throws(() => canonicalizeBotSkillRefs([
      { source: 'skillhub', skillId: 'bad\nid', version: '1', contentHash: HASH_A },
    ]), /invalid skillId/);
  });

  test('does not rewrite the one-time simulated canonical file when Skills change', () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-definition-skills-runtime-'));
    const simulatedCloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-definition-skills-cloud-'));
    roots.push(runtimeRoot, simulatedCloudRoot);
    const repository = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot });
    const legacyCanonical = {
      schema: 'xiaoba.bot-definition.v1' as const,
      botId: 'bot-a',
      model: { kind: 'catalog' as const, modelId: 'minimax-m3' },
      prompt: { selected: 'default' as const },
    };
    repository.writeCanonical(legacyCanonical);
    const service = createBotDefinitionSyncService({ runtimeRoot, simulatedCloudRoot });
    service.pullOrBootstrap('bot-a');
    service.updateSkills('bot-a', [{
      source: 'skillhub',
      skillId: 'alpha',
      version: '1',
      contentHash: HASH_A,
    }]);

    assert.deepStrictEqual(repository.readCanonical('bot-a'), legacyCanonical);
    assert.equal(repository.readCache('bot-a')?.skills?.[0]?.contentHash, HASH_A);
  });

  test('parses Skills from the complete cloud BotDefinition snapshot', async () => {
    const snapshot = await pullCloudBotDefinition({
      botId: 'bot-a',
      auth: {
        apiKey: 'bot-key',
        httpBaseUrl: 'https://cats.test',
        serverUrl: 'wss://cats.test',
      },
      fetchImpl: (async () => Response.json({
        configured: true,
        revision: 9,
        definition: {
          schema: 'xiaoba.bot-definition.v1',
          botId: 'bot-a',
          model: { kind: 'catalog', modelId: 'minimax-m3' },
          prompt: { selected: 'default' },
          skills: [{
            source: 'skillhub',
            skillId: 'alpha',
            version: '1',
            contentHash: HASH_A,
          }],
        },
      })) as typeof fetch,
    });
    assert.equal(snapshot?.revision, 9);
    assert.equal(snapshot?.definition?.skills?.[0]?.contentHash, HASH_A);
  });

  test('preserves whether the cloud BotDefinition omitted or explicitly cleared Skills', async () => {
    const pull = (definition: Record<string, unknown>) => pullCloudBotDefinition({
      botId: 'bot-a',
      auth: {
        apiKey: 'bot-key',
        httpBaseUrl: 'https://cats.test',
        serverUrl: 'wss://cats.test',
      },
      fetchImpl: (async () => Response.json({
        configured: true,
        revision: 10,
        definition: {
          schema: 'xiaoba.bot-definition.v1',
          botId: 'bot-a',
          model: { kind: 'catalog', modelId: 'minimax-m3' },
          ...definition,
        },
      })) as typeof fetch,
    });

    const unsupported = await pull({});
    const explicitlyEmpty = await pull({ skills: [] });
    const legacyNullEmpty = await pull({ skills: null });

    assert.equal(
      Object.prototype.hasOwnProperty.call(unsupported?.definition ?? {}, 'skills'),
      false,
    );
    assert.deepStrictEqual(explicitlyEmpty?.definition?.skills, []);
    assert.deepStrictEqual(legacyNullEmpty?.definition?.skills, []);
    await assert.rejects(pull({ skills: {} }), /invalid BotDefinition Skills field/);
  });
});
