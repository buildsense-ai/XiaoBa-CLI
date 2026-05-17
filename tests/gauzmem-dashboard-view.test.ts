import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildGauzMemDashboardView } from '../src/dashboard/gauzmem-view';

test('GauzMem dashboard view summarizes graph, replay, and metabolism without leaking absolute paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-gauzmem-dashboard-view-'));
  try {
    const storeRoot = path.join(root, 'modules', 'gauzmem', '.gauzmem-zero');
    const logPath = path.join(root, 'logs', 'sessions', 'chat', '2026-05-12', 'session.jsonl');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, '{}\n', 'utf8');
    seedStore(storeRoot, logPath);

    const view = buildGauzMemDashboardView({
      storeRoot,
      projectRoot: root,
      maxGraphNodes: 20,
      maxGraphEdges: 20,
    });

    assert.equal(view.ok, true);
    assert.equal(view.store.root, 'modules/gauzmem/.gauzmem-zero');
    assert.equal(view.summary.nodeCount, 3);
    assert.equal(view.summary.edgeCount, 2);
    assert.equal(view.summary.runCount, 2);
    assert.equal(view.summary.turnCount, 1);
    assert.equal(view.summary.retiredNodeCount >= 1, true);
    assert.equal(view.sessions.length, 1);
    assert.equal(view.sessions[0].key, 'chat/session-a');
    assert.equal(view.sessions[0].turns[0].runs.length, 2);
    assert.match(view.sessions[0].turns[0].query, /语言偏好/);
    const toolRun = view.sessions[0].turns[0].runs.find((run: any) => run.runId === 'r_code');
    assert.equal(toolRun.stats.retrieveAlgorithm, 'frontier_loop_v0.2');
    assert.equal(toolRun.stats.graphFrontierSteps, 2);
    assert.equal(toolRun.bundle.nodeCount >= 1, true);
    assert.equal(toolRun.bundle.edgeCount, 1);
    assert.equal(toolRun.path.disclosedEdges.length, 1);
    assert.equal(toolRun.construct.createdEdges.length, 1);
    assert.equal(toolRun.weightChanges.some((item: any) => item.kind === 'node' && item.delta === '+0.12'), true);
    assert.equal(toolRun.searchTrace[0].phase, 'source_construct');
    assert.equal(toolRun.searchTrace[0].constructReason, 'graph_no_unvisited_edge');
    assert.equal(view.graph.nodes.some((node: any) => node.id === 'n_python'), true);
    assert.equal(view.graph.edges.some((edge: any) => edge.id === 'e_lang' && edge.whyRelevant.includes('Python 优先')), true);
    assert.equal(view.metabolism.rows.some((row: any) => row.date === '2026-05-13' && row.fadedNodes >= 1), true);

    const serialized = JSON.stringify(view);
    assert.equal(serialized.includes(root), false);
    assert.match(serialized, /logs\/sessions\/chat\/2026-05-12\/session\.jsonl/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('GauzMem dashboard view handles a missing store as an empty dashboard', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-gauzmem-dashboard-empty-'));
  try {
    const view = buildGauzMemDashboardView({
      storeRoot: path.join(root, 'missing-store'),
      projectRoot: root,
    });

    assert.equal(view.ok, true);
    assert.equal(view.store.exists, false);
    assert.equal(view.summary.nodeCount, 0);
    assert.equal(view.summary.edgeCount, 0);
    assert.deepEqual(view.sessions, []);
    assert.deepEqual(view.graph.nodes, []);
    assert.deepEqual(view.metabolism.rows, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function seedStore(storeRoot: string, logPath: string): void {
  fs.mkdirSync(storeRoot, { recursive: true });
  writeJsonl(path.join(storeRoot, 'nodes.jsonl'), [
    {
      schemaVersion: 1,
      id: 'n_c',
      text: '一年前用户说自己喜欢 C。',
      sourceRef: { kind: 'conversation', role: 'user', sessionType: 'chat', sessionId: 'session-a', logPath, jsonlLine: 1 },
      createdAt: '2026-05-12T02:00:00.000Z',
    },
    {
      schemaVersion: 1,
      id: 'n_python',
      text: '最近用户说自己现在更喜欢 Python。',
      sourceRef: { kind: 'conversation', role: 'user', sessionType: 'chat', sessionId: 'session-a', logPath, jsonlLine: 2 },
      createdAt: '2026-05-12T02:10:00.000Z',
    },
    {
      schemaVersion: 1,
      id: 'n_code',
      text: '项目里已经有 TaskRegistry 模块。',
      sourceRef: { kind: 'conversation', role: 'tool', sessionType: 'chat', sessionId: 'session-a', logPath, jsonlLine: 3 },
      createdAt: '2026-05-13T04:10:00.000Z',
    },
  ]);
  writeJsonl(path.join(storeRoot, 'edges.jsonl'), [
    {
      schemaVersion: 1,
      id: 'e_lang',
      from: 'n_c',
      to: 'n_python',
      mode: 'localAssociation',
      whyRelevant: '用户语言偏好更新，Python 优先。',
      createdAt: '2026-05-12T02:12:00.000Z',
    },
    {
      schemaVersion: 1,
      id: 'e_code',
      from: 'n_python',
      to: 'n_code',
      mode: 'localAssociation',
      whyRelevant: '实现功能前要联想到已有模块，避免重复造轮子。',
      createdAt: '2026-05-13T04:12:00.000Z',
    },
  ]);
  writeJsonl(path.join(storeRoot, 'node_state.jsonl'), [
    { schemaVersion: 1, nodeId: 'n_c', tick: 1, weight: 0.7, selectedCount: 1, createdTick: 1, lastTouchedTick: 1, visibility: 'active', reason: 'selected' },
    { schemaVersion: 1, nodeId: 'n_python', tick: 1, weight: 0.9, selectedCount: 2, createdTick: 1, lastTouchedTick: 2, visibility: 'active', reason: 'selected' },
    { schemaVersion: 1, nodeId: 'n_code', tick: 2, weight: 0.05, selectedCount: 0, createdTick: 2, lastTouchedTick: 2, visibility: 'faint', reason: 'root_relevance_rejected' },
  ]);
  writeJsonl(path.join(storeRoot, 'edge_state.jsonl'), [
    { schemaVersion: 1, edgeId: 'e_lang', tick: 1, weight: 0.8, selectedCount: 1, createdTick: 1, lastTouchedTick: 1, visibility: 'active', reason: 'selected' },
    { schemaVersion: 1, edgeId: 'e_code', tick: 2, weight: 0.3, selectedCount: 0, createdTick: 2, lastTouchedTick: 2, visibility: 'active', reason: 'created' },
  ]);
  writeJsonl(path.join(storeRoot, 'runs.jsonl'), [
    {
      runId: 'r_lang',
      query: '用户语言偏好',
      timestamp: '2026-05-12T02:12:00.000Z',
      callType: 'passive',
      retrieveMode: 'source_construct',
      evidenceIds: ['n_c', 'n_python'],
      selectedNodeIds: ['n_c', 'n_python'],
      selectedEdgeIds: ['e_lang'],
      createdEdgeIds: ['e_lang'],
      returnedEdgeIds: ['e_lang'],
      disclosedNodeIds: ['n_c', 'n_python'],
      disclosedEdgeIds: ['e_lang'],
      stats: { energyInitial: 32, energyRemaining: 11, graphSeedCount: 0, constructedNodeCount: 2, constructedEdgeCount: 1 },
      searchPlan: { termGroups: [{ term: '语言偏好' }] },
    },
    {
      runId: 'r_code',
      query: 'TaskRegistry 是否已有',
      timestamp: '2026-05-13T04:12:00.000Z',
      callType: 'tool_search',
      retrieveMode: 'graph_then_construct',
      evidenceIds: ['n_code'],
      selectedNodeIds: ['n_code'],
      selectedEdgeIds: [],
      createdEdgeIds: ['e_code'],
      returnedEdgeIds: ['e_code'],
      disclosedNodeIds: ['n_python', 'n_code'],
      disclosedEdgeIds: ['e_code'],
      stats: {
        energyInitial: 48,
        energyRemaining: 18,
        graphSeedCount: 1,
        constructedNodeCount: 1,
        constructedEdgeCount: 1,
        retrieveAlgorithm: 'frontier_loop_v0.2',
        frontierSteps: 4,
        graphFrontierSteps: 2,
        sourceConstructCount: 1,
        nodeConstructCount: 1,
        rootConstructCount: 0,
        constructAttemptCount: 1,
        graphDisclosureCount: 2,
        finalGraphWasSufficient: true,
      },
      searchPlan: { termGroups: [{ term: 'TaskRegistry' }] },
      searchTrace: [{
        termId: 'n_python:term_1',
        pattern: 'TaskRegistry',
        phase: 'source_construct',
        parentNodeId: 'n_python',
        parent: 'node',
        constructReason: 'graph_no_unvisited_edge',
        hitCount: 2,
        evidenceCount: 1,
      }],
    },
  ]);
  writeJsonl(path.join(storeRoot, 'events.jsonl'), [
    { eventId: 'ev1', targetType: 'node', targetId: 'n_c', eventType: 'created', runId: 'r_lang', timestamp: '2026-05-12T02:12:00.000Z' },
    { eventId: 'ev2', targetType: 'node', targetId: 'n_python', eventType: 'selected', runId: 'r_lang', timestamp: '2026-05-12T02:12:00.000Z' },
    { eventId: 'ev3', targetType: 'edge', targetId: 'e_lang', eventType: 'created', runId: 'r_lang', timestamp: '2026-05-12T02:12:00.000Z' },
    { eventId: 'ev4', targetType: 'edge', targetId: 'e_lang', eventType: 'selected', runId: 'r_lang', timestamp: '2026-05-12T02:12:00.000Z' },
    { eventId: 'ev5', targetType: 'node', targetId: 'n_code', eventType: 'root_relevance_rejected', runId: 'r_code', timestamp: '2026-05-13T04:12:00.000Z' },
  ]);
  writeJsonl(path.join(storeRoot, 'turn_metadata.jsonl'), [
    {
      schemaVersion: 1,
      turnId: 'turn-1',
      timestamp: '2026-05-13T04:20:00.000Z',
      agent: 'xiaoba',
      sessionId: 'session-a',
      sessionType: 'chat',
      userTextHash: 'hash-user',
      assistantTextHash: 'hash-assistant',
      gauzmemRunIds: ['r_lang', 'r_code'],
      metadata: { activeRunCount: 1, passive: { runs: [{ runId: 'r_lang' }] }, activeSearches: [{ runId: 'r_code' }] },
    },
  ]);
  writeJsonl(path.join(storeRoot, 'attachments.jsonl'), []);
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}
