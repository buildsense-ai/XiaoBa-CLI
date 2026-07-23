import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { normalizeBotSkillRef } from '../bot-definition/skill-ref';
import type { BotSkillRef } from '../bot-definition/types';
import { createCatsCoLocalConfigService } from '../catscompany/local-config';
import { SkillHubClient } from '../skillhub/client';
import {
  verifySkillHubPackage,
  type SkillHubPackageFile,
} from '../skillhub/package-verifier';
import type {
  SkillHubBotCredential,
  SkillHubPackageInstallMarker,
  SkillHubPrivateSkillResponse,
  SkillHubRegistryEntry,
} from '../skillhub/types';
import type {
  BotSkillArtifactTransport,
  BotSkillArtifactTransportContext,
  BotSkillPrivateUploadInput,
} from './artifact-transport';
import {
  type SimulatedSkillArtifact,
  type SimulatedSkillArtifactFile,
  type SimulatedSkillArtifactStore,
} from './simulated-artifact-store';

const GENERATED_PACKAGE_FILES = new Set([
  'skill.json',
  'REVIEW.json',
  'SBOM.json',
  '.xiaoba-bundled-skill.json',
  '.xiaoba-skillhub-install.json',
  '.xiaoba-local-skill.json',
]);

export interface SkillHubBotSkillArtifactTransportOptions {
  runtimeRoot: string;
  env?: NodeJS.ProcessEnv;
  artifactStore: SimulatedSkillArtifactStore;
  client?: SkillHubClient;
}

export class SkillHubBotSkillArtifactTransport implements BotSkillArtifactTransport {
  private readonly runtimeRoot: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly artifactStore: SimulatedSkillArtifactStore;
  private readonly client: SkillHubClient;

  constructor(options: SkillHubBotSkillArtifactTransportOptions) {
    this.runtimeRoot = path.resolve(options.runtimeRoot);
    this.env = options.env ?? process.env;
    this.artifactStore = options.artifactStore;
    this.client = options.client ?? new SkillHubClient({
      baseUrl: firstNonEmpty(
        this.env.CATSCO_SKILLHUB_BASE_URL,
        this.env.SKILLHUB_BASE_URL,
      ),
    });
  }

  async upsertPrivate(input: BotSkillPrivateUploadInput): Promise<SimulatedSkillArtifact> {
    const credential = this.credential(input.botId);
    const snapshot = input.artifact;
    if (
      snapshot.storage !== 'simulated-private'
      || snapshot.botId !== input.botId
      || !snapshot.localSkillId
    ) {
      throw transportError(
        'Private Skill upload received an invalid local snapshot.',
        'BOT_SKILL_PRIVATE_SNAPSHOT_INVALID',
      );
    }
    assertNoSensitiveContent(snapshot.files);
    const response = await this.client.upsertPrivateSkill({
      botId: input.botId,
      workspaceId: input.workspaceId,
      localSkillId: snapshot.localSkillId,
      contentHash: snapshot.contentHash,
      name: snapshot.name,
      installName: snapshot.installName,
      ...(input.forkedFrom ? { forkedFrom: normalizeBotSkillRef(input.forkedFrom) } : {}),
      files: snapshot.files.map(file => ({ ...file })),
    }, credential) as SkillHubPrivateSkillResponse;
    const entry = requirePrivateEntry(response?.skill, {
      botId: input.botId,
      localSkillId: snapshot.localSkillId,
      contentHash: snapshot.contentHash,
      installName: snapshot.installName,
    });
    const verified = await this.fetchEntryVerified(
      entry,
      { botId: input.botId, workspaceId: input.workspaceId },
      credential,
    );
    if (
      verified.localSkillId !== snapshot.localSkillId
      || verified.contentHash !== snapshot.contentHash
      || filesDigest(verified.files) !== filesDigest(snapshot.files)
    ) {
      throw transportError(
        'SkillHub returned a package different from the uploaded private Skill snapshot.',
        'BOT_SKILL_PRIVATE_UPLOAD_VERIFY_MISMATCH',
      );
    }
    return verified;
  }

