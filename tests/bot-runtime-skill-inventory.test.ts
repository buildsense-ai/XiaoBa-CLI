import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  createBotRuntimeSkillInventory,
  MAX_RUNTIME_SKILL_INVENTORY_BYTES,
  reportBotRuntimeSkillInventory,
} from '../src/bot-skills/runtime-inventory';
import {
  inferCatsCompanyHttpBaseUrl,
  resolveRuntimeSkillInventoryHttpBaseUrl,
} from '../src/catscompany';
import { resolveCatsCoRuntimeConfig } from '../src/catscompany/runtime-config';
import type { Skill } from '../src/types/skill';

const testSkillHash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Bot runtime Skill inventory', () => {
  let runtimeRoot: string;
  let previousSkillsDir: string | undefined;

  beforeEach(() => {
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-runtime-skill-inventory-'));
    previousSkillsDir = process.env.XIAOBA_SKILLS_DIR;
    process.env.XIAOBA_SKILLS_DIR = path.join(runtimeRoot, 'skills');
  });

  afterEach(() => {
    if (previousSkillsDir === undefined) delete process.env.XIAOBA_SKILLS_DIR;
    else process.env.XIAOBA_SKILLS_DIR = previousSkillsDir;
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  test('reports loaded Skills with a relative path and never exposes its runtime root', async () => {
    const skillDir = path.join(process.env.XIAOBA_SKILLS_DIR!, 'tools', 'review');
    const skillPath = path.join(skillDir, 'SKILL.md');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillPath, '---\nname: review\ndescription: Review code changes\n---\nReview.', 'utf8');
    fs.writeFileSync(path.join(skillDir, '.xiaoba-skillhub-install.json'), JSON.stringify({
      source: 'skillhub',
      skillId: 'tools/review',
      name: 'review',
      installName: 'review',
      version: '1.0.0',
      packageChecksumSha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    }));
    const skills: Skill[] = [{
      metadata: { name: 'review', description: 'Review code changes', userInvocable: true },
      content: 'Review.',
      filePath: skillPath,
    }];

    const inventory = await createBotRuntimeSkillInventory('42', skills, () => new Date('2026-08-12T06:00:00.000Z'));

    assert.deepEqual(inventory, {
      schema: 'xiaoba.bot-runtime-skills.v1',
      botId: '42',
      observedAt: '2026-08-12T06:00:00.000Z',
      skills: [{
        name: 'review',
        description: 'Review code changes',
        relativePath: 'tools/review/SKILL.md',
        userInvocable: true,
        fileHash: crypto.createHash('sha256').update(fs.readFileSync(skillPath)).digest('hex'),
        skillHub: {
          skillId: 'tools/review',
          version: '1.0.0',
          packageChecksumSha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
      }],
    });
    assert.doesNotMatch(JSON.stringify(inventory), new RegExp(runtimeRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  test('uses Bot API-key authentication and tolerates older CatsCo servers', async () => {
    const requests: Array<{ url: string; authorization: string; body: unknown }> = [];
    const inventory = await createBotRuntimeSkillInventory('42', [], () => new Date('2026-08-12T06:00:00.000Z'));
    const accepted = await reportBotRuntimeSkillInventory({
      botId: '42',
      auth: { apiKey: 'cc_test_key', httpBaseUrl: 'https://cats.example.test/' },
      skills: [],
      inventory,
      fetchImpl: (async (input, init) => {
        requests.push({
          url: String(input),
          authorization: String((init?.headers as Record<string, string>)?.Authorization || ''),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json({ ok: true });
      }) as typeof fetch,
    });

    assert.equal(accepted, true);
    assert.deepEqual(requests, [{
      url: 'https://cats.example.test/api/bot/skills/inventory',
      authorization: 'ApiKey cc_test_key',
      body: inventory,
    }]);

    const legacySkillDir = path.join(process.env.XIAOBA_SKILLS_DIR!, 'legacy');
    const legacySkillPath = path.join(legacySkillDir, 'SKILL.md');
    fs.mkdirSync(legacySkillDir, { recursive: true });
    fs.writeFileSync(legacySkillPath, 'legacy skill', 'utf8');
    fs.writeFileSync(path.join(legacySkillDir, '.xiaoba-skillhub-install.json'), JSON.stringify({
      source: 'skillhub',
      skillId: 'tools/legacy',
      name: 'legacy',
      installName: 'legacy',
      version: '1.0.0',
      packageChecksumSha256: testSkillHash,
    }));
    const inventoryWithV1Extensions = await createBotRuntimeSkillInventory('42', [{
      metadata: { name: 'legacy', description: 'Legacy compatibility fixture', userInvocable: true },
      content: '',
      filePath: legacySkillPath,
    }], () => new Date('2026-08-12T06:00:00.000Z'), {
      runtimeInstanceId: 'runtime-a',
      reportSequence: 7,
    });
    const legacyRequests: Array<Record<string, any>> = [];
    const legacy = await reportBotRuntimeSkillInventory({
      botId: '42',
      auth: { apiKey: 'cc_test_key', httpBaseUrl: 'https://cats.example.test' },
      inventory: inventoryWithV1Extensions,
      fetchImpl: (async (_input, init) => {
        legacyRequests.push(JSON.parse(String(init?.body || '{}')) as Record<string, any>);
        return new Response('', { status: legacyRequests.length === 1 ? 400 : 200 });
      }) as typeof fetch,
    });
    assert.equal(legacy, true);
    assert.equal(legacyRequests.length, 2);
    assert.equal(legacyRequests[0].runtimeInstanceId, 'runtime-a');
    assert.equal(legacyRequests[0].reportSequence, 7);
    assert.ok(legacyRequests[0].skills[0].fileHash);
    assert.equal(legacyRequests[0].skills[0].skillHub.packageChecksumSha256, testSkillHash);
    assert.equal('runtimeInstanceId' in legacyRequests[1], false);
    assert.equal('reportSequence' in legacyRequests[1], false);
    assert.equal(legacyRequests[1].skills[0].contentHash, legacyRequests[0].skills[0].fileHash);
    assert.equal('fileHash' in legacyRequests[1].skills[0], false);
    assert.equal(legacyRequests[1].skills[0].skillHub.contentHash, testSkillHash);
    assert.equal('packageChecksumSha256' in legacyRequests[1].skills[0].skillHub, false);
  });

  test('fits inventory to a UTF-8 byte budget and marks degraded entries', async () => {
    const skillDir = path.join(process.env.XIAOBA_SKILLS_DIR!, 'large');
    const skillPath = path.join(skillDir, 'SKILL.md');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillPath, 'x'.repeat(1024), 'utf8');
    const inventory = await createBotRuntimeSkillInventory('42', [{
      metadata: { name: 'large', description: '猫'.repeat(10_000), userInvocable: true },
      content: '',
      filePath: skillPath,
    }], () => new Date('2026-08-12T06:00:00.000Z'));
    assert.equal(inventory.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(inventory), 'utf8') <= MAX_RUNTIME_SKILL_INVENTORY_BYTES);
    assert.ok(inventory.skills.length <= 1);
    if (inventory.skills[0]) {
      assert.ok(Buffer.byteLength(inventory.skills[0].description, 'utf8') <= 4096);
    }
  });

  test('skips hashing an oversized SKILL.md without dropping its safe metadata', async () => {
    const skillDir = path.join(process.env.XIAOBA_SKILLS_DIR!, 'oversized');
    const skillPath = path.join(skillDir, 'SKILL.md');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillPath, 'x'.repeat((4 << 20) + 1), 'utf8');
    const inventory = await createBotRuntimeSkillInventory('42', [{
      metadata: { name: 'oversized', description: 'Large but valid', userInvocable: true },
      content: '',
      filePath: skillPath,
    }]);

    assert.equal(inventory.truncated, true);
    assert.deepEqual(inventory.skills.map((skill) => ({
      name: skill.name,
      relativePath: skill.relativePath,
      fileHash: skill.fileHash,
    })), [{
      name: 'oversized',
      relativePath: 'oversized/SKILL.md',
      fileHash: undefined,
    }]);
  });

  test('fails closed when deriving the inventory endpoint from an invalid server URL', async () => {
    assert.equal(inferCatsCompanyHttpBaseUrl('not a URL'), undefined);
    assert.equal(inferCatsCompanyHttpBaseUrl('ftp://cats.example.test/v0/channels'), undefined);
    assert.equal(inferCatsCompanyHttpBaseUrl('wss://cats.example.test/v0/channels?token=secret'), 'https://cats.example.test');

    const requests: string[] = [];
    const accepted = await reportBotRuntimeSkillInventory({
      botId: '42',
      auth: { apiKey: 'cc_test_key', httpBaseUrl: inferCatsCompanyHttpBaseUrl('not a URL') || '' },
      skills: [],
      fetchImpl: (async (input) => {
        requests.push(String(input));
        return Response.json({ ok: true });
      }) as typeof fetch,
    });

    assert.equal(accepted, false);
    assert.deepEqual(requests, []);
  });

  test('does not send the Bot API key to a default or cross-origin HTTP endpoint', () => {
    assert.equal(
      resolveRuntimeSkillInventoryHttpBaseUrl(
        'wss://self-hosted.example/v0/channels',
        'https://app.catsco.cc',
      ),
      undefined,
    );
    assert.equal(
      resolveRuntimeSkillInventoryHttpBaseUrl(
        'wss://self-hosted.example/v0/channels',
        'https://self-hosted.example/',
      ),
      'https://self-hosted.example',
    );
    assert.equal(
      resolveRuntimeSkillInventoryHttpBaseUrl('ws://127.0.0.1:6061/v0/channels'),
      'http://127.0.0.1:6061',
    );
    assert.equal(
      resolveRuntimeSkillInventoryHttpBaseUrl('wss://user:password@cats.example.test/v0/channels'),
      undefined,
    );
    assert.equal(
      resolveRuntimeSkillInventoryHttpBaseUrl(
        'wss://cats.example.test/v0/channels',
        'https://user:password@cats.example.test',
      ),
      undefined,
    );
  });

  test('derives a self-hosted HTTP API origin when only the WebSocket endpoint is configured', () => {
    const resolved = resolveCatsCoRuntimeConfig({
      runtimeRoot,
      env: {
        CATSCO_SERVER_URL: 'wss://self-hosted.example/v0/channels',
        CATSCO_USER_TOKEN: 'user-token',
        CATSCO_USER_UID: 'user-42',
        CATSCO_BOT_UID: 'bot-42',
        CATSCO_API_KEY: 'cc_test_key',
      },
      migrateLegacyEnvBinding: true,
    });

    assert.equal(resolved.connector?.serverUrl, 'wss://self-hosted.example/v0/channels');
    assert.equal(resolved.connector?.httpBaseUrl, 'https://self-hosted.example');
    assert.equal(resolved.auth.httpBaseUrl, 'https://self-hosted.example');
  });
});
