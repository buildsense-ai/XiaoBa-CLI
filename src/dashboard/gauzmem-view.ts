import * as fs from 'fs';
import * as path from 'path';
import { resolveGauzMemProjectPath, resolveGauzMemProjectRoot } from '../utils/gauzmem-paths';

type JsonRecord = Record<string, any>;

interface GauzMemDashboardOptions {
  storeRoot?: string;
  projectRoot?: string;
  maxSessions?: number;
  maxTurnsPerSession?: number;
  maxGraphNodes?: number;
  maxGraphEdges?: number;
  maxRecentRuns?: number;
  maxDailyRows?: number;
}

interface LoadedFile {
  path: string;
  exists: boolean;
  bytes: number;
  records: number;
}

interface StoreSnapshot {
  storeRoot: string;
  projectRoot: string;
  exists: boolean;
  files: Record<string, LoadedFile>;
  nodes: JsonRecord[];
  edges: JsonRecord[];
  nodeStates: JsonRecord[];
  edgeStates: JsonRecord[];
  runs: JsonRecord[];
  events: JsonRecord[];
  turnMetadata: JsonRecord[];
  attachments: JsonRecord[];
}

const NODE_RETRIEVAL_THRESHOLD = 0.1;
const EDGE_RETRIEVAL_THRESHOLD = 0.1;

export function resolveGauzMemDashboardStoreRoot(input?: string): string {
  const configured = input || process.env.GAUZMEM_STORE_ROOT;
  if (configured && configured.trim()) return resolveGauzMemProjectPath(configured);
  const moduleRoot = process.env.GAUZMEM_MODULE_ROOT && process.env.GAUZMEM_MODULE_ROOT.trim()
    ? resolveGauzMemProjectPath(process.env.GAUZMEM_MODULE_ROOT)
    : path.join(resolveGauzMemProjectRoot(), 'modules', 'gauzmem');
  return path.join(moduleRoot, '.gauzmem-zero');
}

