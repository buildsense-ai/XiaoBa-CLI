import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyCompatibility } from './verify-catscompany-compatibility.mjs';

function fixture(protocols) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-compat-'));
  const manifest = path.join(root, 'xiaoba-cli-compatibility.json');
  fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, clientRepository: 'buildsense-ai/XiaoBa-CLI', protocols }));
  return { root, manifest };
}

function fakeFetch(status) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, async json() { return { status }; } };
  };
  return { fetch, calls };
}

test('passes with no compatibility manifest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-compat-empty-'));
  const messages = await verifyCompatibility({ manifestPath: path.join(root, 'missing.json'), currentSha: 'release-sha' });
  assert.match(messages[0], /skipped/);
});

test('passes when the release commit contains the required client commit', async () => {
  const { manifest } = fixture([{ id: 'multi-device', minimumClientCommit: 'client-sha' }]);
  const fake = fakeFetch('ahead');
  const messages = await verifyCompatibility({ manifestPath: manifest, currentSha: 'release-sha', fetchImpl: fake.fetch });
  assert.match(messages[0], /passed/);
  assert.match(fake.calls[0], /client-sha\.\.\.release-sha/);
});

test('fails when the release commit does not contain the required client commit', async () => {
  const { manifest } = fixture([{ id: 'multi-device', minimumClientCommit: 'client-sha' }]);
  const fake = fakeFetch('behind');
  await assert.rejects(
    verifyCompatibility({ manifestPath: manifest, currentSha: 'release-sha', fetchImpl: fake.fetch }),
    /does not contain client-sha/,
  );
});
