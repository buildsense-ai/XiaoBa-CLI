import { buildRuntimeContextMessage, buildRuntimeContextSnapshot, TRANSIENT_RUNTIME_CONTEXT_PREFIX } from '../src/core/runtime-context-builder';
import { TurnContextBuilder } from '../src/core/turn-context-builder';
import { executeRouteIfRemote, resolveExecutionRoute } from '../src/tools/execution-router';
import { ToolManager } from '../src/tools/tool-manager';
import type { ExecutionScope, ScopedDeviceGrant, ScopedDeviceSelection } from '../src/types/session-identity';
import type { ToolExecutionContext, ToolExecutionResult } from '../src/types/tool';

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

const windowsSelection: ScopedDeviceSelection = {
  kind: 'user_device_selection',
  source: 'catscompany',
  status: 'selected',
  selectionSource: 'single_active_device',
  sessionKey,
  topicId: 'p2p_85_320',
  topicType: 'p2p',
  actorUserId: 'usr85',
  agentId: 'usr320',
  identityTrust: 'server_canonical',
  identitySource: 'metadata.catsco_identity',
  selectedDeviceId: 'device_user_windows',
  selectedDeviceDisplayName: 'usr85 Windows desktop',
  selectedDeviceBodyId: 'device_user_windows_body',
  selectedDeviceInstallationId: 'device_user_windows_install',
  selectedDeviceOperations: ['resolve_common_directory', 'glob', 'read_file', 'write_file', 'edit_file', 'execute_shell'],
  createdAt: now,
};

const linuxSelection: ScopedDeviceSelection = {
  ...windowsSelection,
  selectionSource: 'most_recent_online',
  selectedDeviceId: 'cloud-demo-runtime',
  selectedDeviceDisplayName: 'cloud demo runtime',
  selectedDeviceBodyId: 'cloud-demo-runtime',
  selectedDeviceInstallationId: 'cloud-demo-runtime',
};

function grantFor(selection: ScopedDeviceSelection): ScopedDeviceGrant {
  return {
    kind: 'user_device_grant',
    source: 'catscompany',
    grantId: `grant_${selection.selectedDeviceId}`,
    status: 'active',
    identityTrust: 'server_canonical',
    identitySource: 'server_canonical_message',
    deviceId: selection.selectedDeviceId || '',
    deviceDisplayName: selection.selectedDeviceDisplayName,
    deviceBodyId: selection.selectedDeviceBodyId,
    deviceInstallationId: selection.selectedDeviceInstallationId,
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
  };
}