export function buildGauzMemDashboardView(options: GauzMemDashboardOptions = {}): JsonRecord {
  const snapshot = loadStoreSnapshot(options);
  const currentTick = snapshot.runs.length + 1;
  const tickTimestamp = buildTickTimestamp(snapshot.runs);
  const nodeStateById = latestById(snapshot.nodeStates, 'nodeId');
  const edgeStateById = latestById(snapshot.edgeStates, 'edgeId');
  const nodeEvents = groupEvents(snapshot.events, 'node');
  const edgeEvents = groupEvents(snapshot.events, 'edge');
  const degreeByNode = buildDegreeByNode(snapshot.edges);
  const nodesById = new Map<string, JsonRecord>();
  const edgesById = new Map<string, JsonRecord>();
  const nodes = snapshot.nodes.map(node => {
    const view = toNodeView({
      node,
      state: nodeStateById.get(String(node.id || '')),
      events: nodeEvents.get(String(node.id || '')) || [],
      degree: degreeByNode.get(String(node.id || '')) || 0,
      currentTick,
      tickTimestamp,
      projectRoot: snapshot.projectRoot,
    });
    nodesById.set(view.id, view);
    return view;
  });
  const edges = snapshot.edges.map(edge => {
    const view = toEdgeView({
      edge,
      state: edgeStateById.get(String(edge.id || '')),
      events: edgeEvents.get(String(edge.id || '')) || [],
      currentTick,
      tickTimestamp,
      nodesById,
    });
    edgesById.set(view.id, view);
    return view;
  });
  const sortedNodes = [...nodes].sort((a, b) => {
    return b.effectiveWeight - a.effectiveWeight
      || b.degree - a.degree
      || String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
  const sortedEdges = [...edges].sort((a, b) => {
    return b.effectiveWeight - a.effectiveWeight
      || String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
  const runs = snapshot.runs.map(run => toRunView(run, nodesById, edgesById));
  const sessions = buildSessionReplay({
    turnMetadata: snapshot.turnMetadata,
    runs,
    maxSessions: options.maxSessions || 30,
    maxTurnsPerSession: options.maxTurnsPerSession || 80,
  });
  const metabolism = buildMetabolismTimeline({
    snapshot,
    nodeStateById,
    edgeStateById,
    currentTick,
    tickTimestamp,
    maxRows: options.maxDailyRows || 60,
  });
  const maxGraphNodes = options.maxGraphNodes || 120;
  const maxGraphEdges = options.maxGraphEdges || 180;
  const graphNodeIds = new Set(sortedNodes.slice(0, maxGraphNodes).map(node => node.id));
  const graphEdges = sortedEdges
    .filter(edge => graphNodeIds.has(edge.from) && graphNodeIds.has(edge.to))
    .slice(0, maxGraphEdges);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    store: {
      root: safePathLabel(snapshot.storeRoot, snapshot.projectRoot),
      exists: snapshot.exists,
      files: sanitizeFiles(snapshot.files, snapshot.projectRoot),
    },
    summary: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      runCount: runs.length,
      turnCount: snapshot.turnMetadata.length,
      attachmentCount: snapshot.attachments.length,
      retrievableNodeCount: nodes.filter(node => node.retrievable).length,
      retrievableEdgeCount: edges.filter(edge => edge.retrievable).length,
      activeNodeCount: nodes.filter(node => node.visibility === 'active').length,
      faintNodeCount: nodes.filter(node => node.visibility === 'faint').length,
      dormantNodeCount: nodes.filter(node => node.visibility === 'dormant').length,
      retiredNodeCount: nodes.filter(node => !node.retrievable).length,
      selectedNodeEventCount: snapshot.events.filter(event => event.targetType === 'node' && event.eventType === 'selected').length,
      selectedEdgeEventCount: snapshot.events.filter(event => event.targetType === 'edge' && event.eventType === 'selected').length,
      lastRunAt: latestTimestamp(snapshot.runs),
      lastEventAt: latestTimestamp(snapshot.events),
      recentRuns: runs.slice(-1 * (options.maxRecentRuns || 12)).reverse(),
    },
    sessions,
    graph: {
      totalNodeCount: nodes.length,
      totalEdgeCount: edges.length,
      nodes: sortedNodes.slice(0, maxGraphNodes),
      edges: graphEdges,
      omittedNodeCount: Math.max(0, sortedNodes.length - maxGraphNodes),
      omittedEdgeCount: Math.max(0, sortedEdges.length - graphEdges.length),
    },
    metabolism,
  };
}

function loadStoreSnapshot(options: GauzMemDashboardOptions): StoreSnapshot {
  const projectRoot = options.projectRoot || resolveGauzMemProjectRoot();
  const storeRoot = resolveGauzMemDashboardStoreRoot(options.storeRoot);
  const files = {
    nodes: path.join(storeRoot, 'nodes.jsonl'),
    edges: path.join(storeRoot, 'edges.jsonl'),
    nodeStates: path.join(storeRoot, 'node_state.jsonl'),
    edgeStates: path.join(storeRoot, 'edge_state.jsonl'),
    runs: path.join(storeRoot, 'runs.jsonl'),
    events: path.join(storeRoot, 'events.jsonl'),
    turnMetadata: path.join(storeRoot, 'turn_metadata.jsonl'),
    attachments: path.join(storeRoot, 'attachments.jsonl'),
  };
  const loaded = Object.fromEntries(
    Object.entries(files).map(([key, filePath]) => [key, readJsonlWithInfo(filePath)]),
  ) as Record<string, { info: LoadedFile; records: JsonRecord[] }>;
  return {
    storeRoot,
    projectRoot,
    exists: fs.existsSync(storeRoot),
    files: Object.fromEntries(Object.entries(loaded).map(([key, value]) => [key, value.info])),
    nodes: loaded.nodes.records,
    edges: loaded.edges.records,
    nodeStates: loaded.nodeStates.records,
    edgeStates: loaded.edgeStates.records,
    runs: loaded.runs.records,
    events: loaded.events.records,
    turnMetadata: loaded.turnMetadata.records,
    attachments: loaded.attachments.records,
  };
}

function readJsonlWithInfo(filePath: string): { info: LoadedFile; records: JsonRecord[] } {
  if (!fs.existsSync(filePath)) {
    return { info: { path: filePath, exists: false, bytes: 0, records: 0 }, records: [] };
  }
  const stat = fs.statSync(filePath);
  const records: JsonRecord[] = [];
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) records.push(parsed);
    } catch {
      // The dashboard is read-only. Bad lines are ignored here; GauzMem core owns quarantine.
    }
  }
  return {
    info: { path: filePath, exists: true, bytes: stat.size, records: records.length },
    records,
  };
}

function latestById(items: JsonRecord[], idField: string): Map<string, JsonRecord> {
  const out = new Map<string, JsonRecord>();
  for (const item of items) {
    const id = String(item?.[idField] || '');
    if (!id) continue;
    out.set(id, item);
  }
  return out;
}

