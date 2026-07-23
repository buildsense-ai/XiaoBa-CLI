import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBotSkillSyncBase } from '../src/bot-skills/sync-base';
import {
  readSkillHubInstallMarker,
  SKILLHUB_INSTALL_MARKER_FILE,
  writeSkillHubInstallMarker,
} from '../src/skillhub/install-marker';
import type { SkillHubPackageInstallMarker } from '../src/skillhub/types';

test('install marker accepts canonical public and bound private identities', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-marker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const publicDir = path.join(root, 'public-skill');
  writeSkillHubInstallMarker(publicDir, marker());
  const publicMarker = readSkillHubInstallMarker(publicDir);
  assert.equal(publicMarker?.visibility, 'public');
  assert.equal(publicMarker?.ownerBotId, undefined);
  assert.equal(publicMarker?.localSkillId, undefined);

  const privateDir = path.join(root, 'private-skill');
  writeSkillHubInstallMarker(privateDir, marker({
    visibility: 'private',
    ownerBotId: 'bot_A',
    localSkillId: 'local-skill-1',
  }));
  const privateMarker = readSkillHubInstallMarker(privateDir);
  assert.equal(privateMarker?.visibility, 'private');
  assert.equal(privateMarker?.ownerBotId, 'bot_A');
  assert.equal(privateMarker?.localSkillId, 'local-skill-1');
});

test('install marker canonicalizes legacy public metadata without visibility or signedAt', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-marker-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skillDir = path.join(root, 'legacy-public');
  fs.mkdirSync(skillDir);
  const legacy = marker();
  delete (legacy.signature as any).signedAt;
  fs.writeFileSync(
    path.join(skillDir, SKILLHUB_INSTALL_MARKER_FILE),
    `${JSON.stringify(legacy)}\n`,
    'utf8',
  );

  const restored = readSkillHubInstallMarker(skillDir);

  assert.equal(restored?.visibility, 'public');
  assert.equal(restored?.signature.signedAt, restored?.installedAt);
});

test('install marker rejects malformed identity, refs, hashes, signatures, times, and installName', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-marker-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const cases: Array<[string, Record<string, unknown>]> = [
    ['visibility', { visibility: 'shared' }],
    ['public-private-fields', { visibility: 'public', ownerBotId: 'bot_A' }],
    ['private-owner', { visibility: 'private', localSkillId: 'local-skill-1' }],
    ['private-local-id', { visibility: 'private', ownerBotId: 'bot_A' }],
    ['skill-ref', { skillId: '../outside' }],
    ['version-ref', { version: '../1.0.0' }],
    ['checksum', { packageChecksumSha256: 'not-a-sha256' }],
    ['content-hash', { installedContentHash: 'not-a-sha256' }],
    ['signature', { signature: { ...marker().signature, algorithm: 'rsa' } }],
    ['signed-at', { signature: { ...marker().signature, signedAt: 'not-a-time' } }],
    ['installed-at', { installedAt: 'not-a-time' }],
    ['impossible-date', { installedAt: '2026-02-30T00:00:00.000Z' }],
    ['install-name', { installName: '../outside' }],
  ];

  for (const [name, overrides] of cases) {
    const skillDir = path.join(root, name);
    fs.mkdirSync(skillDir);
    fs.writeFileSync(
      path.join(skillDir, SKILLHUB_INSTALL_MARKER_FILE),
      JSON.stringify({ ...marker(), ...overrides }),
      'utf8',
    );
    assert.equal(readSkillHubInstallMarker(skillDir), null, name);
  }
});

test('install marker writer validates before creating or replacing metadata', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-marker-write-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skillDir = path.join(root, 'invalid');

  assert.throws(
    () => writeSkillHubInstallMarker(
      skillDir,
      marker({ installName: 'CON' }) as SkillHubPackageInstallMarker,
    ),
    (error: any) => error?.code === 'INSTALL_MARKER_INVALID',
  );
  assert.equal(fs.existsSync(skillDir), false);
});

test('sync-base rejects an invalid Local sourceRef visibility', () => {
  assert.throws(
    () => createBotSkillSyncBase({
      botId: 'bot_A',
      workspaceId: 'workspace_A',
      localEntries: [{
        localSkillId: 'local-skill-1',
        name: 'notes',
        path: 'notes',
        enabled: true,
        contentHash: 'a'.repeat(64),
        source: 'skillhub',
        sourceRef: {
          skillId: 'alice/notes',
          version: '1.0.0',
          visibility: 'shared' as 'public',
        },
      }],
      bindings: [{
        localSkillId: 'local-skill-1',
        ref: { skillId: 'alice/notes', version: '1.0.0' },
        storage: 'skillhub-mirror',
        artifactDigest: 'b'.repeat(64),
      }],
      cloudSkills: [{ skillId: 'alice/notes', version: '1.0.0' }],
    }),
    /Invalid sourceRef\.visibility/,
  );
});

function marker(
  overrides: Partial<SkillHubPackageInstallMarker> = {},
): SkillHubPackageInstallMarker {
  return {
    source: 'skillhub',
    skillId: 'alice/notes',
    name: 'notes',
    installName: 'notes',
    version: '1.0.0',
    packageChecksumSha256: 'a'.repeat(64),
    installedContentHash: 'b'.repeat(64),
    signature: {
      algorithm: 'ed25519',
      keyId: 'test-key',
      signature: 'test-signature',
      signedAt: '2026-01-01T00:00:00.000Z',
    },
    packageUrl: '/package',
    installedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
