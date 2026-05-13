"use strict";

const { createSearchPlan } = require("./planner");
const { createReasoner } = require("./reasoner");
const { loadSearchDocs } = require("./sourceAdapter");
const { buildPromptBundle, discloseGraph, scanGraph } = require("./graph");
const {
  appendEdgeStates,
  appendEvents,
  appendNodeStates,
  appendRun,
  appendTurnMetadata,
  evidenceEdgeId,
  loadGraph,
  loadGraphWithState,
  runIdFor,
  upsertEdges,
  upsertNodes,
} = require("./store");
const {
  buildSourceWindowsFromHits,
  evidenceNodesFromWindowEvidence,
  extractEvidenceFromHits,
  scanDocs,
  searchTrace,
} = require("./search");
const {
  currentTick,
  defaultEdgeState,
  defaultNodeState,
  penalizeEdgeState,
  penalizeNodeState,
  reinforceEdgeState,
  reinforceNodeState,
  resolveThresholds,
} = require("./state");

async function retrieve(input = {}) {
  const query = String(input.query || "").trim();
  if (!query) throw new Error("query is required");

  const timestamp = input.timestamp || new Date().toISOString();
  const runId = input.runId || runIdFor(query, `${timestamp}:${process.hrtime.bigint()}:${Math.random()}`);
  const storeRoot = input.storeRoot;
  const budget = resolveBudget(input.budget || {}, input.callType || "passive");
  const replay = replayRunIfExists({ storeRoot, runId, query, maxPromptChars: budget.maxPromptChars });
  if (replay) return replay;
  const thresholds = resolveThresholds(budget.thresholds);
  const reasoner = createReasoner({
    reasoner: input.reasoner,
    apiKey: input.llmApiKey,
    baseUrl: input.llmBaseUrl,
    model: input.llmModel,
    timeoutMs: input.llmTimeoutMs,
  });
  const energy = new EnergyMeter(budget.energy);

  const searchPlan = await createReasonedSearchPlan({ query, input, budget, reasoner });
  const graphBefore = loadGraphWithState(storeRoot);
  const tick = currentTick(graphBefore);
  const graphOptions = { budget, thresholds, tick };
  energy.consume("graph_scan", 1);
  const graphMatch = scanGraph(searchPlan, graphBefore, graphOptions);
  const graphSeedNodes = idsToNodes(graphMatch.seedNodeIds, graphBefore);
  let graphDisclosure = { nodes: [], edges: [] };
  let graphSelection = emptySelection();
  let graphSelectedNodes = [];

  if (graphSeedNodes.length > 0 && energy.consume("graph_disclose", 1)) {
    graphDisclosure = discloseGraph(graphMatch.seedNodeIds, graphBefore, {
      ...graphOptions,
      maxGraphHops: budget.maxGraphHops,
      maxGraphEdges: budget.maxGraphEdges,
      visited: { nodeIds: new Set(), edgeIds: new Set() },
    });
    if (energy.consume("root_relevance_graph", 4)) {
      graphSelection = await reasoner.selectRootRelevant({
        query,
        nodes: graphDisclosure.nodes,
        edges: graphDisclosure.edges,
        minSelected: 0,
        allowEmpty: true,
        allowReject: true,
      });
      graphSelectedNodes = idsToNodes(graphSelection.selectedNodeIds, graphBefore);
    }
  }

  const graphWasUseful = graphSelectedNodes.length > 0;
  const graphWasSufficient = isGraphSufficient({
    searchPlan,
    selectedNodes: graphSelectedNodes,
    selectedEdges: idsToEdges(graphSelection.selectedEdgeIds, graphBefore),
    selectedNodeCount: graphSelectedNodes.length,
    selectedEdgeCount: graphSelection.selectedEdgeIds.length,
    budget,
  });
  const sourceRootPaths = sourceRootsForInput(input);
  const hasSourceRoots = sourceRootPaths.length > 0;
  const shouldConstruct = budget.forceConstruct
    || !graphWasUseful
    || (hasSourceRoots && !graphWasSufficient);
  let docs = [];
  let hits = [];
  let windows = [];
  let sourceEvidence = [];
  let sourceSelection = emptySelection();
  let sourceSelectedNodes = [];
  let constructEdges = [];
  let createdNodes = [];
  let createdEdges = [];

  if (shouldConstruct && energy.consume("source_grep", 3)) {
    docs = loadSearchDocs({
      rootPaths: sourceRootPaths,
      storeRoot,
    });
    hits = scanDocs(docs, searchPlan, { budget });
    windows = buildSourceWindowsFromHits(hits, {
      budget,
      maxEvidence: budget.maxWindows,
      maxEvidenceChars: budget.maxEvidenceChars,
    });

    if (windows.length > 0 && energy.consume("llm_extract_evidence", 6)) {
      const extracted = await reasoner.extractEvidence({
        query,
        parent: graphSelectedNodes[0] || { id: "root_query", query },
        windows,
        maxEvidence: budget.maxEvidence,
      });
      sourceEvidence = evidenceNodesFromWindowEvidence(extracted, windows, {
        timestamp,
        budget,
        maxEvidence: budget.maxEvidence,
        runId,
      });
    }

    if (sourceEvidence.length === 0) {
      sourceEvidence = extractEvidenceFromHits(hits, {
        timestamp,
        budget,
        maxEvidence: budget.maxEvidence,
        runId,
      });
    }

    createdNodes = upsertNodes(storeRoot, sourceEvidence);
    appendInitialNodeStates(storeRoot, graphBefore, sourceEvidence, tick);

    if (sourceEvidence.length > 0 && energy.consume("root_relevance_source", 4)) {
      sourceSelection = await reasoner.selectRootRelevant({
        query,
        nodes: sourceEvidence,
        edges: [],
        minSelected: 1,
        allowReject: false,
      });
      sourceSelectedNodes = idsToNodes(sourceSelection.selectedNodeIds, { nodes: sourceEvidence });
    }

    if (graphSelectedNodes.length > 0 && sourceSelectedNodes.length > 0 && energy.consume("write_local_edges", 6)) {
      constructEdges = await createConstructEdges({
        query,
        runId,
        timestamp,
        reasoner,
        parents: graphSelectedNodes,
        sourceNodes: sourceSelectedNodes,
        existingEdges: graphBefore.edges,
        maxEdges: budget.maxRunEdges,
        maxParents: budget.maxConstructParents,
        maxIncomingEdgesPerRun: budget.maxIncomingConstructEdgesPerRun,
      });
      createdEdges = upsertEdges(storeRoot, constructEdges);
      const graphAfterNodes = loadGraphWithState(storeRoot);
      appendInitialEdgeStates(storeRoot, graphAfterNodes, createdEdges, tick);
    }
  }

  const selectedNodeIds = uniqueIds([
    ...graphSelection.selectedNodeIds,
    ...sourceSelection.selectedNodeIds,
  ]);
  const selectedEdgeIds = uniqueIds([
    ...graphSelection.selectedEdgeIds,
  ]);
  const returnedConstructEdges = createdEdges;
  const createdEdgeIds = createdEdges.map((edge) => edge.id);
  const returnedEdgeIds = uniqueIds([
    ...selectedEdgeIds,
    ...createdEdgeIds,
  ]);
  const rejectedNodeIds = uniqueIds([
    ...graphSelection.rejectedNodeIds,
    ...sourceSelection.rejectedNodeIds,
  ]);
  const rejectedEdgeIds = uniqueIds(graphSelection.rejectedEdgeIds);

  const graphAfterWrites = loadGraphWithState(storeRoot);
  appendStateUpdates(storeRoot, graphAfterWrites, {
    tick,
    selectedNodeIds,
    selectedEdgeIds: graphSelection.selectedEdgeIds,
    rejectedNodeIds,
    rejectedEdgeIds,
  });

  const graphFinal = loadGraphWithState(storeRoot);
  const evidence = idsToNodes(selectedNodeIds, graphFinal);
  const promptGraph = filterGraphForPrompt({
    graph: graphFinal,
    disclosedGraph: graphDisclosure,
    selectedNodeIds,
    selectedEdgeIds,
    constructEdges: returnedConstructEdges,
  });
  const rawPromptBundle = buildPromptBundle({
    query,
    evidence,
    disclosedGraph: promptGraph,
  });
  const promptBundle = limitPromptBundle(rawPromptBundle, budget.maxPromptChars);
  const memoryBundle = {
    runId,
    query,
    transient: true,
    text: promptBundle,
    evidenceIds: evidence.map((node) => node.id),
    edgeIds: promptGraph.edges.map((edge) => edge.id),
    selectedEdgeIds,
    createdEdgeIds,
  };
  const sourceTrace = shouldConstruct ? searchTrace(searchPlan, hits, sourceEvidence) : [];
  const trace = mergeTrace(graphMatch.trace, sourceTrace);
  const retrieveMode = shouldConstruct
    ? (graphSeedNodes.length > 0 ? "graph_then_construct" : "source_construct")
    : "graph_first";
  const run = {
    runId,
    query,
    timestamp,
    callType: input.callType || "passive",
    searchPlan,
    searchTrace: trace,
    evidenceIds: evidence.map((node) => node.id),
    selectedNodeIds,
    selectedEdgeIds,
    createdEdgeIds,
    returnedEdgeIds,
    rejectedNodeIds,
    rejectedEdgeIds,
    edgeIds: createdEdgeIds,
    disclosedNodeIds: promptGraph.nodes.map((node) => node.id),
    disclosedEdgeIds: promptGraph.edges.map((edge) => edge.id),
    retrieveMode,
    graphSeedNodeIds: graphMatch.seedNodeIds,
    graphSeedEdgeIds: graphMatch.seedEdgeIds,
    stats: {
      docsScanned: docs.length,
      sourceHitCount: hits.length,
      sourceWindowCount: windows.length,
      evidenceCount: evidence.length,
      sourceEvidenceCount: sourceEvidence.length,
      graphSeedCount: graphMatch.seedNodeIds.length,
      graphEdgeSeedCount: graphMatch.seedEdgeIds.length,
      constructedNodeCount: createdNodes.length,
      constructedEdgeCount: createdEdges.length,
      constructCandidateEdgeCount: constructEdges.length,
      edgeCount: returnedEdgeIds.length,
      graphWasSufficient,
      promptCharCount: promptBundle.length,
      promptTruncated: promptBundle.length < rawPromptBundle.length,
      energyInitial: budget.energy,
      energyRemaining: energy.remaining,
      energyTrace: energy.trace,
      reasoner: reasoner.constructor.name,
    },
  };
  appendRun(storeRoot, run);
  appendEvents(storeRoot, buildEvents({
    run,
    timestamp,
    graphMatch,
    createdNodes,
    createdEdges,
    evidence,
    promptGraph,
    selectedNodeIds,
    selectedEdgeIds,
    createdEdgeIds,
    rejectedNodeIds,
    rejectedEdgeIds,
  }));

  return {
    runId,
    query,
    searchPlan,
    searchTrace: trace,
    retrieveMode,
    evidence,
    disclosedGraph: promptGraph,
    memoryBundle,
    promptBundle,
    selectedNodeIds,
    selectedEdgeIds,
    createdEdgeIds,
    stats: run.stats,
  };
}