function buildTickTimestamp(runs: JsonRecord[]): Map<number, string> {
  const out = new Map<number, string>();
  runs.forEach((run, index) => {
    if (run.timestamp) out.set(index + 1, String(run.timestamp));
  });
  return out;
}

function groupEvents(events: JsonRecord[], targetType: string): Map<string, JsonRecord[]> {
  const out = new Map<string, JsonRecord[]>();
  for (const event of events) {
    if (String(event.targetType || '') !== targetType) continue;
    const id = String(event.targetId || '');
    if (!id) continue;
    const items = out.get(id) || [];
    items.push(event);
    out.set(id, items);
  }
  return out;
}

function buildDegreeByNode(edges: JsonRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const edge of edges) {
    const from = String(edge.from || '');
    const to = String(edge.to || '');
    if (from) out.set(from, (out.get(from) || 0) + 1);
    if (to) out.set(to, (out.get(to) || 0) + 1);
  }
  return out;
}

function toNodeView(input: {
  node: JsonRecord;
  state?: JsonRecord;
  events: JsonRecord[];
  degree: number;
  currentTick: number;
  tickTimestamp: Map<number, string>;
  projectRoot: string;
}): JsonRecord {
  const id = String(input.node.id || '');
  const state = input.state || {};
  const visibility = String(state.visibility || 'active');
  const effective = effectiveWeight(state, input.currentTick);
  const createdAt = input.node.createdAt || input.tickTimestamp.get(Number(state.createdTick || state.tick || 0));
  const selectedCount = Number(state.selectedCount || countEvents(input.events, 'selected'));
  return {
    id,
    text: cleanText(input.node.text || ''),
    preview: previewText(input.node.text || '', 180),
    sourceLabel: formatSourceRef(input.node.sourceRef, input.projectRoot),
    sourceKind: input.node.sourceRef?.kind || 'unknown',
    sourceTrust: input.node.sourceTrust || sourceTrustFor(input.node.sourceRef),
    createdAt,
    createdDate: toDateKey(createdAt),
    degree: input.degree,
    weight: roundNumber(Number(state.weight || 0)),
    effectiveWeight: roundNumber(effective),
    selectedCount,
    visibility,
    retrievable: visibility !== 'dormant' && effective >= NODE_RETRIEVAL_THRESHOLD,
    lastTouchedTick: state.lastTouchedTick,
    stateReason: state.reason,
    eventCounts: countEventTypes(input.events),
  };
}

function toEdgeView(input: {
  edge: JsonRecord;
  state?: JsonRecord;
  events: JsonRecord[];
  currentTick: number;
  tickTimestamp: Map<number, string>;
  nodesById: Map<string, JsonRecord>;
}): JsonRecord {
  const state = input.state || {};
  const visibility = String(state.visibility || 'active');
  const effective = effectiveWeight(state, input.currentTick);
  const createdAt = input.edge.createdAt || input.tickTimestamp.get(Number(state.createdTick || state.tick || 0));
  const from = String(input.edge.from || '');
  const to = String(input.edge.to || '');
  const mode = String(input.edge.mode || 'localAssociation');
  const threshold = mode === 'aliasCandidate' ? 0.15 : EDGE_RETRIEVAL_THRESHOLD;
  return {
    id: String(input.edge.id || ''),
    from,
    to,
    fromPreview: input.nodesById.get(from)?.preview || from,
    toPreview: input.nodesById.get(to)?.preview || to,
    mode,
    direction: input.edge.direction || 'directed',
    whyRelevant: cleanText(input.edge.whyRelevant || ''),
    whyPreview: previewText(input.edge.whyRelevant || '', 180),
    createdAt,
    createdDate: toDateKey(createdAt),
    weight: roundNumber(Number(state.weight || 0)),
    effectiveWeight: roundNumber(effective),
    selectedCount: Number(state.selectedCount || countEvents(input.events, 'selected')),
    visibility,
    retrievable: visibility !== 'dormant' && effective >= threshold,
    lastTouchedTick: state.lastTouchedTick,
    stateReason: state.reason,
    eventCounts: countEventTypes(input.events),
  };
}

