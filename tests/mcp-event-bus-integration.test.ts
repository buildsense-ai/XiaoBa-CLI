import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { ExternalEventRouter, type ExternalEventDispatch } from '../src/events/external-event-router';
import {
  createExternalEventArtifactSink,
  forwardMcpEventToExternalRouter,
} from '../src/events/event-bus-adapters';
import {
  startConnectorEventBridge,
  createForwardingArtifactEventSink,
  createForwardingArtifactMcpBridgeSink,
} from '../src/events/connector-event-bridge';
import { createArtifactEventsRouter } from '../src/dashboard/routes/artifact-events';
import { McpClientManager, mcpToolName } from '../src/mcp/mcp-client-manager';
import { adaptMcpNotification } from '../src/mcp/mcp-notification-adapter';
import { ArtifactMcpRegistry, artifactServerId } from '../src/mcp/artifact-mcp-registry';
import { validateServerConfig, McpConfigError } from '../src/mcp/mcp-config';
import { McpPersistentClient, type McpConnection, type McpConnectionHooks } from '../src/mcp/mcp-persistent-client';
import { ConversationRunner } from '../src/core/conversation-runner';
import type { Tool, ToolCall, ToolDefinition, ToolExecutor, ToolResult } from '../src/types/tool';

async function testMcpNotificationEndToEnd(): Promise<void> {
  const router = new ExternalEventRouter({ aggregationPolicies: {} });
  const dispatches: ExternalEventDispatch[] = [];
  router.subscribe((dispatch) => {
    dispatches.push(dispatch);
  });
  router.bindArtifact('art-42', { sessionKey: 'sess-mcp-1', topic: 'p2p_100_200' });

  const registeredTools = new Map<string, Tool>();
  let capturedHooks: McpConnectionHooks | undefined;

  const manager = new McpClientManager({
    toolManager: {
      registerTool: (tool) => registeredTools.set(tool.definition.name, tool),
      unregisterTool: (name) => registeredTools.delete(name),
    },
    servers: {
      design: {
        transport: 'streamable-http',
        url: 'https://mcp.example.test/mcp',
      },
    },
    createConnection: (_config, hooks): McpConnection => {
      capturedHooks = hooks;
      return {
        connect: async () => {},
        close: async () => {},
        listTools: async () => ({ tools: [{ name: 'inspect', description: 'Inspect artifact' }] }),
        callTool: async () => ({ isError: false, content: [{ type: 'text', text: 'ok' }] }),
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        subscribeResource: async () => {},
        unsubscribeResource: async () => {},
        listPrompts: async () => ({ prompts: [] }),
        getPrompt: async () => ({ messages: [] }),
      } as unknown as McpConnection;
    },
    onEvent: (event) => {
      forwardMcpEventToExternalRouter(event, router);
    },
  });

  manager.start();
  await manager.waitForInitialConnect();
  await manager.refreshServerTools('design');
  assert.equal(registeredTools.has('mcp_design_inspect'), true, 'should register remote MCP tool');
  assert.ok(capturedHooks, 'should capture MCP notification hooks');

  // 1. Untargeted notifications/tools/list_changed should NOT wake a session.
  capturedHooks.onNotification({ method: 'notifications/tools/list_changed', params: {} });
  assert.equal(dispatches.length, 0, 'untargeted list_changed should not dispatch to session');

  // 2. Targeted artifact event from MCP server should route via artifact binding to sess-mcp-1.
  capturedHooks.onNotification?.({
    method: 'notifications/artifact/a2ui',
    params: {
      artifactId: 'art-42',
      action: 'approve_layout',
      eventId: 'evt-mcp-1',
    },
  });
  await new Promise((r) => setImmediate(r));

  assert.equal(dispatches.length, 1, 'targeted MCP event should wake bound session');
  assert.equal(dispatches[0].sessionKey, 'sess-mcp-1');
  assert.equal(dispatches[0].topic, 'p2p_100_200');
  assert.equal(dispatches[0].event.source, 'mcp:design');

  await manager.closeAll();
  router.reset();
}