  async fetchVerified(
    refValue: BotSkillRef,
    context: BotSkillArtifactTransportContext,
  ): Promise<SimulatedSkillArtifact> {
    const ref = normalizeBotSkillRef(refValue);
    const privateHint = ref.skillId.startsWith('private:');
    const credential = privateHint ? this.credential(context.botId) : undefined;
    const detail = await this.client.getVersion(ref.skillId, ref.version, credential);
    const entry = normalizeExactEntry(detail?.version ?? detail?.skill, ref);
    if (entry.visibility === 'private' && !credential) {
      throw transportError(
        'Private Skill metadata was returned without Bot authorization.',
        'BOT_SKILL_PRIVATE_AUTH_REQUIRED',
      );
    }
    if (entry.visibility !== 'private' && privateHint) {
      throw transportError(
        'Reserved private Skill reference did not resolve to a private artifact.',
        'BOT_SKILL_PRIVATE_REF_MISMATCH',
      );
    }
    return this.fetchEntryVerified(
      entry,
      context,
      entry.visibility === 'private' ? credential ?? this.credential(context.botId) : undefined,
    );
  }

  private async fetchEntryVerified(
    registryEntry: SkillHubRegistryEntry,
    context: BotSkillArtifactTransportContext,
    credential?: SkillHubBotCredential,
  ): Promise<SimulatedSkillArtifact> {
    const [trust, packageBytes] = await Promise.all([
      this.client.getTrust(credential),
      this.client.downloadPackage(registryEntry, credential),
    ]);
    const verification = verifySkillHubPackage({
      packageBytes,
      registryEntry,
      trust,
    });
    const payload = verification.packageObject.payload as typeof verification.packageObject.payload & {
      privateMetadata?: {
        visibility?: unknown;
        ownerBotId?: unknown;
        localSkillId?: unknown;
        contentHash?: unknown;
        installName?: unknown;
      };
      contentHash?: unknown;
      installName?: unknown;
    };
    const ref = normalizeBotSkillRef({
      skillId: registryEntry.skillId,
      version: registryEntry.latestVersion,
    });
    const files = payload.files.map(toArtifactFile);
    const computedContentHash = contentHashOfPackageFiles(payload.files);
    const signatureTime = registryEntry.signature.signedAt
      ?? verification.packageObject.signature.signedAt;
    if (
      registryEntry.visibility !== undefined
      && registryEntry.visibility !== 'public'
      && registryEntry.visibility !== 'private'
    ) {
      throw transportError(
        'SkillHub returned an invalid Skill visibility.',
        'BOT_SKILL_REMOTE_VISIBILITY_INVALID',
      );
    }

    if (registryEntry.visibility === 'private') {
      const signedAt = stableIso(signatureTime);
      const signed = payload.privateMetadata;
      if (
        signed?.visibility !== 'private'
        || text(signed.ownerBotId) !== context.botId
        || text(signed.ownerBotId) !== text(registryEntry.ownerBotId)
        || text(signed.localSkillId) !== text(registryEntry.localSkillId)
        || hash(signed.contentHash) !== hash(registryEntry.contentHash)
        || hash(signed.contentHash) !== computedContentHash
        || text(signed.installName) !== text(registryEntry.installName)
      ) {
        throw transportError(
          'Signed private Skill scope does not match the requested Bot.',
          'BOT_SKILL_PRIVATE_SCOPE_MISMATCH',
        );
      }
      const marker = installMarker(
        registryEntry,
        signedAt,
        computedContentHash,
        {
          name: payload.manifest.name,
          installName: text(signed.installName),
        },
        {
          visibility: 'private',
          ownerBotId: context.botId,
          localSkillId: text(signed.localSkillId),
        },
      );
      return this.artifactStore.cacheVerified({
        ref,
        botId: context.botId,
        localSkillId: text(signed.localSkillId),
        storage: 'skillhub-private',
        name: payload.manifest.name,
        installName: text(signed.installName),
        contentHash: computedContentHash,
        files,
        installMarker: marker,
      });
    }

    if (payload.privateMetadata || registryEntry.ownerBotId || registryEntry.localSkillId) {
      throw transportError(
        'Public Skill package contains private scope metadata.',
        'BOT_SKILL_PUBLIC_SCOPE_INVALID',
      );
    }
    const signedContentHash = hash(payload.contentHash || computedContentHash);
    if (signedContentHash !== computedContentHash) {
      throw transportError(
        'Public Skill package content hash does not match its files.',
        'BOT_SKILL_PUBLIC_CONTENT_HASH_MISMATCH',
      );
    }
    const installName = text(payload.installName || payload.manifest.name);
    if (registryEntry.installName && text(registryEntry.installName) !== installName) {
      throw transportError(
        'Public Skill install name does not match signed package metadata.',
        'BOT_SKILL_PUBLIC_INSTALL_NAME_MISMATCH',
      );
    }
    const signedAt = optionalStableIso(signatureTime)
      ?? '1970-01-01T00:00:00.000Z';
    return this.artifactStore.cacheVerified({
      ref,
      botId: 'public',
      localSkillId: 'public',
      storage: 'skillhub-mirror',
      name: payload.manifest.name,
      installName,
      contentHash: computedContentHash,
      files,
      installMarker: installMarker(registryEntry, signedAt, computedContentHash, {
        name: payload.manifest.name,
        installName,
      }, {
        visibility: 'public',
      }),
    });
  }

