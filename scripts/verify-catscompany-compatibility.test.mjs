import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DEFAULT_MANIFEST, verifyCompatibility } from './verify-catscompany-compatibility.mjs';

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
  assert.match(messages[0], /compatibility.*skipped/);
});

test('does not depend on the caller working directory', async () => {
  const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
  assert.equal(DEFAULT_MANIFEST, path.resolve(scriptRoot, '..', 'cats-company', 'docs', 'xiaoba-cli-compatibility.json'));
  const previous = process.cwd();
  process.chdir(os.tmpdir());
  try {
    assert.notEqual(DEFAULT_MANIFEST, path.resolve(process.cwd(), 'cats-company', 'docs', 'xiaoba-cli-compatibility.json'));
  } finally {
    process.chdir(previous);
  }
});

test('rejects an empty protocol requirement', async () => {
  const { manifest } = fixture([{ id: 'multi-device', minimumClientCommit: '' }]);
  await assert.rejects(verifyCompatibility({ manifestPath: manifest, currentSha: 'release-sha' }), /needs id and minimumClientCommit/);
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