function toRunView(run: JsonRecord, nodesById: Map<string, JsonRecord>, edgesById: Map<string, JsonRecord>): JsonRecord {
  const nodeIds = uniqueStrings([
    ...(run.evidenceIds || []),
    ...(run.selectedNodeIds || []),
    ...(run.disclosedNodeIds || []),
  ]);
  const edgeIds = uniqueStrings([
    ...(run.returnedEdgeIds || []),
    ...(run.selectedEdgeIds || []),
    ...(run.createdEdgeIds || []),
    ...(run.disclosedEdgeIds || []),
    ...(run.edgeIds || []),
  ]);
  return {
    runId: String(run.runId || ''),
    query: cleanText(run.query || ''),
    timestamp: run.timestamp,
    date: toDateKey(run.timestamp),
    callType: run.callType || 'passive',
    retrieveMode: run.retrieveMode || 'unknown',
    evidenceIds: uniqueStrings(run.evidenceIds || []),
    selectedNodeIds: uniqueStrings(run.selectedNodeIds || []),
    selectedEdgeIds: uniqueStrings(run.selectedEdgeIds || []),
    createdEdgeIds: uniqueStrings(run.createdEdgeIds || []),
    disclosedNodeIds: uniqueStrings(run.disclosedNodeIds || []),
    disclosedEdgeIds: uniqueStrings(run.disclosedEdgeIds || []),
    nodes: nodeIds.map(id => nodesById.get(id)).filter(Boolean),
    edges: edgeIds.map(id => edgesById.get(id)).filter(Boolean),
    stats: pickStats(run.stats || {}),
    searchTerms: Array.isArray(run.searchPlan?.termGroups)
      ? run.searchPlan.termGroups.map((group: JsonRecord) => group.term).filter(Boolean).slice(0, 12)
      : [],
    searchTrace: sanitizeSearchTrace(run.searchTrace || []),
  };
}

function buildSessionReplay(input: {
  turnMetadata: JsonRecord[];
  runs: JsonRecord[];
  maxSessions: number;
  maxTurnsPerSession: number;
}): JsonRecord[] {
  const runsById = new Map(input.runs.map(run => [run.runId, run]));
  const referencedRunIds = new Set<string>();
  const sessions = new Map<string, JsonRecord>();

  for (const turn of input.turnMetadata) {
    const sessionType = String(turn.sessionType || 'unknown');
    const sessionId = String(turn.sessionId || 'unknown');
    const key = `${sessionType}/${sessionId}`;
    const runIds = uniqueStrings(turn.gauzmemRunIds || []);
    runIds.forEach(id => referencedRunIds.add(id));
    const runs = runIds.map(id => runsById.get(id)).filter((run): run is JsonRecord => Boolean(run));
    const session = sessions.get(key) || {
      key,
      sessionType,
      sessionId,
      turnCount: 0,
      runCount: 0,
      firstAt: turn.timestamp,
      lastAt: turn.timestamp,
      turns: [],
    };
    session.turns.push({
      turnId: String(turn.turnId || ''),
      timestamp: turn.timestamp,
      userTextHash: turn.userTextHash,
      assistantTextHash: turn.assistantTextHash,
      runIds,
      query: runs.map(run => run.query).filter(Boolean).join(' / '),
      passiveRunCount: Array.isArray(turn.metadata?.passive?.runs) ? turn.metadata.passive.runs.length : 0,
      activeRunCount: Number(turn.metadata?.activeRunCount || 0),
      runs,
    });
    session.turnCount = session.turns.length;
    session.runCount += runs.length;
    session.firstAt = minTimestamp(session.firstAt, turn.timestamp);
    session.lastAt = maxTimestamp(session.lastAt, turn.timestamp);
    sessions.set(key, session);
  }

  const unlinkedRuns = input.runs.filter(run => !referencedRunIds.has(run.runId));
  if (unlinkedRuns.length > 0) {
    sessions.set('unlinked/runs', {
      key: 'unlinked/runs',
      sessionType: 'unlinked',
      sessionId: 'runs',
      turnCount: unlinkedRuns.length,
      runCount: unlinkedRuns.length,
      firstAt: unlinkedRuns[0]?.timestamp,
      lastAt: unlinkedRuns[unlinkedRuns.length - 1]?.timestamp,
      turns: unlinkedRuns.map(run => ({
        turnId: run.runId,
        timestamp: run.timestamp,
        runIds: [run.runId],
        query: run.query,
        passiveRunCount: run.callType === 'passive' ? 1 : 0,
        activeRunCount: run.callType === 'tool_search' ? 1 : 0,
        runs: [run],
      })),
    });
  }

  return Array.from(sessions.values())
    .sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')))
    .slice(0, input.maxSessions)
    .map(session => ({
      ...session,
      turns: [...session.turns]
        .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')))
        .slice(-1 * input.maxTurnsPerSession),
    }));
}