function recordFeedback(input = {}) {
  const runId = input.runId;
  if (!runId) throw new Error("runId is required");
  const timestamp = input.timestamp || new Date().toISOString();
  const graph = loadGraph(input.storeRoot);
  if (!graph.runs.some((run) => run.runId === runId)) {
    throw new Error(`unknown runId: ${runId}`);
  }
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  for (const evidenceId of (input.usedEvidenceIds || []).concat(input.rejectedEvidenceIds || [])) {
    if (!nodeIds.has(evidenceId)) throw new Error(`unknown evidence id: ${evidenceId}`);
  }
  for (const edgeId of (input.usedEdgeIds || []).concat(input.usefulEdgeIds || [])) {
    if (!edgeIds.has(edgeId)) throw new Error(`unknown edge id: ${edgeId}`);
  }
  const tick = currentTick(graph);
  const events = [];
  const nodeStates = [];
  const edgeStates = [];
  const graphWithState = loadGraphWithState(input.storeRoot);
  for (const evidenceId of input.usedEvidenceIds || []) {
    events.push({
      eventId: `${runId}:used:${evidenceId}:${events.length}`,
      targetType: "node",
      targetId: evidenceId,
      eventType: "used",
      runId,
      timestamp,
    });
    nodeStates.push(reinforceNodeState(
      graphWithState.nodeStateById.get(evidenceId) || defaultNodeState(evidenceId, tick, "used"),
      tick,
      "used",
    ));
  }
  for (const evidenceId of input.rejectedEvidenceIds || []) {
    events.push({
      eventId: `${runId}:rejected:${evidenceId}:${events.length}`,
      targetType: "node",
      targetId: evidenceId,
      eventType: "rejected",
      runId,
      timestamp,
    });
    const penalized = penalizeNodeState(graphWithState.nodeStateById.get(evidenceId), tick, "feedback_rejected");
    if (penalized) nodeStates.push(penalized);
  }
  const feedbackEdgeIds = uniqueIds([
    ...(input.usedEdgeIds || []),
    ...(input.usefulEdgeIds || []),
  ]);
  for (const edgeId of feedbackEdgeIds) {
    events.push({
      eventId: `${runId}:used:${edgeId}:${events.length}`,
      targetType: "edge",
      targetId: edgeId,
      eventType: "used",
      runId,
      timestamp,
    });
    edgeStates.push(reinforceEdgeState(
      graphWithState.edgeStateById.get(edgeId) || defaultEdgeState(edgeId, tick, "localAssociation", "used"),
      tick,
      "used",
    ));
  }
  for (const term of input.failedTerms || []) {
    events.push({
      eventId: `${runId}:noisy:${term}:${events.length}`,
      targetType: "term",
      targetId: term,
      eventType: "noisy",
      runId,
      timestamp,
    });
  }
  for (const correction of input.userCorrections || []) {
    events.push({
      eventId: `${runId}:corrected:${events.length}`,
      targetType: "run",
      targetId: runId,
      eventType: "corrected",
      runId,
      timestamp,
      note: correction,
    });
  }
  appendEvents(input.storeRoot, events);
  appendNodeStates(input.storeRoot, nodeStates);
  appendEdgeStates(input.storeRoot, edgeStates);
  return { runId, eventsWritten: events.length, events, nodeStatesWritten: nodeStates.length, edgeStatesWritten: edgeStates.length };
}

