import * as crypto from 'crypto';
import { CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS, SkillHubTrustedRootKey } from './trusted-keys';

export interface SkillHubSignature {
  algorithm: 'ed25519';
  keyId: string;
  signature: string;
  signedAt?: string;
}

export interface SkillHubSigningKeyCertificate {
  schemaVersion: string;
  subject: {
    keyId: string;
    algorithm: 'ed25519';
    publicKeyPem: string;
    fingerprintSha256: string;
  };
  issuer: {
    keyId: string;
    algorithm: 'ed25519';
    publicKeyFingerprintSha256: string;
  };
  usages: string[];
  issuedAt: string;
  expiresAt: string;
  signature: SkillHubSignature;
}

export interface SkillHubTrustKey {
  keyId: string;
  algorithm: 'ed25519';
  publicKeyPem: string;
  fingerprintSha256: string;
  certificate: SkillHubSigningKeyCertificate;
}

export interface SkillHubTrustResponse {
  trustModel: 'root-signed-signing-keys';
  root?: {
    keyId: string;
    algorithm: 'ed25519';
    fingerprintSha256: string;
  };
  keys: SkillHubTrustKey[];
}

export interface SkillHubRegistryEntry {
  skillId: string;
  name?: string;
  displayName?: string;
  latestVersion: string;
  packageUrl: string;
  checksumSha256: string;
  signature: SkillHubSignature;
}

export interface SkillHubPackageFile {
  path: string;
  size: number;
  sha256: string;
  contentBase64: string;
}

export interface SkillHubPackageObject {
  payload: {
    packageSchemaVersion: string;
    manifest: {
      id: string;
      name: string;
      version: string;
      [key: string]: unknown;
    };
    files: SkillHubPackageFile[];
    [key: string]: unknown;
  };
  signature: SkillHubSignature;
  checksum: {
    algorithm: 'sha256';
    payloadSha256: string;
  };
}

export interface SkillHubPackageVerificationInput {
  packageBytes: Buffer;
  registryEntry: SkillHubRegistryEntry;
  trust: SkillHubTrustResponse;
  trustedRoots?: SkillHubTrustedRootKey[];
  now?: Date;
}

export interface SkillHubPackageVerificationResult {
  packageObject: SkillHubPackageObject;
  signingKey: SkillHubTrustKey;
  root: SkillHubTrustedRootKey;
}

export class SkillHubVerificationError extends Error {
  readonly status = 422;

  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'SkillHubVerificationError';
  }
}

const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_PACKAGE_FILES = 256;
const MAX_PACKAGE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGE_TOTAL_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PACKAGE_PATH_BYTES = 512;
const MAX_PACKAGE_PATH_DEPTH = 16;

