import { extractCatsCoDeviceGrants } from '../src/catscompany/device-grants';
import { extractCatsCoDeviceSelection } from '../src/catscompany/device-selection';
import { logCatsCoExecutionContextDiagnostics } from '../src/catscompany/execution-context-diagnostics';
import type { ExecutionScope } from '../src/types/session-identity';

const now = Date.now();
const sessionKey = 'session:v2:catscompany:p2p:p2p_85_320:agent:usr320';
const scope: ExecutionScope = {
  source: 'catscompany',
  sessionKey,
  topicId: 'p2p_85_320',
  topicType: 'p2p',
  actorUserId: 'usr85',
  agentId: 'usr320',
  agentBodyId: 'device_bot_windows',
  permissionsSource: 'server_canonical_message',
  identityTrust: 'server_canonical',
  isTrusted: true,
};

const metadata = {
  catsco_identity: {
    permissions: {
      source: 'server_canonical_message',
      device_owner_user_id: 'usr85',
      device_owner_source: 'actor',
    },
    device_selection: {
      kind: 'user_device_selection',
      source: 'catscompany',
      schemaVersion: 1,
      status: 'selected',
      selectionSource: 'most_recent_online',
      sessionKey,
      topicId: 'p2p_85_320',
      topicType: 'p2p',
      actorUserId: 'usr85',
      ownerUserId: 'usr85',
      agentId: 'usr320',
      selectedDevice: {
        deviceId: 'cloud-demo-runtime',
        displayName: 'cloud demo runtime',
        bodyId: 'cloud-demo-runtime',
        installationId: 'cloud-demo-runtime',
        operations: ['resolve_common_directory', 'glob', 'read_file', 'write_file', 'edit_file', 'execute_shell'],
        lastSeenAt: now,
      },
      candidates: [
        {
          deviceId: 'cloud-demo-runtime',
          displayName: 'cloud demo runtime',
          operations: ['resolve_common_directory', 'glob'],
          lastSeenAt: now,
        },
        {
          deviceId: 'device_user_windows',
          displayName: 'usr85 Windows desktop',
          operations: ['resolve_common_directory', 'glob', 'read_file', 'write_file', 'edit_file', 'execute_shell'],
          lastSeenAt: now - 1000,
        },
      ],
      candidateCount: 2,
      createdAt: now,
    },
    device_grants: [
      {
        kind: 'user_device_grant',
        source: 'catscompany',
        grantId: 'device_grant_linux',
        status: 'active',
        identityTrust: 'server_canonical',
        identitySource: 'metadata.catsco_identity',
        deviceId: 'cloud-demo-runtime',
        deviceDisplayName: 'cloud demo runtime',
        deviceBodyId: 'cloud-demo-runtime',
        deviceInstallationId: 'cloud-demo-runtime',
        ownerUserId: 'usr85',
        sessionKey,
        topicId: 'p2p_85_320',
        topicType: 'p2p',
        actorUserId: 'usr85',
        agentId: 'usr320',
        agentBodyId: 'device_bot_windows',
        operations: ['resolve_common_directory', 'glob', 'read_file', 'write_file', 'edit_file', 'execute_shell'],
        createdAt: now,
        expiresAt: now + 60_000,
      },
    ],
  },
};

process.env.XIAOBA_CATSCOMPANY_CONTEXT_DEBUG = 'true';

const deviceSelection = extractCatsCoDeviceSelection(metadata, scope);
const deviceGrants = extractCatsCoDeviceGrants(metadata, scope);

console.log('Extracted device selection:');
console.log(JSON.stringify(deviceSelection, null, 2));
console.log('\nExtracted device grants:');
console.log(JSON.stringify(deviceGrants, null, 2));
console.log('\nDiagnostic log preview:');
logCatsCoExecutionContextDiagnostics({
  sessionKey,
  topic: 'p2p_85_320',
  senderId: 'usr85',
  text: '看看我的桌面有什么',
  executionScope: scope,
  deviceSelection,
  deviceGrants,
});