function recordTurnMetadata(input = {}) {
  const timestamp = input.timestamp || new Date().toISOString();
  const record = {
    schemaVersion: 1,
    turnId: input.turnId || input.id || runIdFor(input.sessionId || "turn", timestamp),
    timestamp,
    agent: input.agent || "xiaoba",
    sessionId: input.sessionId,
    sessionType: input.sessionType,
    userTextHash: input.userTextHash,
    assistantTextHash: input.assistantTextHash,
    gauzmemRunIds: input.gauzmemRunIds || [],
    metadata: input.metadata || {},
  };
  appendTurnMetadata(input.storeRoot, record);
  return record;
}

function resolveBudget(raw = {}, callType) {
  const defaultEnergy = callType === "tool_search" ? 48 : 32;
  return {
    maxTerms: raw.maxTerms || 12,
    maxEvidence: raw.maxEvidence || 12,
    maxWindows: raw.maxWindows || raw.maxEvidence || 12,
    maxEvidenceChars: raw.maxEvidenceChars || 420,
    maxGraphHops: raw.maxGraphHops ?? 1,
    maxGraphEdges: raw.maxGraphEdges || 24,
    maxGraphHitsPerTerm: raw.maxGraphHitsPerTerm || 50,
    maxHitsPerTerm: raw.maxHitsPerTerm || 50,
    maxRunEdges: raw.maxRunEdges || 24,
    minGraphEvidence: raw.minGraphEvidence || 2,
    maxConstructParents: raw.maxConstructParents || 1,
    maxIncomingConstructEdgesPerRun: raw.maxIncomingConstructEdgesPerRun || 1,
    minGraphTermCoverage: raw.minGraphTermCoverage ?? 0.8,
    maxPromptChars: raw.maxPromptChars || 12000,
    energy: raw.energy ?? defaultEnergy,
    forceConstruct: raw.forceConstruct === true,
    thresholds: raw.thresholds || {},
  };
}