  private credential(botIdValue: string): SkillHubBotCredential {
    const botId = text(botIdValue);
    const auth = createCatsCoLocalConfigService({
      runtimeRoot: this.runtimeRoot,
      env: this.env,
    }).getAuthState();
    if (text(auth.botUid) !== botId || !text(auth.apiKey)) {
      throw transportError(
        `Bot credential is unavailable for private Skill synchronization (${botId}).`,
        'BOT_SKILL_PRIVATE_BOT_AUTH_REQUIRED',
      );
    }
    return { botId, apiKey: text(auth.apiKey) };
  }
}

export function createSkillHubBotSkillArtifactTransport(
  options: SkillHubBotSkillArtifactTransportOptions,
): BotSkillArtifactTransport {
  return new SkillHubBotSkillArtifactTransport(options);
}

function normalizeExactEntry(
  value: SkillHubRegistryEntry | undefined,
  ref: BotSkillRef,
): SkillHubRegistryEntry {
  if (!value) {
    throw transportError('SkillHub exact version response is missing.', 'BOT_SKILL_REMOTE_VERSION_MISSING');
  }
  const actual = normalizeBotSkillRef({
    skillId: value.skillId,
    version: value.latestVersion,
  });
  if (actual.skillId !== ref.skillId || actual.version !== ref.version) {
    throw transportError('SkillHub exact version response does not match the requested ref.', 'BOT_SKILL_REMOTE_REF_MISMATCH');
  }
  return value;
}

function requirePrivateEntry(
  value: SkillHubRegistryEntry | undefined,
  expected: {
    botId: string;
    localSkillId: string;
    contentHash: string;
    installName: string;
  },
): SkillHubRegistryEntry {
  if (
    !value
    || value.visibility !== 'private'
    || !String(value.skillId || '').startsWith('private:')
    || text(value.ownerBotId) !== expected.botId
    || text(value.localSkillId) !== expected.localSkillId
    || hash(value.contentHash) !== expected.contentHash
    || text(value.installName) !== expected.installName
  ) {
    throw transportError(
      'SkillHub private upsert response does not match the requested Bot Skill.',
      'BOT_SKILL_PRIVATE_UPSERT_MISMATCH',
    );
  }
  normalizeBotSkillRef({ skillId: value.skillId, version: value.latestVersion });
  return value;
}

