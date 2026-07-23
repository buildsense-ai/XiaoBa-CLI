import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as crypto from 'crypto';
import {
  canonicalJson,
  fingerprintPublicKeyPem,
  SkillHubRegistryEntry,
  SkillHubTrustResponse,
  verifySkillHubPackage,
} from '../src/skillhub/package-verifier';
import { SkillHubTrustedRootKey } from '../src/skillhub/trusted-keys';

describe('SkillHub package trust chain verification', () => {
  test('accepts a package signed by a root-authorized signing key', () => {
    const fixture = createFixture();
    const result = verifySkillHubPackage({
      packageBytes: fixture.packageBytes,
      registryEntry: fixture.registryEntry,
      trust: fixture.trust,
      trustedRoots: [fixture.rootPublic],
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    assert.equal(result.packageObject.payload.manifest.id, 'contract-review');
    assert.equal(result.signingKey.keyId, 'catsco-skillhub-prod-2026-01');
    assert.equal(result.root.keyId, 'catsco-root-prod-2026-01');
  });

  test('rejects a signing key that is not authorized by the embedded root', () => {
    const fixture = createFixture();
    const otherRoot = generateKey('catsco-root-other');

    assert.throws(
      () => verifySkillHubPackage({
        packageBytes: fixture.packageBytes,
        registryEntry: fixture.registryEntry,
        trust: fixture.trust,
        trustedRoots: [otherRoot.public],
        now: new Date('2026-06-01T00:00:00.000Z'),
      }),
      /issuer is not trusted/,
    );
  });

  test('rejects a tampered package even when checksum metadata is present', () => {
    const fixture = createFixture();
    const tampered = Buffer.from(fixture.packageBytes);
    tampered[tampered.length - 2] = tampered[tampered.length - 2] ^ 1;

    assert.throws(
      () => verifySkillHubPackage({
        packageBytes: tampered,
        registryEntry: fixture.registryEntry,
        trust: fixture.trust,
        trustedRoots: [fixture.rootPublic],
        now: new Date('2026-06-01T00:00:00.000Z'),
      }),
      /checksum mismatch/,
    );
  });

  test('rejects portable path collisions, reserved metadata, and nested Skill entrypoints', () => {
    const cases = [
      {
        files: [
          makeFile('SKILL.md', '# Skill'),
          makeFile('readme.txt', 'one'),
          makeFile('README.TXT', 'two'),
        ],
        code: 'PACKAGE_FILE_DUPLICATE',
      },
      {
        files: [
          makeFile('SKILL.md', '# Skill'),
          makeFile('nested/.xiaoba-local-skill.json', '{}'),
        ],
        code: 'PACKAGE_RESERVED_FILE',
      },
      {
        files: [
          makeFile('SKILL.md', '# Skill'),
          makeFile('nested/SKILL.md', '# Nested'),
        ],
        code: 'PACKAGE_NESTED_SKILL_UNSUPPORTED',
      },
      {
        files: [
          makeFile('SKILL.md', '# Skill'),
          makeFile('CON.txt', 'unsafe'),
        ],
        code: 'PACKAGE_FILE_PATH_UNSAFE',
      },
      {
        files: [
          makeFile('SKILL.md', '# Skill'),
          makeFile('unsafe.', 'unsafe'),
        ],
        code: 'PACKAGE_FILE_PATH_UNSAFE',
      },
      {
        files: [
          makeFile('SKILL.md', '# Skill'),
          makeFile('unsafe ', 'unsafe'),
        ],
        code: 'PACKAGE_FILE_PATH_UNSAFE',
      },
    ];

    for (const item of cases) {
      const fixture = createFixture(item.files);
      assert.throws(
        () => verifySkillHubPackage({
          packageBytes: fixture.packageBytes,
          registryEntry: fixture.registryEntry,
          trust: fixture.trust,
          trustedRoots: [fixture.rootPublic],
          now: new Date('2026-06-01T00:00:00.000Z'),
        }),
        (error: any) => error?.code === item.code,
      );
    }
  });

  test('rejects excessive file counts and invalid certificate dates', () => {
    const tooMany = [
      makeFile('SKILL.md', '# Skill'),
      ...Array.from({ length: 256 }, (_, index) =>
        makeFile(`files/${index}.txt`, String(index))),
    ];
    const oversizedFixture = createFixture(tooMany);
    assert.throws(
      () => verifySkillHubPackage({
        packageBytes: oversizedFixture.packageBytes,
        registryEntry: oversizedFixture.registryEntry,
        trust: oversizedFixture.trust,
        trustedRoots: [oversizedFixture.rootPublic],
      }),
      (error: any) => error?.code === 'PACKAGE_FILE_COUNT_EXCEEDED',
    );

    const invalidDateFixture = createFixture();
    invalidDateFixture.trust.keys[0].certificate.issuedAt = 'not-a-date';
    assert.throws(
      () => verifySkillHubPackage({
        packageBytes: invalidDateFixture.packageBytes,
        registryEntry: invalidDateFixture.registryEntry,
        trust: invalidDateFixture.trust,
        trustedRoots: [invalidDateFixture.rootPublic],
      }),
      (error: any) => error?.code === 'CERT_DATE_INVALID',
    );
  });
});

function createFixture(files?: ReturnType<typeof makeFile>[]): {
  rootPublic: SkillHubTrustedRootKey;
  trust: SkillHubTrustResponse;
  registryEntry: SkillHubRegistryEntry;
  packageBytes: Buffer;
} {
  const root = generateKey('catsco-root-prod-2026-01');
  const signing = generateKey('catsco-skillhub-prod-2026-01');
  const certificatePayload = {
    schemaVersion: '1.0.0',
    subject: {
      keyId: signing.public.keyId,
      algorithm: 'ed25519' as const,
      publicKeyPem: signing.public.publicKeyPem,
      fingerprintSha256: fingerprintPublicKeyPem(signing.public.publicKeyPem),
    },
    issuer: {
      keyId: root.public.keyId,
      algorithm: 'ed25519' as const,
      publicKeyFingerprintSha256: fingerprintPublicKeyPem(root.public.publicKeyPem),
    },
    usages: ['skillpkg.sign'],
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
  };

  const certificate = {
    ...certificatePayload,
    signature: signPayload(certificatePayload, root.privateKeyPem, root.public.keyId),
  };

  const payload = {
    packageSchemaVersion: '1.0.0',
    manifest: {
      id: 'contract-review',
      name: 'contract-review',
      version: '1.0.0',
    },
    files: files ?? [
      makeFile('skill.json', JSON.stringify({ id: 'contract-review', version: '1.0.0' })),
      makeFile('SKILL.md', '# Contract Review\n\nReview contract risks.'),
    ],
  };
  const signature = signPayload(payload, signing.privateKeyPem, signing.public.keyId);
  const packageObject = {
    payload,
    signature,
    checksum: {
      algorithm: 'sha256' as const,
      payloadSha256: sha256(Buffer.from(canonicalJson(payload))),
    },
  };
  const packageBytes = Buffer.from(`${canonicalJson(packageObject)}\n`, 'utf8');

  return {
    rootPublic: root.public,
    trust: {
      trustModel: 'root-signed-signing-keys',
      root: {
        keyId: root.public.keyId,
        algorithm: 'ed25519',
        fingerprintSha256: fingerprintPublicKeyPem(root.public.publicKeyPem),
      },
      keys: [
        {
          keyId: signing.public.keyId,
          algorithm: 'ed25519',
          publicKeyPem: signing.public.publicKeyPem,
          fingerprintSha256: fingerprintPublicKeyPem(signing.public.publicKeyPem),
          certificate,
        },
      ],
    },
    registryEntry: {
      skillId: 'contract-review',
      latestVersion: '1.0.0',
      packageUrl: 'https://skillhub.example.com/packages/contract-review/1.0.0/package.skillpkg',
      checksumSha256: sha256(packageBytes),
      signature,
    },
    packageBytes,
  };
}

function generateKey(keyId: string): { public: SkillHubTrustedRootKey; privateKeyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    public: {
      keyId,
      algorithm: 'ed25519',
      publicKeyPem,
    },
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function signPayload(payload: unknown, privateKeyPem: string, keyId: string) {
  return {
    algorithm: 'ed25519' as const,
    keyId,
    signature: crypto.sign(null, Buffer.from(canonicalJson(payload)), privateKeyPem).toString('base64'),
    signedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeFile(filePath: string, content: string) {
  const buffer = Buffer.from(content, 'utf8');
  return {
    path: filePath,
    size: buffer.length,
    sha256: sha256(buffer),
    contentBase64: buffer.toString('base64'),
  };
}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
