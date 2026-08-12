import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  createBotRuntimeSkillInventory,
  reportBotRuntimeSkillInventory,
} from '../src/bot-skills/runtime-inventory';
import { inferCatsCompanyHttpBaseUrl } from '../src/catscompany';
import type { Skill } from '../src/types/skill';

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

  test('reports loaded Skills with a relative path and never exposes its runtime root', () => {
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

    const inventory = createBotRuntimeSkillInventory('42', skills, () => new Date('2026-08-12T06:00:00.000Z'));

    assert.deepEqual(inventory, {
      schema: 'xiaoba.bot-runtime-skills.v1',
      botId: '42',
      observedAt: '2026-08-12T06:00:00.000Z',
      skills: [{
        name: 'review',
        description: 'Review code changes',
        relativePath: 'tools/review/SKILL.md',
        userInvocable: true,
        contentHash: crypto.createHash('sha256').update(fs.readFileSync(skillPath)).digest('hex'),
        skillHub: {
          skillId: 'tools/review',
          version: '1.0.0',
          contentHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
      }],
    });
    assert.doesNotMatch(JSON.stringify(inventory), new RegExp(runtimeRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  test('uses Bot API-key authentication and tolerates older CatsCo servers', async () => {
    const requests: Array<{ url: string; authorization: string; body: unknown }> = [];
    const inventory = createBotRuntimeSkillInventory('42', [], () => new Date('2026-08-12T06:00:00.000Z'));
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

    const legacy = await reportBotRuntimeSkillInventory({
      botId: '42',
      auth: { apiKey: 'cc_test_key', httpBaseUrl: 'https://cats.example.test' },
      skills: [],
      fetchImpl: (async () => new Response('', { status: 404 })) as typeof fetch,
    });
    assert.equal(legacy, false);
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
});