function buildMetabolismTimeline(input: {
  snapshot: StoreSnapshot;
  nodeStateById: Map<string, JsonRecord>;
  edgeStateById: Map<string, JsonRecord>;
  currentTick: number;
  tickTimestamp: Map<number, string>;
  maxRows: number;
}): JsonRecord {
  const days = new Map<string, JsonRecord>();
  const ensureDay = (date: string): JsonRecord => {
    const key = date || 'unknown';
    const existing = days.get(key);
    if (existing) return existing;
    const row = {
      date: key,
      runs: 0,
      passiveRuns: 0,
      toolRuns: 0,
      createdNodes: 0,
      createdEdges: 0,
      selectedNodes: 0,
      selectedEdges: 0,
      injectedNodes: 0,
      injectedEdges: 0,
      rejectedNodes: 0,
      rejectedEdges: 0,
      graphHits: 0,
      fadedNodes: 0,
      fadedEdges: 0,
    };
    days.set(key, row);
    return row;
  };

  for (const run of input.snapshot.runs) {
    const row = ensureDay(toDateKey(run.timestamp));
    row.runs += 1;
    if (run.callType === 'tool_search') row.toolRuns += 1;
    else row.passiveRuns += 1;
  }
  for (const event of input.snapshot.events) {
    const row = ensureDay(toDateKey(event.timestamp));
    const targetType = String(event.targetType || '');
    const eventType = String(event.eventType || '');
    if (eventType === 'created' && targetType === 'node') row.createdNodes += 1;
    if (eventType === 'created' && targetType === 'edge') row.createdEdges += 1;
    if (eventType === 'selected' && targetType === 'node') row.selectedNodes += 1;
    if (eventType === 'selected' && targetType === 'edge') row.selectedEdges += 1;
    if (eventType === 'injected' && targetType === 'node') row.injectedNodes += 1;
    if (eventType === 'injected' && targetType === 'edge') row.injectedEdges += 1;
    if (eventType.includes('rejected') && targetType === 'node') row.rejectedNodes += 1;
    if (eventType.includes('rejected') && targetType === 'edge') row.rejectedEdges += 1;
    if (eventType === 'graph_hit') row.graphHits += 1;
  }
  for (const state of input.snapshot.nodeStates) {
    const date = toDateKey(input.tickTimestamp.get(Number(state.tick || 0)));
    if (!date) continue;
    const effective = effectiveWeight(state, input.currentTick);
    if (String(state.visibility || '') === 'faint' || String(state.visibility || '') === 'dormant' || effective < NODE_RETRIEVAL_THRESHOLD) {
      ensureDay(date).fadedNodes += 1;
    }
  }
  for (const state of input.snapshot.edgeStates) {
    const date = toDateKey(input.tickTimestamp.get(Number(state.tick || 0)));
    if (!date) continue;
    const effective = effectiveWeight(state, input.currentTick);
    if (String(state.visibility || '') === 'faint' || String(state.visibility || '') === 'dormant' || effective < EDGE_RETRIEVAL_THRESHOLD) {
      ensureDay(date).fadedEdges += 1;
    }
  }

  const latestNodeStates = Array.from(input.nodeStateById.values());
  const latestEdgeStates = Array.from(input.edgeStateById.values());
  const rows = Array.from(days.values())
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-1 * input.maxRows);
  return {
    rows,
    current: {
      activeNodes: latestNodeStates.filter(state => String(state.visibility || 'active') === 'active').length,
      faintNodes: latestNodeStates.filter(state => String(state.visibility || '') === 'faint').length,
      dormantNodes: latestNodeStates.filter(state => String(state.visibility || '') === 'dormant').length,
      retrievableNodes: latestNodeStates.filter(state => effectiveWeight(state, input.currentTick) >= NODE_RETRIEVAL_THRESHOLD).length,
      retrievableEdges: latestEdgeStates.filter(state => effectiveWeight(state, input.currentTick) >= EDGE_RETRIEVAL_THRESHOLD).length,
    },
  };
}

function effectiveWeight(state: JsonRecord | undefined, tick: number): number {
  if (!state || String(state.visibility || '') === 'dormant') return 0;
  const lastTouchedTick = Number(state.lastTouchedTick ?? state.tick ?? tick);
  const age = Math.max(0, tick - lastTouchedTick);
  const memoryFactor = 1 + Math.max(0, Number(state.selectedCount || 0));
  return Number(state.weight || 0) / (1 + age / memoryFactor);
}

