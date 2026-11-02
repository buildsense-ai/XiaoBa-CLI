// One-shot protocol bridge: real metadata parsers, routing and wire serializer.
// No model, socket, shell execution, user configuration or filesystem tools.
import fs from 'node:fs';
import { CatsClient } from '../../../src/catscompany/client';
import { CatsCompanyBot } from '../../../src/catscompany/index';
import { createCatsCoMessageEnvelope, createExecutionScope } from '../../../src/catscompany/message-envelope';
import { extractCatsCoRuntimeContext } from '../../../src/catscompany/runtime-context';
import { extractCatsCoDeviceGrants } from '../../../src/catscompany/device-grants';
import { extractCatsCoDeviceSelection } from '../../../src/catscompany/device-selection';
import { resolveExecutionRoute, executeRouteIfRemote } from '../../../src/tools/execution-router';
import type { ToolExecutionContext } from '../../../src/types/tool';
import { DeviceGrantLease } from '../../../src/core/device-grant-lease';

async function main() {
  console.log = console.error; // Keep stdout as a single JSON response.
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (input.now) Date.now = () => input.now;
  const envelope = createCatsCoMessageEnvelope({ topic: input.topic ?? 'p2p_7_42', senderId: input.senderId ?? 'usr7',
    text: '读取我的文件', seq: 1, botUid: input.botUid ?? '42', metadata: input.metadata });
  const executionScope = createExecutionScope(envelope);
  let wire: unknown;
  const client = Object.create(CatsClient.prototype) as any;
  client.msgId = 0;
  client.pendingThinToolRpc = new Map();
  client.pendingDeviceGrantRenewals = new Map();
  client.supportsDeviceGrantRenewal = !!input.renewalResult;
  let renewalWire: unknown;
  client.sendOrThrow = (envelope: any) => {
    renewalWire = envelope.device_grant_renewal;
    if (!input.renewalResult) throw new Error('Unexpected renewal without negotiation');
    client.handleMessage({ device_grant_renewal: { ...input.renewalResult,
      request_id: envelope.device_grant_renewal.request_id, grant_id: envelope.device_grant_renewal.grant_id } });
  };
  client.sendEnvelopeWithAck = async (_id: string, outgoing: any) => {
    wire = outgoing.thin_tool_rpc;
    const request = outgoing.thin_tool_rpc;
    // Resolve the transport without opening a connection. Go validates the
    // captured real wire message against its authoritative registry afterward.
    client.handleThinToolRpcMessage({ ...request, type: 'result',
      device_id: request.target_device_id, result: { ok: true, content: 'transport fixture only' } });
  };
  const bot = Object.create(CatsCompanyBot.prototype) as any;
  bot.bot = client;
  const ctx: ToolExecutionContext = {
    workingDirectory: '.', surface: 'catscompany', executionScope,
    targetResolutionState: {},
    targetRoutes: extractCatsCoRuntimeContext(input.metadata, executionScope),
    deviceGrants: extractCatsCoDeviceGrants(input.metadata, executionScope),
    deviceSelection: extractCatsCoDeviceSelection(input.metadata, executionScope),
    thinToolRpc: bot.buildThinToolRpcTransport(),
  };
  const attempts = [];
  if (input.renewalResult) await new DeviceGrantLease(() => ctx).refresh();
  for (const target of input.targets ?? [input.target]) {
    wire = undefined;
    const route = resolveExecutionRoute(ctx, { toolName: 'read_file', operation: 'read_file', target });
    const result = await executeRouteIfRemote(ctx, route, 'read_file', 'read_file', { file_path: 'fixture-only', target });
    attempts.push({ route, result, wire });
  }
  process.stdout.write(JSON.stringify({ ...attempts[attempts.length - 1], attempts, renewalWire, historySessionKey: envelope.sessionKey,
    devices: ctx.targetRoutes?.routes.map(item => item.deviceId) }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