function replayRunIfExists(input) {
  const graph = loadGraphWithState(input.storeRoot);
  const run = (graph.runs || []).find((item) => item.runId === input.runId);
  if (!run) return null;
  if (String(run.query || "") !== String(input.query || "")) {
    throw new Error(`runId already exists for a different query: ${input.runId}`);
  }
  const evidence = idsToNodes(run.evidenceIds || run.selectedNodeIds || [], graph);
  const disclosedGraph = {
    nodes: idsToNodes(run.disclosedNodeIds || run.evidenceIds || [], graph),
    edges: idsToEdges(run.disclosedEdgeIds || run.returnedEdgeIds || [], graph),
  };
  const rawPromptBundle = buildPromptBundle({
    query: run.query,
    evidence,
    disclosedGraph,
  });
  const promptBundle = limitPromptBundle(rawPromptBundle, input.maxPromptChars);
  return {
    runId: run.runId,
    query: run.query,
    searchPlan: run.searchPlan,
    searchTrace: run.searchTrace || [],
    retrieveMode: run.retrieveMode,
    evidence,
    disclosedGraph,
    memoryBundle: {
      runId: run.runId,
      query: run.query,
      transient: true,
      text: promptBundle,
      evidenceIds: evidence.map((node) => node.id),
      edgeIds: disclosedGraph.edges.map((edge) => edge.id),
      selectedEdgeIds: run.selectedEdgeIds || [],
      createdEdgeIds: run.createdEdgeIds || [],
    },
    promptBundle,
    selectedNodeIds: run.selectedNodeIds || [],
    selectedEdgeIds: run.selectedEdgeIds || [],
    createdEdgeIds: run.createdEdgeIds || [],
    stats: {
      ...(run.stats || {}),
      promptCharCount: promptBundle.length,
      promptTruncated: promptBundle.length < rawPromptBundle.length,
      idempotentReplay: true,
    },
  };
}

