import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { ExternalEventRouter, type ExternalEventDispatch } from '../src/events/external-event-router';
import {
  createExternalEventArtifactSink,
  forwardMcpEventToExternalRouter,
} from '../src/events/event-bus-adapters';
import { createArtifactEventsRouter } from '../src/dashboard/routes/artifact-events';
import { McpClientManager } from '../src/mcp/mcp-client-manager';
import type { McpConnection, McpConnectionHooks } from '../src/mcp/mcp-persistent-client';
import type { Tool } from '../src/types/tool';

async function testMcpNotificationEndToEnd(): Promise<void> {
  const router = new ExternalEventRouter();
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

async function main(): Promise<void> {
  await testMcpNotificationEndToEnd();
  await testArtifactHttpRoutesEndToEnd();
  console.log('mcp-event-bus-integration.test.ts: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