function formatSourceRef(sourceRef: JsonRecord | undefined, projectRoot: string): string {
  if (!sourceRef) return 'unknown source';
  if (sourceRef.kind === 'conversation') {
    const location = sourceRef.logPath ? safePathLabel(String(sourceRef.logPath), projectRoot) : 'conversation';
    const line = sourceRef.jsonlLine ? `:${sourceRef.jsonlLine}` : '';
    const session = [sourceRef.sessionType, sourceRef.sessionId].filter(Boolean).join('/');
    return [session, `${location}${line}`].filter(Boolean).join(' ');
  }
  if (sourceRef.kind === 'attachment') {
    const file = sourceRef.originalPath || sourceRef.fileName || sourceRef.extractedTextPath || 'attachment';
    return `attachment ${safePathLabel(String(file), projectRoot)}`;
  }
  if (sourceRef.path) return `${sourceRef.kind || 'source'} ${safePathLabel(String(sourceRef.path), projectRoot)}`;
  return sourceRef.kind || 'unknown source';
}

function sanitizeFiles(files: Record<string, LoadedFile>, projectRoot: string): Record<string, LoadedFile> {
  return Object.fromEntries(Object.entries(files).map(([key, file]) => [
    key,
    {
      ...file,
      path: safePathLabel(file.path, projectRoot),
    },
  ]));
}

function safePathLabel(filePath: string, projectRoot: string): string {
  const resolved = path.resolve(filePath);
  const relative = path.relative(projectRoot, resolved);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  return `.../${path.basename(resolved)}`;
}

function sourceTrustFor(sourceRef: JsonRecord | undefined): string {
  const role = sourceRef?.role || sourceRef?.kind;
  if (role === 'assistant') return 'assistant';
  if (role === 'tool') return 'tool';
  if (role === 'user') return 'user';
  if (sourceRef?.kind === 'attachment') return 'doc';
  if (sourceRef?.kind === 'file') return sourceRef.role === 'code' ? 'code' : 'doc';
  return 'doc';
}

function countEvents(events: JsonRecord[], eventType: string): number {
  return events.filter(event => event.eventType === eventType).length;
}

function countEventTypes(events: JsonRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const event of events) {
    const type = String(event.eventType || 'unknown');
    out[type] = (out[type] || 0) + 1;
  }
  return out;
}

function pickStats(stats: JsonRecord): JsonRecord {
  const keys = [
    'docsScanned',
    'sourceHitCount',
    'sourceWindowCount',
    'evidenceCount',
    'sourceEvidenceCount',
    'graphSeedCount',
    'graphEdgeSeedCount',
    'constructedNodeCount',
    'constructedEdgeCount',
    'edgeCount',
    'graphWasSufficient',
    'energyInitial',
    'energyRemaining',
    'reasoner',
  ];
  return Object.fromEntries(keys.filter(key => Object.prototype.hasOwnProperty.call(stats, key)).map(key => [key, stats[key]]));
}

function sanitizeSearchTrace(trace: JsonRecord[]): JsonRecord[] {
  return (trace || []).map(item => ({
    termId: item.termId,
    pattern: item.pattern,
    graphNodeHits: Number(item.graphNodeHits || 0),
    graphEdgeHits: Number(item.graphEdgeHits || 0),
    sourceHitCount: Number(item.sourceHitCount || item.hitCount || 0),
    sourceEvidenceCount: Number(item.sourceEvidenceCount || item.evidenceCount || 0),
  })).filter(item => item.pattern).slice(0, 12);
}

function latestTimestamp(items: JsonRecord[]): string | undefined {
  const values = items.map(item => item.timestamp).filter(Boolean).sort();
  return values[values.length - 1];
}

function minTimestamp(a: unknown, b: unknown): string | undefined {
  const values = [a, b].map(value => String(value || '')).filter(Boolean).sort();
  return values[0];
}

function maxTimestamp(a: unknown, b: unknown): string | undefined {
  const values = [a, b].map(value => String(value || '')).filter(Boolean).sort();
  return values[values.length - 1];
}

function toDateKey(value: unknown): string {
  const text = String(value || '');
  const match = text.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}

function cleanText(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function previewText(value: unknown, maxChars: number): string {
  const text = cleanText(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function uniqueStrings(items: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items || []) {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function roundNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
}