function limitPromptBundle(text, maxChars) {
  const limit = Number(maxChars || 0);
  if (!limit || text.length <= limit) return text;
  const endTag = "\n[/gauzmem_recall]";
  const marker = "\n[truncated: memory bundle exceeded prompt char budget]";
  const available = Math.max(0, limit - endTag.length - marker.length);
  return `${text.slice(0, available)}${marker}${endTag}`;
}

function isGraphSufficient(input) {
  if (input.selectedNodeCount <= 0) return false;
  const enoughEvidence = input.selectedNodeCount >= input.budget.minGraphEvidence
    || (input.selectedEdgeCount > 0 && input.selectedNodeCount > 1);
  if (!enoughEvidence) return false;
  return graphTermCoverage(input.searchPlan, input.selectedNodes) >= input.budget.minGraphTermCoverage;
}

function graphTermCoverage(searchPlan, nodes) {
  const terms = (searchPlan?.termGroups || [])
    .map((group) => String(group.term || "").trim().toLowerCase())
    .filter((term) => term.length >= 2);
  if (terms.length === 0) return 1;
  const haystack = (nodes || []).map((node) => node.text || "").join("\n").toLowerCase();
  const covered = terms.filter((term) => haystack.includes(term)).length;
  return covered / terms.length;
}

function sourceRootsForInput(input) {
  if (Array.isArray(input.rootPaths) && input.rootPaths.length > 0) return input.rootPaths;
  if (Array.isArray(input.sourceRoots) && input.sourceRoots.length > 0) return input.sourceRoots;
  return [];
}

async function createReasonedSearchPlan({ query, input, budget, reasoner }) {
  const basePlan = createSearchPlan({
    query,
    searchTerms: input.searchTerms,
    maxTerms: budget.maxTerms,
    budget,
  });
  const baseTerms = basePlan.termGroups.map((group) => group.term);
  const reasonedTerms = await reasoner.generateSearchTerms({
    query,
    explicitTerms: input.searchTerms || [],
    maxTerms: budget.maxTerms,
  });
  const searchPlan = createSearchPlan({
    query,
    searchTerms: uniqueTerms([...reasonedTerms, ...baseTerms], budget.maxTerms),
    maxTerms: budget.maxTerms,
    budget,
  });
  searchPlan.mode = reasoner.constructor.name === "AnthropicCompatibleReasoner"
    ? "llm_assisted_grep"
    : "deterministic_grep";
  return searchPlan;
}

