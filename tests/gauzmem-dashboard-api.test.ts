import assert from 'node:assert/strict';
import fs from 'node:fs';
import http, { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';
import express from 'express';
import { createApiRouter } from '../src/dashboard/routes/api';

let server: Server | undefined;
let baseUrl = '';
let root = '';
let originalStoreRoot: string | undefined;

beforeEach(async () => {
  originalStoreRoot = process.env.GAUZMEM_STORE_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-gauzmem-dashboard-api-'));
  const storeRoot = path.join(root, 'store');
  process.env.GAUZMEM_STORE_ROOT = storeRoot;
  seedStore(storeRoot);

  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ getAll: () => [] } as any));
  server = await listen(app);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  if (server) {
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  }
  if (originalStoreRoot === undefined) delete process.env.GAUZMEM_STORE_ROOT;
  else process.env.GAUZMEM_STORE_ROOT = originalStoreRoot;
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test('GET /api/gauzmem/dashboard returns summary, sessions, graph, and metabolism', async () => {
  const response = await fetch(`${baseUrl}/api/gauzmem/dashboard?maxGraphNodes=10&maxGraphEdges=10`);
  const data = await response.json() as any;

  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.summary.nodeCount, 1);
  assert.equal(data.summary.edgeCount, 0);
  assert.equal(data.sessions[0].key, 'chat/api-session');
  assert.equal(data.graph.nodes[0].id, 'api-node');
  assert.equal(data.metabolism.rows[0].runs, 1);
});

test('split GauzMem dashboard APIs return scoped payloads', async () => {
  const summary = await (await fetch(`${baseUrl}/api/gauzmem/summary`)).json() as any;
  const sessions = await (await fetch(`${baseUrl}/api/gauzmem/sessions`)).json() as any;
  const graph = await (await fetch(`${baseUrl}/api/gauzmem/graph`)).json() as any;

  assert.equal(summary.ok, true);
  assert.equal(summary.summary.runCount, 1);
  assert.equal(summary.sessions, undefined);
  assert.equal(sessions.sessions.length, 1);
  assert.equal(sessions.graph, undefined);
  assert.equal(graph.graph.nodes.length, 1);
  assert.equal(graph.sessions, undefined);
});

function listen(app: express.Express): Promise<Server> {
  return new Promise(resolve => {
    const next = http.createServer(app);
    next.listen(0, '127.0.0.1', () => resolve(next));
  });
}

function seedStore(storeRoot: string): void {
  writeJsonl(path.join(storeRoot, 'nodes.jsonl'), [{
    id: 'api-node',
    text: 'API dashboard evidence',
    sourceRef: { kind: 'conversation', role: 'user', sessionType: 'chat', sessionId: 'api-session' },
    createdAt: '2026-05-13T01:00:00.000Z',
  }]);
  writeJsonl(path.join(storeRoot, 'edges.jsonl'), []);
  writeJsonl(path.join(storeRoot, 'node_state.jsonl'), [{
    nodeId: 'api-node',
    tick: 1,
    weight: 0.7,
    selectedCount: 1,
    createdTick: 1,
    lastTouchedTick: 1,
    visibility: 'active',
  }]);
  writeJsonl(path.join(storeRoot, 'edge_state.jsonl'), []);
  writeJsonl(path.join(storeRoot, 'runs.jsonl'), [{
    runId: 'api-run',
    query: 'API dashboard query',
    timestamp: '2026-05-13T01:00:00.000Z',
    callType: 'passive',
    retrieveMode: 'source_construct',
    evidenceIds: ['api-node'],
    selectedNodeIds: ['api-node'],
    stats: { energyInitial: 32, energyRemaining: 20, graphSeedCount: 0, constructedNodeCount: 1, constructedEdgeCount: 0 },
  }]);
  writeJsonl(path.join(storeRoot, 'events.jsonl'), [{
    eventId: 'api-event',
    targetType: 'node',
    targetId: 'api-node',
    eventType: 'selected',
    runId: 'api-run',
    timestamp: '2026-05-13T01:00:00.000Z',
  }]);
  writeJsonl(path.join(storeRoot, 'turn_metadata.jsonl'), [{
    turnId: 'api-turn',
    timestamp: '2026-05-13T01:01:00.000Z',
    sessionId: 'api-session',
    sessionType: 'chat',
    gauzmemRunIds: ['api-run'],
    metadata: { activeRunCount: 0, passive: { runs: [{ runId: 'api-run' }] } },
  }]);
  writeJsonl(path.join(storeRoot, 'attachments.jsonl'), []);
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}
