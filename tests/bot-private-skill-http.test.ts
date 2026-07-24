import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HttpBotPrivateSkillPackageClient } from '../src/bot-skills/http-private-package';
import { buildBotSkillSourceSnapshot } from '../src/bot-skills/source-snapshot';

describe('HTTP Bot private Skill package transport', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-private-http-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('binds upload and download responses to the exact bytes and Cloud reference', async () => {
    fs.writeFileSync(path.join(root, 'SKILL.md'), [
      '---', 'name: alpha', 'description: alpha skill', '---', '', '# alpha', '',
    ].join('\n'));
    const snapshot = buildBotSkillSourceSnapshot(root);
    const reference = {
      skillId: `priv_${'a'.repeat(40)}`,
      version: `v_${'b'.repeat(48)}`,
    };
    const version = {
      reference,
      localSkillId: 'local-alpha',
      name: 'alpha',
      contentHash: snapshot.contentHash,
      createdAt: '2026-07-24T00:00:00.000Z',
    };
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify(
        init?.method === 'PUT'
          ? version
          : {
            ...version,
            files: snapshot.files.map(file => ({
              path: file.path,
              size: file.size,
              sha256: file.sha256,
              contentBase64: file.bytes.toString('base64'),
            })),
          },
      ), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const client = new HttpBotPrivateSkillPackageClient({
      baseUrl: 'https://skillhub.example',
      botId: 'bot-a',
      apiKey: 'secret-key',
      fetchImpl,
    });

    assert.deepStrictEqual(await client.upsert({
      localSkillId: 'local-alpha',
      name: 'alpha',
      snapshot,
    }), version);
    const downloaded = await client.download(reference);

    assert.equal(downloaded.files[0].bytes.equals(snapshot.files[0].bytes), true);
    assert.equal(requests.length, 2);
    assert.equal(new Headers(requests[0].init?.headers).get('authorization'), 'ApiKey secret-key');
    assert.equal(new Headers(requests[0].init?.headers).get('x-catsco-bot-id'), 'bot-a');
    assert.equal(requests[0].init?.redirect, 'error');
  });

  test('rejects mismatched references and tampered file bytes', async () => {
    const requested = {
      skillId: `priv_${'a'.repeat(40)}`,
      version: `v_${'b'.repeat(48)}`,
    };
    const response = {
      reference: requested,
      localSkillId: 'local-alpha',
      name: 'alpha',
      contentHash: 'c'.repeat(64),
      createdAt: '2026-07-24T00:00:00.000Z',
      files: [{
        path: 'SKILL.md',
        size: 3,
        sha256: 'd'.repeat(64),
        contentBase64: Buffer.from('bad').toString('base64'),
      }],
    };
    const client = new HttpBotPrivateSkillPackageClient({
      baseUrl: 'https://skillhub.example',
      botId: 'bot-a',
      apiKey: 'secret-key',
      fetchImpl: async () => new Response(JSON.stringify(response), { status: 200 }),
    });

    await assert.rejects(
      client.download(requested),
      (error: any) => error?.code === 'BOT_SKILL_PACKAGE_HASH_MISMATCH',
    );

    const mismatchClient = new HttpBotPrivateSkillPackageClient({
      baseUrl: 'https://skillhub.example',
      botId: 'bot-a',
      apiKey: 'secret-key',
      fetchImpl: async () => new Response(JSON.stringify({
        ...response,
        reference: { ...requested, skillId: `priv_${'e'.repeat(40)}` },
      }), { status: 200 }),
    });
    await assert.rejects(
      mismatchClient.download(requested),
      (error: any) => error?.code === 'BOT_SKILL_PACKAGE_REFERENCE_MISMATCH',
    );
  });

  test('accepts wrapped downloads, zero-byte files, and 160-character local ids', async () => {
    fs.writeFileSync(path.join(root, 'SKILL.md'), '# alpha\n');
    fs.writeFileSync(path.join(root, 'empty.txt'), '');
    const snapshot = buildBotSkillSourceSnapshot(root);
    const localSkillId = 'a'.repeat(160);
    const reference = {
      skillId: `priv_${'a'.repeat(40)}`,
      version: `v_${'b'.repeat(48)}`,
    };
    const packageValue = {
      reference,
      localSkillId,
      name: 'alpha',
      contentHash: snapshot.contentHash,
      createdAt: '2026-07-24T00:00:00.000Z',
      files: snapshot.files.map(file => ({
        path: file.path,
        size: file.size,
        sha256: file.sha256,
        contentBase64: file.bytes.toString('base64'),
      })),
    };
    const client = new HttpBotPrivateSkillPackageClient({
      baseUrl: 'https://skillhub.example',
      botId: 'bot-a',
      apiKey: 'secret-key',
      fetchImpl: async (_input, init) => new Response(JSON.stringify(
        init?.method === 'PUT'
          ? { package: packageValue }
          : { package: packageValue },
      ), { status: 200 }),
    });

    await client.upsert({ localSkillId, name: 'alpha', snapshot });
    const downloaded = await client.download(reference);
    assert.equal(downloaded.files.find(file => file.path === 'empty.txt')?.bytes.length, 0);
  });

  test('rejects upload responses whose name or origin does not match the request', async () => {
    fs.writeFileSync(path.join(root, 'SKILL.md'), '# alpha\n');
    const snapshot = buildBotSkillSourceSnapshot(root);
    const response = {
      reference: {
        skillId: `priv_${'a'.repeat(40)}`,
        version: `v_${'b'.repeat(48)}`,
      },
      localSkillId: 'local-alpha',
      name: 'substituted',
      contentHash: snapshot.contentHash,
      createdAt: '2026-07-24T00:00:00.000Z',
    };
    const client = new HttpBotPrivateSkillPackageClient({
      baseUrl: 'https://skillhub.example',
      botId: 'bot-a',
      apiKey: 'secret-key',
      fetchImpl: async () => new Response(JSON.stringify(response), { status: 200 }),
    });

    await assert.rejects(
      client.upsert({ localSkillId: 'local-alpha', name: 'alpha', snapshot }),
      (error: any) => error?.code === 'BOT_SKILL_PACKAGE_RESPONSE_MISMATCH',
    );
  });
});