async function createConstructEdges(input) {
  const edges = [];
  const parents = (input.parents || []).slice(0, input.maxParents || 1);
  const existingPairs = new Set((input.existingEdges || []).map(edgeKey));
  const linkedTargets = new Map();
  if (parents.length === 0) return edges;
  for (const from of parents) {
    for (const to of input.sourceNodes) {
      if (!from || !to || from.id === to.id) continue;
      const pairKey = edgeKey({ mode: "localAssociation", from: from.id, to: to.id });
      if (existingPairs.has(pairKey)) continue;
      const incomingCount = linkedTargets.get(to.id) || 0;
      if (incomingCount >= (input.maxIncomingEdgesPerRun || 1)) continue;
      const whyRelevant = await input.reasoner.writeWhyRelevant({
        query: input.query,
        from,
        to,
      });
      edges.push({
        schemaVersion: 1,
        id: evidenceEdgeId(from.id, to.id),
        from: from.id,
        to: to.id,
        mode: "localAssociation",
        direction: "directed",
        whyRelevant,
        runId: input.runId,
        createdFromRunId: input.runId,
        createdFromNodeId: from.id,
        sourceNodeIds: [from.id, to.id],
        createdAt: input.timestamp,
      });
      existingPairs.add(pairKey);
      linkedTargets.set(to.id, incomingCount + 1);
      if (edges.length >= input.maxEdges) return dedupeEdges(edges);
    }
  }
  return dedupeEdges(edges);
}

function edgeKey(edge) {
  return `${edge.mode || "localAssociation"}:${edge.from || ""}->${edge.to || ""}`;
}

function appendInitialNodeStates(storeRoot, graphBefore, nodes, tick) {
  const states = [];
  const seen = new Set();
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    if (graphBefore.nodeStateById?.has(node.id)) continue;
    states.push(defaultNodeState(node.id, tick, "created"));
  }
  appendNodeStates(storeRoot, states);
}

function appendInitialEdgeStates(storeRoot, graphBefore, edges, tick) {
  const states = [];
  const seen = new Set();
  for (const edge of edges) {
    if (seen.has(edge.id)) continue;
    seen.add(edge.id);
    if (graphBefore.edgeStateById?.has(edge.id)) continue;
    states.push(defaultEdgeState(edge.id, tick, edge.mode, "created"));
  }
  appendEdgeStates(storeRoot, states);
}

function appendStateUpdates(storeRoot, graph, input) {
  const nodeStates = [];
  const edgeStates = [];
  for (const nodeId of input.selectedNodeIds) {
    nodeStates.push(reinforceNodeState(
      graph.nodeStateById.get(nodeId) || defaultNodeState(nodeId, input.tick, "selected"),
      input.tick,
      "selected",
    ));
  }
  for (const edgeId of input.selectedEdgeIds) {
    edgeStates.push(reinforceEdgeState(
      graph.edgeStateById.get(edgeId) || defaultEdgeState(edgeId, input.tick, "localAssociation", "selected"),
      input.tick,
      "selected",
    ));
  }
  for (const nodeId of input.rejectedNodeIds) {
    const next = penalizeNodeState(graph.nodeStateById.get(nodeId), input.tick, "root_relevance_rejected");
    if (next) nodeStates.push(next);
  }
  for (const edgeId of input.rejectedEdgeIds) {
    const next = penalizeEdgeState(graph.edgeStateById.get(edgeId), input.tick, "root_relevance_rejected");
    if (next) edgeStates.push(next);
  }
  appendNodeStates(storeRoot, nodeStates);
  appendEdgeStates(storeRoot, edgeStates);
}

function filterGraphForPrompt(input) {
  const selectedNodeSet = new Set(input.selectedNodeIds);
  const selectedEdgeSet = new Set(input.selectedEdgeIds);
  for (const edge of input.constructEdges || []) {
    selectedEdgeSet.add(edge.id);
    selectedNodeSet.add(edge.from);
    selectedNodeSet.add(edge.to);
  }
  const disclosedEdges = [
    ...(input.disclosedGraph.edges || []),
    ...(input.constructEdges || []),
  ];
  const edgeIds = new Set();
  const edges = [];
  for (const edge of disclosedEdges) {
    if (!selectedEdgeSet.has(edge.id)) continue;
    if (edgeIds.has(edge.id)) continue;
    edgeIds.add(edge.id);
    edges.push(edge);
    selectedNodeSet.add(edge.from);
    selectedNodeSet.add(edge.to);
  }
  return {
    nodes: idsToNodes(Array.from(selectedNodeSet), input.graph),
    edges,
  };
}

