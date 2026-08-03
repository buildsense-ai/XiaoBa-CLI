import { test } from 'node:test';
import * as assert from 'node:assert';
import * as crypto from 'node:crypto';
import { computeBotSkillPackageHash } from '../src/bot-skills/local-manifest';
import { BotPrivateSkillClient } from '../src/bot-skills/private-package-client';
import type { BotSkillPackageFile, LocalBotSkillManifestEntry } from '../src/bot-skills/types';

const enabled = process.env.XIAOBA_REAL_SKILLHUB_CONTRACT === '1';

test('real SkillHub private package upload is idempotent and downloadable', {
  skip: !enabled,
}, async () => {
  const baseUrl = requiredEnvironment('XIAOBA_SKILLHUB_CONTRACT_BASE_URL');
  const botId = requiredEnvironment('XIAOBA_SKILLHUB_CONTRACT_BOT_ID');
  const apiKey = requiredEnvironment('XIAOBA_SKILLHUB_CONTRACT_API_KEY');
  const localSkillId = `contract-${crypto.randomUUID()}`;
  const name = `contract-${localSkillId.slice(-12)}`;
  const skillBytes = Buffer.from([
    '---',
    `name: ${name}`,
    'description: XiaoBa private Skill contract probe.',
    '---',
    '',
    'This package is created only by the explicitly enabled real contract test.',
    '',
  ].join('\n'), 'utf8');
  const files: BotSkillPackageFile[] = [{
    path: 'SKILL.md',
    size: skillBytes.byteLength,
    sha256: sha256(skillBytes),
    contentBase64: skillBytes.toString('base64'),
  }];
  const contentHash = computeBotSkillPackageHash(files);
  const entry: LocalBotSkillManifestEntry = {
    localSkillId,
    name,
    installName: name,
    path: `contract://${localSkillId}`,
    contentHash,
    files,
  };
  const client = new BotPrivateSkillClient({
    botId,
    baseUrl,
    auth: {
      apiKey,
      botUid: botId,
      httpBaseUrl: 'https://app.catsco.cc',
      serverUrl: 'wss://app.catsco.cc/v0/channels',
    },
  });

  const created = await client.upsert(entry);
  const retried = await client.upsert(entry);

  assert.deepStrictEqual(retried.reference, created.reference);
  assert.equal(retried.contentHash, contentHash);

  const downloaded = await client.download({
    source: 'skillhub',
    ...created.reference,
    contentHash,
  });

  assert.equal(downloaded.localSkillId, localSkillId);
  assert.equal(downloaded.name, name);
  assert.equal(downloaded.contentHash, contentHash);
  assert.deepStrictEqual(downloaded.files, files);
});

function requiredEnvironment(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required when the real SkillHub contract test is enabled`);
  return value;
}

function sha256(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