export function verifySkillHubPackage(input: SkillHubPackageVerificationInput): SkillHubPackageVerificationResult {
  if (input.packageBytes.length > MAX_PACKAGE_BYTES) {
    throw new SkillHubVerificationError(
      `SkillHub package exceeds ${MAX_PACKAGE_BYTES} bytes.`,
      'PACKAGE_TOO_LARGE',
    );
  }
  const trustedRoots = input.trustedRoots ?? CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS;
  if (trustedRoots.length === 0) {
    throw new SkillHubVerificationError('CatsCo SkillHub root public key is not embedded in this Agent build.', 'TRUST_ROOT_MISSING');
  }
  if (input.trust.trustModel !== 'root-signed-signing-keys') {
    throw new SkillHubVerificationError('Unsupported SkillHub trust model.', 'TRUST_MODEL_UNSUPPORTED');
  }
  if (!Array.isArray(input.trust.keys) || input.trust.keys.length === 0) {
    throw new SkillHubVerificationError('SkillHub trust API returned no signing keys.', 'TRUST_KEYS_MISSING');
  }

  const packageSha256 = sha256Hex(input.packageBytes);
  if (packageSha256 !== input.registryEntry.checksumSha256) {
    throw new SkillHubVerificationError('SkillHub package checksum mismatch.', 'PACKAGE_CHECKSUM_MISMATCH');
  }

  const packageObject = parsePackageObject(input.packageBytes);
  if (packageObject.signature.keyId !== input.registryEntry.signature.keyId) {
    throw new SkillHubVerificationError('Registry signature key does not match package signature key.', 'SIGNATURE_KEY_MISMATCH');
  }
  if (packageObject.signature.signature !== input.registryEntry.signature.signature) {
    throw new SkillHubVerificationError('Registry signature does not match package signature.', 'SIGNATURE_MISMATCH');
  }

  const signingKey = input.trust.keys.find(key => key.keyId === packageObject.signature.keyId);
  if (!signingKey) {
    throw new SkillHubVerificationError('Package signing key was not returned by SkillHub trust API.', 'SIGNING_KEY_NOT_FOUND');
  }

  const root = verifySigningKeyCertificate(signingKey, trustedRoots, input.now ?? new Date());
  verifyPayloadSignature(packageObject.payload, packageObject.signature, signingKey.publicKeyPem, 'PACKAGE_SIGNATURE_INVALID');

  const payloadSha256 = sha256Hex(Buffer.from(canonicalJson(packageObject.payload)));
  if (payloadSha256 !== packageObject.checksum.payloadSha256) {
    throw new SkillHubVerificationError('Package payload checksum mismatch.', 'PAYLOAD_CHECKSUM_MISMATCH');
  }

  if (packageObject.payload.manifest.id !== input.registryEntry.skillId) {
    throw new SkillHubVerificationError('Package skill id does not match registry metadata.', 'MANIFEST_SKILL_ID_MISMATCH');
  }
  if (packageObject.payload.manifest.version !== input.registryEntry.latestVersion) {
    throw new SkillHubVerificationError('Package version does not match registry metadata.', 'MANIFEST_VERSION_MISMATCH');
  }

  const entryFile = String(
    (packageObject.payload.manifest as any).entrypoints?.skillFile
      || (packageObject.payload.manifest as any).entry
      || 'SKILL.md',
  );
  if (entryFile !== 'SKILL.md') {
    throw new SkillHubVerificationError(
      'SkillHub packages must use the root SKILL.md as their only runtime entrypoint.',
      'PACKAGE_ENTRYPOINT_UNSUPPORTED',
    );
  }
  verifyPackageFiles(packageObject.payload.files);
  return { packageObject, signingKey, root };
}

export function verifySigningKeyCertificate(
  signingKey: SkillHubTrustKey,
  trustedRoots: SkillHubTrustedRootKey[],
  now: Date = new Date(),
): SkillHubTrustedRootKey {
  const certificate = signingKey.certificate;
  if (!certificate || certificate.schemaVersion !== '1.0.0') {
    throw new SkillHubVerificationError('Invalid signing key certificate schema.', 'CERT_SCHEMA_INVALID');
  }
  if (!certificate.usages.includes('skillpkg.sign')) {
    throw new SkillHubVerificationError('Signing key certificate is not valid for skill package signing.', 'CERT_USAGE_INVALID');
  }
  const issuedAt = new Date(certificate.issuedAt).getTime();
  const expiresAt = new Date(certificate.expiresAt).getTime();
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    throw new SkillHubVerificationError('Signing key certificate dates are invalid.', 'CERT_DATE_INVALID');
  }
  if (issuedAt > now.getTime()) {
    throw new SkillHubVerificationError('Signing key certificate is not valid yet.', 'CERT_NOT_YET_VALID');
  }
  if (expiresAt <= now.getTime()) {
    throw new SkillHubVerificationError('Signing key certificate has expired.', 'CERT_EXPIRED');
  }
  if (certificate.subject.keyId !== signingKey.keyId || certificate.subject.publicKeyPem !== signingKey.publicKeyPem) {
    throw new SkillHubVerificationError('Signing key certificate subject does not match returned key.', 'CERT_SUBJECT_MISMATCH');
  }
  const signingKeyFingerprint = fingerprintPublicKeyPem(signingKey.publicKeyPem);
  if (signingKey.fingerprintSha256 !== signingKeyFingerprint || certificate.subject.fingerprintSha256 !== signingKeyFingerprint) {
    throw new SkillHubVerificationError('Signing key fingerprint mismatch.', 'SIGNING_KEY_FINGERPRINT_MISMATCH');
  }

  const root = trustedRoots.find(candidate => {
    return candidate.keyId === certificate.issuer.keyId &&
      fingerprintPublicKeyPem(candidate.publicKeyPem) === certificate.issuer.publicKeyFingerprintSha256;
  });
  if (!root) {
    throw new SkillHubVerificationError('Signing key certificate issuer is not trusted by this Agent build.', 'ROOT_NOT_TRUSTED');
  }
  if (certificate.signature.keyId !== certificate.issuer.keyId) {
    throw new SkillHubVerificationError('Signing key certificate signature key does not match issuer.', 'CERT_SIGNATURE_KEY_MISMATCH');
  }

  const { signature, ...certificatePayload } = certificate;
  verifyPayloadSignature(certificatePayload, signature, root.publicKeyPem, 'CERT_SIGNATURE_INVALID');
  return root;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function fingerprintPublicKeyPem(publicKeyPem: string): string {
  const key = crypto.createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  return `sha256:${crypto.createHash('sha256').update(der).digest('hex')}`;
}

