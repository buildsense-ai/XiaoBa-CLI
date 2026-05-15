export interface SkillHubTrustedRootKey {
  keyId: string;
  algorithm: 'ed25519';
  publicKeyPem: string;
}

/**
 * CatsCo SkillHub trust anchors.
 *
 * Production releases should embed the CatsCo root public key here before
 * packaging the desktop Agent. The matching root private key stays only on
 * the SkillHub cloud side and signs package-signing key certificates.
 */
export const CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS: SkillHubTrustedRootKey[] = [];