function installMarker(
  entry: SkillHubRegistryEntry,
  signedAt: string,
  contentHash: string,
  identity: { name: string; installName: string },
  scope:
    | { visibility: 'public' }
    | { visibility: 'private'; ownerBotId: string; localSkillId: string },
): SkillHubPackageInstallMarker {
  return {
    source: 'skillhub',
    ...scope,
    skillId: entry.skillId,
    name: text(identity.name),
    installName: text(identity.installName),
    version: entry.latestVersion,
    packageChecksumSha256: hash(entry.checksumSha256),
    installedContentHash: contentHash,
    signature: {
      ...entry.signature,
      signedAt,
    },
    packageUrl: `skillhub:${entry.skillId}@${entry.latestVersion}`,
    installedAt: signedAt,
  };
}

function toArtifactFile(file: SkillHubPackageFile): SimulatedSkillArtifactFile {
  return {
    path: file.path,
    size: file.size,
    sha256: file.sha256.toLowerCase(),
    contentBase64: file.contentBase64,
  };
}

function contentHashOfPackageFiles(files: SkillHubPackageFile[]): string {
  const entries = files
    .filter(file => !GENERATED_PACKAGE_FILES.has(file.path))
    .map(file => {
      const raw = Buffer.from(file.contentBase64, 'base64');
      const content = file.path === 'SKILL.md'
        ? Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
        : raw;
      return {
        path: file.path === 'SKILL.md.disabled' ? 'SKILL.md' : file.path,
        size: content.length,
        sha256: sha256(content),
      };
    })
    .sort((left, right) => Buffer.compare(
      Buffer.from(left.path, 'utf8'),
      Buffer.from(right.path, 'utf8'),
    ));
  return sha256(Buffer.from(JSON.stringify(entries), 'utf8'));
}

function filesDigest(files: SimulatedSkillArtifactFile[]): string {
  return sha256(Buffer.from(JSON.stringify(
    files.filter(file => !GENERATED_PACKAGE_FILES.has(file.path)).map(file => ({
      path: file.path,
      size: file.size,
      sha256: file.sha256,
    })).sort((left, right) => left.path.localeCompare(right.path)),
  ), 'utf8'));
}

function assertNoSensitiveContent(files: SimulatedSkillArtifactFile[]): void {
  for (const file of files) {
    const lower = file.path.toLowerCase();
    const basename = lower.split('/').pop() || lower;
    const content = Buffer.from(file.contentBase64, 'base64').toString('utf8');
    const blockedPath = (
      basename === '.env'
      || basename.startsWith('.env.')
      || ['.npmrc', '.pypirc', 'credentials', 'service-account.json', 'id_rsa', 'id_ed25519'].includes(basename)
    );
    const blockedContent = (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(content)
      || /\bAKIA[0-9A-Z]{16}\b/u.test(content)
      || /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u.test(content)
      || /\bsk-[A-Za-z0-9_-]{24,}\b/u.test(content)
      || /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u.test(content)
      || /\bAIza[0-9A-Za-z_-]{35}\b/u.test(content)
      || /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/u.test(content)
      || /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u.test(content)
      || /["']?(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{20,}/iu.test(content)
    );
    if (blockedPath || blockedContent) {
      throw transportError(
        `Private Skill contains blocked sensitive content: ${file.path}`,
        'BOT_SKILL_PRIVATE_CONTENT_BLOCKED',
      );
    }
  }
}

function stableIso(value: unknown): string {
  const raw = text(value);
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) {
    throw transportError('SkillHub signature has no stable signedAt timestamp.', 'BOT_SKILL_SIGNATURE_TIME_INVALID');
  }
  return new Date(time).toISOString();
}

function optionalStableIso(value: unknown): string | undefined {
  if (!text(value)) return undefined;
  return stableIso(value);
}

function hash(value: unknown): string {
  const normalized = text(value).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) {
    throw transportError('SkillHub returned an invalid SHA-256 value.', 'BOT_SKILL_REMOTE_HASH_INVALID');
  }
  return normalized;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function sha256(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function transportError(message: string, code: string): Error {
  const error: any = new Error(message);
  error.code = code;
  return error;
}
