import { createHash } from 'crypto';
import type { ProviderApiType, ProviderStateReference } from '../types';

export function createProviderStateReference(input: {
  apiType: ProviderApiType;
  endpoint: string;
  model: string;
}): ProviderStateReference {
  return {
    schema: 'xiaoba.provider_state.v1',
    apiType: input.apiType,
    model: String(input.model || '').trim(),
    endpointFingerprint: createHash('sha256')
      .update(normalizeEndpointIdentity(input.endpoint))
      .digest('hex')
      .slice(0, 16),
  };
}

export function isProviderStateCompatible(
  actual: ProviderStateReference | undefined,
  expected: ProviderStateReference,
): boolean {
  return actual?.schema === expected.schema
    && actual.apiType === expected.apiType
    && actual.model === expected.model
    && actual.endpointFingerprint === expected.endpointFingerprint;
}

function normalizeEndpointIdentity(raw: string): string {
  const trimmed = String(raw || '').trim();
  try {
    const url = new URL(trimmed);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    return url.toString();
  } catch {
    return trimmed;
  }
}
