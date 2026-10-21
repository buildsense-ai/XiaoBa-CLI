import type { DeviceGrantOperation } from '../../src/types/session-identity';
import type { ToolExecutionContext } from '../../src/types/tool';

// Explicit fake server-issued authorization for transport tests. No real token,
// network connection or user configuration is involved.
export function scopedDeviceContext(
  ownerUserId: string,
  deviceId: string,
  operations: DeviceGrantOperation[],
  sessionKey = 'session:v2:catscompany:p2p:p2p_test:agent:usr43',
): Pick<ToolExecutionContext, 'executionScope' | 'deviceGrants'> {
  const executionScope = {
    source: 'catscompany' as const, sessionKey, topicId: 'p2p_7_43', topicType: 'p2p' as const,
    actorUserId: ownerUserId, agentId: 'usr43', identityTrust: 'server_canonical' as const, isTrusted: true,
  };
  return {
    executionScope,
    deviceGrants: [{
      ...executionScope, kind: 'user_device_grant', grantId: 'fake-scoped-grant', status: 'active',
      ownerUserId, deviceId, operations, createdAt: Date.now(), expiresAt: Date.now() + 600_000,
    }],
  };
}