function printSection(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function compactSnapshot(snapshot: ReturnType<typeof buildRuntimeContextSnapshot>): unknown {
  if (!snapshot) return null;
  return {
    schema: snapshot.schema,
    conversation: snapshot.conversation,
    executionTargets: snapshot.executionTargets,
    defaultTarget: snapshot.defaultTarget,
    toolRules: snapshot.toolRules,
  };
}

async function buildTurnMessages(deviceSelection: ScopedDeviceSelection, deviceGrants: ScopedDeviceGrant[]) {
  const builder = new TurnContextBuilder();
  return builder.build({
    sessionKey,
    sessionType: 'catscompany',
    executionScope: scope,
    deviceSelection,
    deviceGrants,
    durableMessages: [{ role: 'user', content: '看看我的桌面有什么' }],
    runtimeFeedback: [],
    skillRuntime: {
      reloadSkills: async () => undefined,
      buildSkillsListMessage: () => null,
    } as any,
  });
}

async function simulateCase(name: string, deviceSelection: ScopedDeviceSelection): Promise<void> {
  const deviceGrants = [grantFor(deviceSelection)];

  printSection(`${name}: runtime context snapshot`);
  const snapshot = buildRuntimeContextSnapshot({
    sessionKey,
    sessionType: 'catscompany',
    executionScope: scope,
    deviceSelection,
    deviceGrants,
  });
  console.log(JSON.stringify(compactSnapshot(snapshot), null, 2));

  printSection(`${name}: transient message preview`);
  const message = buildRuntimeContextMessage({
    sessionKey,
    sessionType: 'catscompany',
    executionScope: scope,
    deviceSelection,
    deviceGrants,
  });
  console.log(String(message?.content || '').slice(0, 4000));

  printSection(`${name}: full turn injected messages`);
  const turn = await buildTurnMessages(deviceSelection, deviceGrants);
  console.log(JSON.stringify(turn.messages.map((item, index) => ({
    index,
    role: item.role,
    prefix: typeof item.content === 'string' && item.content.startsWith(TRANSIENT_RUNTIME_CONTEXT_PREFIX)
      ? TRANSIENT_RUNTIME_CONTEXT_PREFIX
      : undefined,
    preview: typeof item.content === 'string' ? item.content.slice(0, 1000) : item.content,
  })), null, 2));

  printSection(`${name}: router default target`);
  const routeDefault = resolveExecutionRoute(baseToolContext(snapshot, deviceSelection, deviceGrants), {
    toolName: 'glob',
    operation: 'glob',
  });
  console.log(JSON.stringify(routeDefault, null, 2));

  printSection(`${name}: router speaker_default target`);
  const context = baseToolContext(snapshot, deviceSelection, deviceGrants);
  const routeSpeaker = resolveExecutionRoute(context, {
    toolName: 'glob',
    operation: 'glob',
    target: 'speaker_default',
  });
  console.log(JSON.stringify(routeSpeaker, null, 2));

  const remoteResult = await executeRouteIfRemote(context, routeSpeaker, 'glob', 'glob', {
    path: deviceSelection.selectedDeviceId === 'cloud-demo-runtime' ? '/root/Desktop' : 'C:\\Users\\usr85\\Desktop',
    pattern: '*',
    target: 'speaker_default',
  });
  console.log('\nRemote result returned to model:');
  console.log(JSON.stringify(remoteResult, null, 2));

  printSection(`${name}: ToolManager transcript result`);
  const manager = new ToolManager(process.cwd(), baseToolContext(snapshot, deviceSelection, deviceGrants));
  const toolResult = await manager.executeTool({
    id: `call_${deviceSelection.selectedDeviceId}`,
    type: 'function',
    function: {
      name: 'glob',
      arguments: JSON.stringify({
        path: deviceSelection.selectedDeviceId === 'cloud-demo-runtime' ? '/root/Desktop' : 'C:\\Users\\usr85\\Desktop',
        pattern: '*',
        target: 'speaker_default',
      }),
    },
  });
  console.log(JSON.stringify({
    ok: toolResult.ok,
    name: toolResult.name,
    targetContext: toolResult.targetContext,
    content: toolResult.content,
  }, null, 2));

  printSection(`${name}: execute_shell dangerous command before routing`);
  const shellResult = await manager.executeTool({
    id: `shell_${deviceSelection.selectedDeviceId}`,
    type: 'function',
    function: {
      name: 'execute_shell',
      arguments: JSON.stringify({
        command: 'Remove-Item -Recurse -Force C:\\Temp\\xiaoba-routing-test',
        target: 'speaker_default',
      }),
    },
  });
  console.log(JSON.stringify({
    ok: shellResult.ok,
    name: shellResult.name,
    targetContext: shellResult.targetContext,
    content: shellResult.content,
    errorCode: shellResult.errorCode,
  }, null, 2));
}

function baseToolContext(
  executionContext: ReturnType<typeof buildRuntimeContextSnapshot>,
  deviceSelection: ScopedDeviceSelection,
  deviceGrants: ScopedDeviceGrant[],
): ToolExecutionContext {
  return {
    workingDirectory: process.cwd(),
    workspaceRoot: process.cwd(),
    conversationHistory: [],
    sessionId: sessionKey,
    surface: 'catscompany',
    permissionProfile: 'relaxed',
    executionScope: scope,
    deviceSelection,
    deviceGrants,
    executionContext: executionContext || undefined,
    deviceRpc: {
      executeTool: async request => {
        const staleRemoteMarker = [
          '[tool_target]',
          'tool: glob',
          'operation: glob',
          'target: agent_self',
          `target_display_name: ${deviceSelection.selectedDeviceDisplayName}`,
          'path_scope: Paths in this result belong only to the target above.',
          '[/tool_target]',
        ].join('\n');
        const content = deviceSelection.selectedDeviceId === 'cloud-demo-runtime'
          ? `${staleRemoteMarker}\n\nResolved on Linux: /root/Desktop`
          : `${staleRemoteMarker}\n\nResolved on Windows: C:\\Users\\usr85\\Desktop`;
        const result: ToolExecutionResult = {
          ok: true,
          content: [
            `Captured RPC targetDeviceId=${request.targetDeviceId}`,
            `Captured RPC targetDeviceBodyId=${request.targetDeviceBodyId}`,
            `Captured RPC targetDeviceInstallationId=${request.targetDeviceInstallationId}`,
            content,
          ].join('\n'),
        };
        return result;
      },
    },
  };
}

async function main(): Promise<void> {
  await simulateCase('Expected Windows speaker_default', windowsSelection);
  await simulateCase('Mis-selected Linux speaker_default', linuxSelection);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