async function testArtifactHttpRoutesEndToEnd(): Promise<void> {
  const router = new ExternalEventRouter({
    aggregationPolicies: {
      'artifact:annotation': { windowMs: 30 },
    },
  });
  const dispatches: ExternalEventDispatch[] = [];
  router.subscribe((dispatch) => {
    dispatches.push(dispatch);
  });

  const app = express();
  app.use(express.json());
  app.use('/api', createArtifactEventsRouter(createExternalEventArtifactSink(router)));

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Bind artifact -> sessionKey/topic
    const bindRes = await fetch(`${baseUrl}/api/artifacts/art-ui-1/bind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionKey: 'sess-ui-1', topic: 'p2p_1_2' }),
    });
    assert.equal(bindRes.status, 200);
    const bindJson = await bindRes.json() as any;
    assert.equal(bindJson.ok, true);

    // 2. Emit A2UI action -> immediate wakeup
    const a2uiRes = await fetch(`${baseUrl}/api/artifacts/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventId: 'evt-a2ui-1',
        kind: 'a2ui_action',
        artifactId: 'art-ui-1',
        actorUserId: 'usr-9',
        componentId: 'btn-deploy',
        actionName: 'click',
        payload: { env: 'staging' },
      }),
    });
    assert.equal(a2uiRes.status, 202);
    const a2uiJson = await a2uiRes.json() as any;
    assert.equal(a2uiJson.accepted, 1);
    await new Promise((r) => setImmediate(r));
    assert.equal(dispatches.length, 1, 'A2UI action should dispatch immediately');
    assert.equal(dispatches[0].sessionKey, 'sess-ui-1');
    assert.equal(dispatches[0].topic, 'p2p_1_2');
    assert.equal(dispatches[0].actorUserId, 'usr-9');
    assert.ok(dispatches[0].text.includes('btn-deploy'));

    // 3. Emit two rapid annotations -> coalesced into one wakeup
    for (const [id, comment] of [['ann-1', '改一下标题字号'], ['ann-2', '按钮对齐一下']]) {
      const res = await fetch(`${baseUrl}/api/artifacts/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          eventId: `evt-${id}`,
          kind: 'annotation_create',
          artifactId: 'art-ui-1',
          annotationId: id,
          anchor: { type: 'text', exact: 'title' },
          comment,
          batchSubmit: false,
        }),
      });
      assert.equal(res.status, 202);
    }

    assert.equal(dispatches.length, 1, 'annotations should wait for coalesce window');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(dispatches.length, 2, 'coalesced annotations should flush once');
    assert.equal(dispatches[1].sessionKey, 'sess-ui-1');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    router.reset();
  }
}

async function testPerArtifactDynamicMcpBridge(): Promise<void> {
  const router = new ExternalEventRouter({ aggregationPolicies: {} });
  const registry = new ArtifactMcpRegistry(router);
  const dispatches: ExternalEventDispatch[] = [];
  router.subscribe((dispatch) => {
    dispatches.push(dispatch);
  });

  const registeredTools = new Map<string, Tool>();
  let capturedHooks: McpConnectionHooks | undefined;
  let closed = false;

  const manager = new McpClientManager({
    toolManager: {
      registerTool: (tool) => registeredTools.set(tool.definition.name, tool),
      unregisterTool: (name) => registeredTools.delete(name),
    },
    createConnection: (_config, hooks): McpConnection => {
      capturedHooks = hooks;
      return {
        connect: async () => {},
        close: async () => { closed = true; },
        listTools: async () => ({
          tools: [
            { name: 'canvas_get_snapshot', description: 'Read canvas snapshot' },
            { name: 'canvas_patch', description: 'Patch canvas layout' },
          ],
        }),
        callTool: async () => ({ isError: false, content: [{ type: 'text', text: 'patched' }] }),
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        subscribeResource: async () => {},
        unsubscribeResource: async () => {},
        listPrompts: async () => ({ prompts: [] }),
        getPrompt: async () => ({ messages: [] }),
      } as unknown as McpConnection;
    },
    onEvent: (event) => {
      forwardMcpEventToExternalRouter(event, router);
    },
  });
  registry.attachManager(manager);
  manager.start();

  const app = express();
  app.use(express.json());
  app.use('/api', createArtifactEventsRouter(createExternalEventArtifactSink(router), registry));

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Invalid URL rejected with 422
    const badRes = await fetch(`${baseUrl}/api/artifacts/canvas-1/mcp/attach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'ftp://invalid.test/mcp' }),
    });
    assert.equal(badRes.status, 422);

    // 2. Attach per-artifact MCP bridge + bind session in one call
    const attachRes = await fetch(`${baseUrl}/api/artifacts/canvas-1/mcp/attach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'http://127.0.0.1:4510/mcp',
        bearerToken: 'secret-token',
        sessionKey: 'sess-canvas-1',
        topic: 'p2p_88_99',
      }),
    });
    assert.equal(attachRes.status, 200);
    const attachJson = await attachRes.json() as any;
    const expectedServerId = artifactServerId('canvas-1');
    assert.notEqual(artifactServerId('a.b'), artifactServerId('a-b'));
    assert.equal(attachJson.ok, true);
    assert.equal(attachJson.serverId, expectedServerId);
    assert.equal(attachJson.sessionBound, true);

    await manager.waitForInitialConnect();
    await manager.refreshServerTools(expectedServerId);
    assert.equal(registeredTools.has(mcpToolName(expectedServerId, 'canvas_get_snapshot')), true);
    assert.equal(registeredTools.has(mcpToolName(expectedServerId, 'canvas_patch')), true);

    // 3. List bridges hides bearerToken
    const listRes = await fetch(`${baseUrl}/api/artifacts/mcp/bridges`);
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json() as any;
    assert.equal(listJson.bridges.length, 1);
    assert.equal(listJson.bridges[0].hasBearerToken, true);
    assert.equal('bearerToken' in listJson.bridges[0], false);

    // 4. Artifact MCP notification wakes bound session
    capturedHooks?.onNotification?.({
      method: 'notifications/artifact/a2ui',
      params: {
        artifactId: 'canvas-1',
        eventId: 'evt-canvas-1',
        actionName: 'auto_arrange',
      },
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].sessionKey, 'sess-canvas-1');
    assert.equal(dispatches[0].topic, 'p2p_88_99');

    // 5. Detach unregisters tools and closes connection
    const detachRes = await fetch(`${baseUrl}/api/artifacts/canvas-1/mcp/attach?unbind=1`, {
      method: 'DELETE',
    });
    assert.equal(detachRes.status, 200);
    const detachJson = await detachRes.json() as any;
    assert.equal(detachJson.existed, true);
    assert.equal(detachJson.sessionUnbound, true);
    assert.equal(closed, true);
    assert.equal(registeredTools.has(mcpToolName(expectedServerId, 'canvas_patch')), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.closeAll();
    registry.reset();
    router.reset();
  }
}

async function testReviewProbesP1ToP4(): Promise<void> {
  // P1: 3 coalesced annotations in one debounce window → 1 dispatch containing FIRST, SECOND, THIRD
  {
    const router = new ExternalEventRouter({
      aggregationPolicies: {
        'artifact:annotation': { windowMs: 30, maxWaitMs: 120 },
      },
    });
    const dispatches: ExternalEventDispatch[] = [];
    router.subscribe((d) => dispatches.push(d));
    const sink = createExternalEventArtifactSink(router);
    await sink.bindArtifactSession({
      artifactId: 'doc-p1',
      sessionKey: 'sess-p1',
      topic: 'p2p_p1',
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createArtifactEventsRouter(sink));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const note of ['FIRST note', 'SECOND note', 'THIRD note']) {
        const res = await fetch(`${baseUrl}/api/artifacts/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: 'annotation_create',
            artifactId: 'doc-p1',
            comment: note,
            quote: note,
          }),
        });
        assert.equal(res.status, 202);
      }
      await new Promise((r) => setTimeout(r, 90));
      assert.equal(dispatches.length, 1);
      assert.equal(dispatches[0].text.includes('FIRST note'), true);
      assert.equal(dispatches[0].text.includes('SECOND note'), true);
      assert.equal(dispatches[0].text.includes('THIRD note'), true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      router.reset();
    }
  }

  // P2: Retried clientEventId → 1 dispatch, second response reports deduplicated=true
  // P3: Unbound artifact → accepted=false, deduplicated=false; retry after bind succeeds
  {
    const router = new ExternalEventRouter();
    const dispatches: ExternalEventDispatch[] = [];
    router.subscribe((d) => dispatches.push(d));
    const sink = createExternalEventArtifactSink(router);

    const app = express();
    app.use(express.json());
    app.use('/api', createArtifactEventsRouter(sink));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      // P3: Unbound first
      const unboundRes = await fetch(`${baseUrl}/api/artifacts/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'a2ui_action',
          artifactId: 'art-p23',
          componentId: 'btn-refresh',
          clientEventId: 'idem-001',
          actionName: 'refresh',
        }),
      });
      assert.equal(unboundRes.status, 202);
      const unboundJson = await unboundRes.json() as any;
      assert.equal(unboundJson.results[0].accepted, false);
      assert.equal(unboundJson.results[0].deduplicated, false);
      assert.equal(dispatches.length, 0);

      // Now bind and retry the SAME clientEventId → must succeed!
      await sink.bindArtifactSession({
        artifactId: 'art-p23',
        sessionKey: 'sess-p23',
        topic: 'p2p_p23',
      });
      const firstRes = await fetch(`${baseUrl}/api/artifacts/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'a2ui_action',
          artifactId: 'art-p23',
          componentId: 'btn-refresh',
          clientEventId: 'idem-001',
          actionName: 'refresh',
        }),
      });
      const firstJson = await firstRes.json() as any;
      assert.equal(firstJson.results[0].accepted, true);
      assert.equal(firstJson.results[0].deduplicated, false);

      // P2: Retry same clientEventId → deduplicated=true, still only 1 dispatch
      const dupRes = await fetch(`${baseUrl}/api/artifacts/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'a2ui_action',
          artifactId: 'art-p23',
          componentId: 'btn-refresh',
          clientEventId: 'idem-001',
          actionName: 'refresh',
        }),
      });
      const dupJson = await dupRes.json() as any;
      assert.equal(dupJson.results[0].accepted, false);
      assert.equal(dupJson.results[0].deduplicated, true);
      await new Promise((r) => setImmediate(r));
      assert.equal(dispatches.length, 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      router.reset();
    }
  }

  // P4: 3x notifications/resources/updated for the same URI (no explicit id)
  // (a) Without debounce: all 3 dispatch (not dropped for 24h)
  {
    const router = new ExternalEventRouter({ aggregationPolicies: {} });
    const dispatches: ExternalEventDispatch[] = [];
    router.subscribe((d) => dispatches.push(d));
    router.bindArtifact('art-res', { sessionKey: 'sess-res', topic: 'p2p_res' });

    for (let i = 0; i < 3; i += 1) {
      const adapted = adaptMcpNotification('canvas-srv', {
        method: 'notifications/resources/updated',
        params: { uri: 'canvas://art-res/layout' },
      });
      assert.equal(adapted.hasExplicitEventId, false);
      assert.equal(adapted.artifactId, undefined, 'uri must not fall back to artifactId');
      forwardMcpEventToExternalRouter(adapted, router, { boundArtifactId: 'art-res' });
    }
    await new Promise((r) => setImmediate(r));
    assert.equal(dispatches.length, 3);
    router.reset();
  }

  // (b) With mcp:* prefix throttling policy: burst of 3 updates coalesces into 1 dispatch with 3 items
  {
    const router = new ExternalEventRouter({
      aggregationPolicies: {
        'mcp:*': { windowMs: 40, maxWaitMs: 200 },
      },
    });
    const dispatches: ExternalEventDispatch[] = [];
    router.subscribe((d) => dispatches.push(d));
    router.bindArtifact('art-res', { sessionKey: 'sess-res', topic: 'p2p_res' });

    for (let i = 0; i < 3; i += 1) {
      const adapted = adaptMcpNotification('canvas-srv', {
        method: 'notifications/resources/updated',
        params: { uri: 'canvas://art-res/layout', seq: i + 1 },
      });
      forwardMcpEventToExternalRouter(adapted, router, { boundArtifactId: 'art-res' });
    }
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(dispatches.length, 1, 'burst of resources/updated should be throttled via mcp:* prefix policy');
    assert.equal((dispatches[0].event.payload as any)?.items?.length, 3);
    router.reset();
  }
}

async function testCrossProcessConnectorEventBridge(): Promise<void> {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-bridge-test-'));
  const router = new ExternalEventRouter();
  const dispatches: ExternalEventDispatch[] = [];
  router.subscribe((d) => dispatches.push(d));
  const registry = new ArtifactMcpRegistry(router);

  const bridge = await startConnectorEventBridge({
    runtimeRoot,
    sink: createExternalEventArtifactSink(router),
    bridgeSink: registry,
  });

  const dashboardApp = express();
  dashboardApp.use(express.json());
  dashboardApp.use(
    '/api',
    createArtifactEventsRouter(
      createForwardingArtifactEventSink(runtimeRoot),
      createForwardingArtifactMcpBridgeSink(runtimeRoot),
      { allowMcpAttach: true },
    ),
  );
  const dashboardServer = await new Promise<ReturnType<typeof dashboardApp.listen>>((resolve) => {
    const s = dashboardApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(dashboardServer.address() as AddressInfo).port}`;

  try {
    // Bind through Dashboard → forwarded to Connector
    const bindRes = await fetch(`${baseUrl}/api/artifacts/cross-1/bind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionKey: 'sess-cross-1', topic: 'p2p_cross_1' }),
    });
    assert.equal(bindRes.status, 200);

    // Emit event through Dashboard → forwarded to Connector → wakes Connector's ExternalEventRouter
    const evtRes = await fetch(`${baseUrl}/api/artifacts/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'a2ui_action',
        artifactId: 'cross-1',
        componentId: 'btn-relayout',
        clientEventId: 'cross-evt-1',
        actionName: 'relayout',
      }),
    });
    assert.equal(evtRes.status, 202);
    const evtJson = await evtRes.json() as any;
    assert.equal(evtJson.accepted, 1);
    await new Promise((r) => setImmediate(r));
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].sessionKey, 'sess-cross-1');

    // Attach + list + detach MCP bridge through Dashboard → forwarded to Connector
    const attachRes = await fetch(`${baseUrl}/api/artifacts/cross-1/mcp/attach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:4999/mcp' }),
    });
    assert.equal(attachRes.status, 200);

    const listRes = await fetch(`${baseUrl}/api/artifacts/mcp/bridges`);
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json() as any;
    assert.equal(listJson.bridges.length, 1);
    assert.equal(listJson.bridges[0].artifactId, 'cross-1');

    const detachRes = await fetch(`${baseUrl}/api/artifacts/cross-1/mcp/attach`, { method: 'DELETE' });
    assert.equal(detachRes.status, 200);

    // Stop connector bridge → Dashboard returns 503 connector_unavailable
    await bridge.stop();
    const downRes = await fetch(`${baseUrl}/api/artifacts/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'a2ui_action',
        artifactId: 'cross-1',
        componentId: 'btn-after-stop',
        actionName: 'after_stop',
      }),
    });
    assert.equal(downRes.status, 503);
    assert.equal((await downRes.json() as any).code, 'connector_unavailable');
  } finally {
    await bridge.stop().catch(() => {});
    await new Promise<void>((resolve) => dashboardServer.close(() => resolve()));
    registry.reset();
    router.reset();
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

async function testSecurityAndHardening(): Promise<void> {
  // 1. Per-artifact bridge cannot target another session/artifact via spoofed sessionKey/topic
  const router = new ExternalEventRouter({ aggregationPolicies: {} });
  const dispatches: ExternalEventDispatch[] = [];
  router.subscribe((d) => dispatches.push(d));
  router.bindArtifact('art-mine', { sessionKey: 'sess-mine', topic: 'p2p_mine' });

  const spoofed = adaptMcpNotification('art_mine_000000', {
    method: 'notifications/artifact/a2ui',
    params: {
      event_id: 'spoof-1',
      sessionKey: 'sess-victim',
      topic: 'group_victim',
      artifactId: 'art-other',
    },
  });
  forwardMcpEventToExternalRouter(spoofed, router, { boundArtifactId: 'art-mine' });
  await new Promise((r) => setImmediate(r));
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].sessionKey, 'sess-mine');
  assert.equal(dispatches[0].topic, 'p2p_mine');
  assert.equal(dispatches[0].artifactId, 'art-mine');

  // 2. Non-loopback URL rejected by ArtifactMcpRegistry by default
  const registry = new ArtifactMcpRegistry(router);
  assert.throws(
    () => registry.registerArtifactBridge({ artifactId: 'art-remote', url: 'https://evil.example.com/mcp' }),
    (err: any) => err?.code === 'remote_mcp_url_forbidden' && err?.status === 403,
  );

  // 3. mcpToolName enforces <= 64 chars with deterministic hash suffix
  const longName = mcpToolName('very_long_server_identifier', 'super_long_remote_tool_name_that_exceeds_sixty_four_characters_limit');
  assert.ok(longName.length <= 64, `expected <= 64 chars, got ${longName.length}: ${longName}`);
  assert.equal(
    longName,
    mcpToolName('very_long_server_identifier', 'super_long_remote_tool_name_that_exceeds_sixty_four_characters_limit'),
  );

  // 4. Legacy SSE transport is accepted as a first-class transport (v2: SSEClientTransport support)
  const sseCfg = validateServerConfig('legacy', { transport: 'sse', url: 'https://example.test/sse' });
  assert.equal(sseCfg.transport, 'sse');

  // 5. Failed connection attempt is closed before retry, and lastSessionId is passed on reconnect
  let closedFailedCount = 0;
  let seenSessionIds: Array<string | undefined> = [];
  let attempt = 0;
  const client = new McpPersistentClient({
    serverId: 'retry-test',
    config: { transport: 'streamable-http', url: 'http://127.0.0.1:4998/mcp' },
    reconnect: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2, jitter: 0 },
    sleep: async () => {},
    createConnection: (_cfg, hooks): McpConnection => {
      attempt += 1;
      seenSessionIds.push(hooks.sessionId);
      const currentAttempt = attempt;
      const conn: McpConnection & { ready?: Promise<void> } = {
        ready: currentAttempt === 1
          ? (async () => {
              hooks.onSessionId?.('mcp-sess-abc');
              throw new Error('boom on first connect');
            })()
          : Promise.resolve(),
        close: async () => {
          if (currentAttempt === 1) closedFailedCount += 1;
        },
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ isError: false, content: [] }),
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        subscribeResource: async () => {},
        unsubscribeResource: async () => {},
        listPrompts: async () => ({ prompts: [] }),
        getPrompt: async () => ({ messages: [] }),
      };
      return conn;
    },
  });
  await client.connect();
  assert.equal(closedFailedCount, 1);
  assert.deepEqual(seenSessionIds, [undefined, 'mcp-sess-abc']);
  await client.close();

  // 6. Tool name collision disambiguation: cross-server ('a_b','c') vs ('a','b_c') and intra-server foo.bar vs foo_bar
  {
    const tools = new Map<string, Tool>();
    const manager = new McpClientManager({
      toolManager: {
        registerTool: (tool) => tools.set(tool.definition.name, tool),
        unregisterTool: (name) => tools.delete(name),
      },
      createConnection: (cfg): McpConnection => {
        const url = cfg.transport === 'streamable-http' ? cfg.url : '';
        const list = url.includes('srv1')
          ? [{ name: 'c' }, { name: 'foo.bar' }, { name: 'foo_bar' }]
          : [{ name: 'b_c' }];
        return {
          close: async () => {},
          listTools: async () => ({ tools: list }),
          callTool: async (params) => ({ isError: false, content: [{ type: 'text', text: `${url}:${params.name}` }] }),
          listResources: async () => ({ resources: [] }),
          readResource: async () => ({ contents: [] }),
          subscribeResource: async () => {},
          unsubscribeResource: async () => {},
          listPrompts: async () => ({ prompts: [] }),
          getPrompt: async () => ({ messages: [] }),
        };
      },
    });
    manager.addServer('a_b', { transport: 'streamable-http', url: 'http://127.0.0.1:4991/srv1' });
    manager.addServer('a', { transport: 'streamable-http', url: 'http://127.0.0.1:4992/srv2' });
    manager.start();
    await manager.waitForInitialConnect();
    await manager.refreshServerTools('a_b');
    await manager.refreshServerTools('a');
    // 元工具（mcp_list_resources 等 6 个）随 server 上线自动注册，不属于远端工具面，统计时排除。
    const META_TOOL_NAMES = new Set([
      'mcp_list_resources', 'mcp_read_resource', 'mcp_subscribe_resource',
      'mcp_list_prompts', 'mcp_get_prompt', 'mcp_complete',
    ]);
    const remoteToolNames = [...tools.keys()].filter((name) => !META_TOOL_NAMES.has(name));
    assert.equal(remoteToolNames.length, 4, `expected 4 distinct tools without silent overwrite, got: ${[...tools.keys()].join(', ')}`);
    for (const name of remoteToolNames) {
      assert.ok(name.length <= 64, `tool name exceeds 64 chars: ${name}`);
    }
    await manager.closeAll();
  }

  // 7. Auth gating covers /events, /bind, /mcp/bridges, /mcp/attach, DELETE /mcp/attach, POST /mcp/detach
  {
    const sink = createExternalEventArtifactSink(router);
    const app = express();
    app.use(express.json());
    app.use('/api', createArtifactEventsRouter(sink, registry, { allowArtifactEvents: false, allowMcpAttach: false }));
    const srv = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const checks: Array<[string, string, unknown?]> = [
        ['POST', '/api/artifacts/events', { kind: 'a2ui_action', artifactId: 'a1', componentId: 'b1' }],
        ['POST', '/api/artifacts/a1/bind', { sessionKey: 's1' }],
        ['GET', '/api/artifacts/mcp/bridges'],
        ['POST', '/api/artifacts/a1/mcp/attach', { url: 'http://127.0.0.1:4999/mcp' }],
        ['DELETE', '/api/artifacts/a1/mcp/attach'],
        ['POST', '/api/artifacts/a1/mcp/detach'],
      ];
      for (const [method, endpoint, body] of checks) {
        const res = await fetch(`${baseUrl}${endpoint}`, {
          method,
          ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
        });
        assert.equal(res.status, 403, `expected 403 for ${method} ${endpoint}, got ${res.status}`);
      }
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  }

  // 8. Multi-session external events do not block behind another session's slow model turn
  {
    const fastRouter = new ExternalEventRouter({ aggregationPolicies: {} });
    const startedAt: Record<string, number> = {};
    const t0 = Date.now();
    const pendingTurns: Promise<void>[] = [];
    fastRouter.subscribe((dispatch) => {
      // Mirrors CatsCompanyBot: enqueue synchronously, kick off drain without awaiting in subscriber
      startedAt[dispatch.sessionKey] = Date.now() - t0;
      const turnMs = dispatch.sessionKey === 'sess-slow-A' ? 200 : 10;
      pendingTurns.push(new Promise((resolve) => setTimeout(resolve, turnMs)));
    });
    fastRouter.emit({
      eventId: 'ev-A',
      source: 'artifact:a2ui',
      type: 'a2ui_action',
      target: { sessionKey: 'sess-slow-A' },
      priority: 'immediate',
    });
    fastRouter.emit({
      eventId: 'ev-B',
      source: 'artifact:a2ui',
      type: 'a2ui_action',
      target: { sessionKey: 'sess-fast-B' },
      priority: 'immediate',
    });
    const receiptStart = Date.now();
    await fastRouter.emitAndWait({
      eventId: 'ev-C',
      source: 'catsco:receipt',
      type: 'service_run_receipt',
      target: { sessionKey: 'sess-receipt-C' },
      priority: 'immediate',
    });
    const receiptElapsed = Date.now() - receiptStart;
    assert.ok(startedAt['sess-fast-B'] < 100, `session B waited behind A's turn: ${startedAt['sess-fast-B']}ms`);
    assert.ok(startedAt['sess-receipt-C'] < 100, `session C waited behind A's turn: ${startedAt['sess-receipt-C']}ms`);
    assert.ok(receiptElapsed < 100, `emitAndWait for C waited behind A's turn: ${receiptElapsed}ms`);
    await Promise.all(pendingTurns);
    fastRouter.reset();
  }

  // 9. Default mcp:* debounce isolates different MCP servers targeting the same session
  {
    const mcpRouter = new ExternalEventRouter();
    const mcpDispatches: ExternalEventDispatch[] = [];
    mcpRouter.subscribe((d) => { mcpDispatches.push(d); });
    mcpRouter.emit({
      eventId: 'm-1',
      source: 'mcp:srv-alpha',
      type: 'mcp.resources.updated',
      target: { sessionKey: 'sess-shared' },
      payload: { uri: 'doc://1' },
    });
    mcpRouter.emit({
      eventId: 'm-2',
      source: 'mcp:srv-beta',
      type: 'mcp.resources.updated',
      target: { sessionKey: 'sess-shared' },
      payload: { uri: 'doc://2' },
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await mcpRouter.emitAndWait({
      eventId: 'm-flush',
      source: 'catsco:receipt',
      type: 'service_run_receipt',
      target: { sessionKey: 'sess-other' },
      priority: 'immediate',
    });
    const shared = mcpDispatches.filter((d) => d.sessionKey === 'sess-shared');
    assert.equal(shared.length, 2, `expected 2 separate server dispatches, got ${shared.length}`);
    assert.deepEqual(shared.map((d) => d.event.source).sort(), ['mcp:srv-alpha', 'mcp:srv-beta']);
    mcpRouter.reset();
  }

  router.reset();
}

async function testInEpisodeToolHotReload(): Promise<void> {
  const dynamicTools = new Map<string, ToolDefinition>([
    [
      'attach_mcp_bridge',
      {
        name: 'attach_mcp_bridge',
        description: 'Attach a new MCP tool mid-episode',
        parameters: { type: 'object', properties: {} },
      },
    ],
  ]);

  const toolExecutor: ToolExecutor = {
    getToolDefinitions: () => Array.from(dynamicTools.values()),
    executeTool: async (toolCall: ToolCall): Promise<ToolResult> => {
      if (toolCall.function.name === 'attach_mcp_bridge') {
        // Simulate MCP tool hot-registration mid-episode
        dynamicTools.set('mcp_art_live_relayout', {
          name: 'mcp_art_live_relayout',
          description: 'Hot-loaded A2UI relayout tool',
          parameters: { type: 'object', properties: {} },
        });
        return {
          tool_call_id: toolCall.id,
          role: 'tool',
          name: toolCall.function.name,
          content: 'attached',
          ok: true,
        };
      }
      if (toolCall.function.name === 'mcp_art_live_relayout') {
        return {
          tool_call_id: toolCall.id,
          role: 'tool',
          name: toolCall.function.name,
          content: 'relayout_done',
          ok: true,
        };
      }
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name: toolCall.function.name,
        content: 'unknown',
        ok: false,
      };
    },
  };

  const seenToolsPerTurn: string[][] = [];
  let callIndex = 0;
  const handleChat = async (_messages: any[], tools: ToolDefinition[]) => {
    callIndex += 1;
    seenToolsPerTurn.push(tools.map((t) => t.name).sort());
    if (callIndex === 1) {
      return {
        content: '',
        toolCalls: [
          { id: 'tc-1', type: 'function', function: { name: 'attach_mcp_bridge', arguments: '{}' } },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    }
    if (callIndex === 2) {
      return {
        content: '',
        toolCalls: [
          { id: 'tc-2', type: 'function', function: { name: 'mcp_art_live_relayout', arguments: '{}' } },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    }
    return {
      content: 'all done',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  };
  const fakeAiService: any = {
    getConfig: () => ({}),
    isToolCallingSupported: () => true,
    chat: handleChat,
    chatStream: handleChat,
  };

  const runner = new ConversationRunner(fakeAiService, toolExecutor, {
    maxTurns: 5,
  });
  const result = await runner.run([{ role: 'user', content: 'attach and relayout' }]);
  assert.equal(result.response, 'all done');
  assert.equal(seenToolsPerTurn.length, 3);
  assert.deepEqual(seenToolsPerTurn[0], ['attach_mcp_bridge']);
  assert.deepEqual(seenToolsPerTurn[1], ['attach_mcp_bridge', 'mcp_art_live_relayout']);
  assert.deepEqual(seenToolsPerTurn[2], ['attach_mcp_bridge', 'mcp_art_live_relayout']);
}

async function main(): Promise<void> {
  await testMcpNotificationEndToEnd();
  await testArtifactHttpRoutesEndToEnd();
  await testPerArtifactDynamicMcpBridge();
  await testReviewProbesP1ToP4();
  await testCrossProcessConnectorEventBridge();
  await testSecurityAndHardening();
  await testInEpisodeToolHotReload();
  console.log('mcp-event-bus-integration.test.ts: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