function verifyPayloadSignature(payload: unknown, signature: SkillHubSignature, publicKeyPem: string, code: string): void {
  if (signature.algorithm !== 'ed25519') {
    throw new SkillHubVerificationError('Unsupported SkillHub signature algorithm.', 'SIGNATURE_ALGORITHM_UNSUPPORTED');
  }
  const ok = crypto.verify(
    null,
    Buffer.from(canonicalJson(payload)),
    publicKeyPem,
    Buffer.from(signature.signature, 'base64'),
  );
  if (!ok) {
    throw new SkillHubVerificationError('SkillHub signature verification failed.', code);
  }
}

function parsePackageObject(packageBytes: Buffer): SkillHubPackageObject {
  try {
    const parsed = JSON.parse(packageBytes.toString('utf8'));
    if (!parsed?.payload?.manifest || !parsed?.signature || !parsed?.checksum) {
      throw new Error('missing required package fields');
    }
    return parsed as SkillHubPackageObject;
  } catch (error: any) {
    throw new SkillHubVerificationError(`Invalid SkillHub package: ${error.message}`, 'PACKAGE_INVALID_JSON');
  }
}

function verifyPackageFiles(files: SkillHubPackageFile[]): void {
  if (!Array.isArray(files) || files.length === 0) {
    throw new SkillHubVerificationError('SkillHub package has no files.', 'PACKAGE_FILES_MISSING');
  }
  if (files.length > MAX_PACKAGE_FILES) {
    throw new SkillHubVerificationError(
      `SkillHub package contains more than ${MAX_PACKAGE_FILES} files.`,
      'PACKAGE_FILE_COUNT_EXCEEDED',
    );
  }
  const seen = new Set<string>();
  let skillEntryCount = 0;
  let totalDecodedBytes = 0;
  for (const file of files) {
    if (
      typeof file?.path !== 'string'
      || !Number.isSafeInteger(file.size)
      || file.size < 0
      || typeof file.sha256 !== 'string'
      || !/^[0-9a-f]{64}$/i.test(file.sha256)
      || typeof file.contentBase64 !== 'string'
      || !isCanonicalBase64(file.contentBase64)
    ) {
      throw new SkillHubVerificationError(
        'SkillHub package contains invalid file metadata.',
        'PACKAGE_FILE_METADATA_INVALID',
      );
    }
    const safePath = normalizePackagePath(file.path);
    const portableKey = safePath.normalize('NFC').toLocaleLowerCase('en-US');
    if (seen.has(portableKey)) {
      throw new SkillHubVerificationError(`Duplicate package file path: ${safePath}`, 'PACKAGE_FILE_DUPLICATE');
    }
    seen.add(portableKey);
    if (pathBasename(safePath).toLowerCase() === 'skill.md') {
      skillEntryCount += 1;
      if (safePath !== 'SKILL.md') {
        throw new SkillHubVerificationError(
          `Nested Skill entrypoints are not supported: ${safePath}`,
          'PACKAGE_NESTED_SKILL_UNSUPPORTED',
        );
      }
    }
    const content = Buffer.from(file.contentBase64, 'base64');
    if (content.length > MAX_PACKAGE_FILE_BYTES) {
      throw new SkillHubVerificationError(
        `Package file is too large: ${safePath}`,
        'PACKAGE_FILE_TOO_LARGE',
      );
    }
    totalDecodedBytes += content.length;
    if (totalDecodedBytes > MAX_PACKAGE_TOTAL_FILE_BYTES) {
      throw new SkillHubVerificationError(
        `Package files exceed ${MAX_PACKAGE_TOTAL_FILE_BYTES} decoded bytes.`,
        'PACKAGE_TOTAL_SIZE_EXCEEDED',
      );
    }
    if (content.length !== file.size) {
      throw new SkillHubVerificationError(`Package file size mismatch: ${safePath}`, 'PACKAGE_FILE_SIZE_MISMATCH');
    }
    if (sha256Hex(content) !== file.sha256) {
      throw new SkillHubVerificationError(`Package file checksum mismatch: ${safePath}`, 'PACKAGE_FILE_CHECKSUM_MISMATCH');
    }
  }
  if (skillEntryCount !== 1) {
    throw new SkillHubVerificationError(
      'SkillHub packages must contain exactly one root SKILL.md.',
      'PACKAGE_SKILL_ENTRY_COUNT_INVALID',
    );
  }
}