function buildEvents(input) {
  const events = [];
  for (const hit of input.graphMatch.nodeHits || []) {
    events.push(event(input.run, input.timestamp, "node", hit.nodeId, "graph_hit", hit));
  }
  for (const hit of input.graphMatch.edgeHits || []) {
    events.push(event(input.run, input.timestamp, "edge", hit.edgeId, "graph_hit", hit));
  }
  for (const node of input.createdNodes) {
    events.push(event(input.run, input.timestamp, "node", node.id, "created"));
  }
  for (const edge of input.createdEdges) {
    events.push(event(input.run, input.timestamp, "edge", edge.id, "created"));
  }
  for (const node of input.promptGraph.nodes) {
    events.push(event(input.run, input.timestamp, "node", node.id, "injected"));
  }
  for (const edge of input.promptGraph.edges) {
    events.push(event(input.run, input.timestamp, "edge", edge.id, "injected"));
  }
  for (const nodeId of input.selectedNodeIds) {
    events.push(event(input.run, input.timestamp, "node", nodeId, "selected"));
  }
  for (const edgeId of input.selectedEdgeIds) {
    events.push(event(input.run, input.timestamp, "edge", edgeId, "selected"));
  }
  for (const edgeId of input.createdEdgeIds || []) {
    events.push(event(input.run, input.timestamp, "edge", edgeId, "returned"));
  }
  for (const nodeId of input.rejectedNodeIds) {
    events.push(event(input.run, input.timestamp, "node", nodeId, "root_relevance_rejected"));
  }
  for (const edgeId of input.rejectedEdgeIds) {
    events.push(event(input.run, input.timestamp, "edge", edgeId, "root_relevance_rejected"));
  }
  for (const node of input.evidence) {
    events.push(event(input.run, input.timestamp, "node", node.id, "retrieved"));
  }
  return events;
}

function event(run, timestamp, targetType, targetId, eventType, payload) {
  return {
    eventId: `${run.runId}:${eventType}:${targetType}:${targetId}:${Math.random().toString(16).slice(2)}`,
    targetType,
    targetId,
    eventType,
    runId: run.runId,
    timestamp,
    payload,
  };
}

function idsToNodes(ids, graph) {
  const byId = new Map((graph.nodes || []).map((node) => [node.id, node]));
  return uniqueIds(ids).map((id) => byId.get(id)).filter(Boolean);
}

function idsToEdges(ids, graph) {
  const byId = new Map((graph.edges || []).map((edge) => [edge.id, edge]));
  return uniqueIds(ids).map((id) => byId.get(id)).filter(Boolean);
}

function mergeTrace(graphTrace, sourceTrace) {
  return (graphTrace || []).map((entry) => {
    const source = (sourceTrace || []).find((item) => item.termId === entry.termId);
    return {
      ...entry,
      sourceHitCount: source?.hitCount || 0,
      sourceEvidenceCount: source?.evidenceCount || 0,
    };
  });
}

function uniqueTerms(items, limit) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const term = String(item || "").trim();
    if (term.length < 2) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= limit) break;
  }
  return out;
}

function uniqueIds(ids) {
  return Array.from(new Set((ids || []).filter(Boolean)));
}

function dedupeEdges(edges) {
  const byId = new Map();
  for (const edge of edges || []) byId.set(edge.id, edge);
  return Array.from(byId.values());
}

function emptySelection() {
  return {
    selectedNodeIds: [],
    selectedEdgeIds: [],
    rejectedNodeIds: [],
    rejectedEdgeIds: [],
    reasonById: {},
  };
}

class EnergyMeter {
  constructor(initial) {
    this.remaining = initial;
    this.trace = [];
  }

  consume(label, cost) {
    if (this.remaining < cost) {
      this.trace.push({ label, cost, skipped: true, remaining: this.remaining });
      return false;
    }
    this.remaining -= cost;
    this.trace.push({ label, cost, skipped: false, remaining: this.remaining });
    return true;
  }
}

module.exports = {
  recordFeedback,
  recordTurnMetadata,
  retrieve,
};