function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  try {
    return Buffer.from(value, 'base64').toString('base64') === value;
  } catch {
    return false;
  }
}

function normalizePackagePath(packagePath: string): string {
  const raw = String(packagePath || '');
  if (!raw || raw.includes('\0') || raw.includes('\\') || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) {
    throw new SkillHubVerificationError(`Unsafe package file path: ${raw}`, 'PACKAGE_FILE_PATH_UNSAFE');
  }
  const parts = raw.split('/');
  if (
    Buffer.byteLength(raw, 'utf8') > MAX_PACKAGE_PATH_BYTES
    || parts.length > MAX_PACKAGE_PATH_DEPTH
  ) {
    throw new SkillHubVerificationError(`Package file path is too long: ${raw}`, 'PACKAGE_FILE_PATH_UNSAFE');
  }
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new SkillHubVerificationError(`Unsafe package file path: ${raw}`, 'PACKAGE_FILE_PATH_UNSAFE');
  }
  if (parts.some(part =>
    part.includes(':')
    || /[<>"|?*\u0000-\u001f]/.test(part)
    || /[. ]$/.test(part)
    || isWindowsReservedName(part))) {
    throw new SkillHubVerificationError(`Unsafe portable package file path: ${raw}`, 'PACKAGE_FILE_PATH_UNSAFE');
  }
  if (parts.some(part => [
    '.xiaoba-skillhub-install.json',
    '.xiaoba-local-skill.json',
  ].includes(part.toLowerCase()))) {
    throw new SkillHubVerificationError(
      `Package cannot provide reserved local metadata: ${raw}`,
      'PACKAGE_RESERVED_FILE',
    );
  }
  return parts.join('/');
}

function isWindowsReservedName(segment: string): boolean {
  const stem = segment.replace(/[. ]+$/g, '').split('.')[0].toUpperCase();
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem);
}

function pathBasename(value: string): string {
  const parts = value.split('/');
  return parts[parts.length - 1] || '';
}

function sha256Hex(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sortValue(value: any): any {
  if (Array.isArray(value)) return value.map(item => sortValue(item));
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}
