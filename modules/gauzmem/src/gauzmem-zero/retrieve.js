"use strict";

const { performance } = require("perf_hooks");
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
  const timing = createTimingRecorder();
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

  const rootSearchPlan = await timing.step("root_search_plan", () => createReasonedSearchPlan({ query, input, budget, reasoner }), {
    reasoner: reasoner.constructor.name,
  });
  const graphBefore = await timing.step("load_graph_initial", () => loadGraphWithState(storeRoot));
  const tick = currentTick(graphBefore);
  const graphOptions = { budget, thresholds, tick };
  const sourceRootPaths = sourceRootsForInput(input);
  const hasSourceRoots = sourceRootPaths.length > 0;
  const traversalVisited = { nodeIds: new Set(), edgeIds: new Set() };
  const graphQueue = [];
  const queuedGraphNodeIds = new Set();
  const constructQueue = [];
  const queuedConstructKeys = new Set();
  const graphDiscloseCountByNode = new Map();
  const constructAttemptByFrontier = new Map();
  const selectedNodeIdsSet = new Set();
  const selectedEdgeIdsSet = new Set();
  const rejectedNodeIdsSet = new Set();
  const rejectedEdgeIdsSet = new Set();
  const disclosedNodeById = new Map();
  const disclosedEdgeById = new Map();
  const createdNodeById = new Map();
  const createdEdgeById = new Map();
  const sourceEvidenceById = new Map();
  const constructIncomingByTarget = new Map();
  const graphMatch = {
    seedNodeIds: [],
    seedEdgeIds: [],
    nodeHits: [],
    edgeHits: [],
    trace: [],
  };
  const sourceTrace = [];
  let docs = [];
  let docsLoaded = false;
  let hits = [];
  let windows = [];
  let constructEdges = [];
  let frontierSteps = 0;
  let graphFrontierSteps = 0;
  let sourceConstructCount = 0;
  let nodeConstructCount = 0;
  let rootConstructCount = 0;
  let graphDisclosureCount = 0;

  function enqueueGraphNode(node, origin, options = {}) {
    if (!node?.id) return;
    if (!options.force && (graphDiscloseCountByNode.get(node.id) || 0) >= budget.maxGraphDiscloseAttemptsPerNode) return;
    if (queuedGraphNodeIds.has(node.id)) return;
    if (graphQueue.length >= budget.maxFrontierNodes) return;
    queuedGraphNodeIds.add(node.id);
    graphQueue.push({ type: "node", node, origin });
  }

  function enqueueConstructFrontier(frontier, reason) {
    if (!frontier?.node) return;
    if (frontier.type === "root" && rootConstructCount >= budget.maxRootConstructAttempts) return;
    const key = frontier.type === "root" ? "root_query" : frontier.node.id;
    if ((constructAttemptByFrontier.get(key) || 0) >= budget.maxConstructAttemptsPerNode) return;
    if (queuedConstructKeys.has(key)) return;
    if (constructQueue.length >= budget.maxFrontierNodes) return;
    queuedConstructKeys.add(key);
    constructQueue.push({ ...frontier, reason });
  }

  function rememberGraphMatch(match) {
    for (const id of match.seedNodeIds || []) if (!graphMatch.seedNodeIds.includes(id)) graphMatch.seedNodeIds.push(id);
    for (const id of match.seedEdgeIds || []) if (!graphMatch.seedEdgeIds.includes(id)) graphMatch.seedEdgeIds.push(id);
    graphMatch.nodeHits.push(...(match.nodeHits || []));
    graphMatch.edgeHits.push(...(match.edgeHits || []));
    graphMatch.trace.push(...(match.trace || []));
  }

  function rememberDisclosure(disclosure) {
    for (const node of disclosure.nodes || []) disclosedNodeById.set(node.id, node);
    for (const edge of disclosure.edges || []) disclosedEdgeById.set(edge.id, edge);
  }

  function rememberSelection(selection, graph, options = {}) {
    const previousNodeIds = new Set(selectedNodeIdsSet);
    const previousEdgeIds = new Set(selectedEdgeIdsSet);
    for (const id of selection.selectedNodeIds || []) selectedNodeIdsSet.add(id);
    for (const id of selection.selectedEdgeIds || []) selectedEdgeIdsSet.add(id);
    for (const id of selection.rejectedNodeIds || []) rejectedNodeIdsSet.add(id);
    for (const id of selection.rejectedEdgeIds || []) rejectedEdgeIdsSet.add(id);
    const selectedEdges = idsToEdges(selection.selectedEdgeIds || [], graph);
    let addedRoute = false;
    for (const id of selection.selectedNodeIds || []) {
      if (id !== options.excludeNodeId && !previousNodeIds.has(id)) addedRoute = true;
    }
    for (const id of selection.selectedEdgeIds || []) {
      if (!previousEdgeIds.has(id)) addedRoute = true;
    }
    if (options.enqueue !== false) {
      for (const node of idsToNodes(selection.selectedNodeIds || [], graph)) {
        if (node.id !== options.excludeNodeId) enqueueGraphNode(node, "selected");
      }
      for (const edge of selectedEdges) {
        for (const node of idsToNodes([edge.from, edge.to], graph)) {
          if (node.id !== options.excludeNodeId) enqueueGraphNode(node, "selected_edge");
        }
      }
    }
    return { addedRoute };
  }

  function currentGraphSufficient() {
    const graph = loadGraphWithState(storeRoot);
    const selectedNodeIds = Array.from(selectedNodeIdsSet);
    const selectedEdgeIds = Array.from(selectedEdgeIdsSet);
    return isGraphSufficient({
      searchPlan: rootSearchPlan,
      selectedNodes: idsToNodes(selectedNodeIds, graph),
      selectedEdges: idsToEdges(selectedEdgeIds, graph),
      selectedNodeCount: selectedNodeIds.length,
      selectedEdgeCount: selectedEdgeIds.length,
      budget,
    });
  }

  let initialSeedNodes = [];
  if (energy.consume("graph_scan", 1)) {
    const initialGraph = await timing.step("graph_scan_load_graph", () => loadGraphWithState(storeRoot));
    const initialGraphMatch = await timing.step("graph_scan_initial", () => scanGraph(rootSearchPlan, initialGraph, graphOptions));
    rememberGraphMatch(initialGraphMatch);
    initialSeedNodes = idsToNodes(initialGraphMatch.seedNodeIds, initialGraph);
    if (initialGraphMatch.seedNodeIds.length > 0 && energy.consume("graph_disclose", 1)) {
      const initialDisclosure = await timing.step("graph_disclose_initial", () => discloseGraph(initialGraphMatch.seedNodeIds, initialGraph, {
        ...graphOptions,
        maxGraphHops: budget.maxGraphHops,
        maxGraphEdges: budget.maxGraphEdges,
        visited: traversalVisited,
      }), { seedNodeCount: initialGraphMatch.seedNodeIds.length });
      graphDisclosureCount += 1;
      rememberDisclosure(initialDisclosure);
      if (energy.consume("root_relevance_graph", 4)) {
        const initialSelection = await timing.step("llm_root_relevance_initial_graph", () => reasoner.selectRootRelevant({
          query,
          nodes: initialDisclosure.nodes,
          edges: initialDisclosure.edges,
          minSelected: 0,
          allowEmpty: true,
          allowReject: true,
        }), {
          nodeCount: initialDisclosure.nodes.length,
          edgeCount: initialDisclosure.edges.length,
        });
        rememberSelection(initialSelection, initialGraph);
      }
    }
  }

  const initialGraphAfterGate = await timing.step("graph_sufficiency_load_graph", () => loadGraphWithState(storeRoot));
  const initialGraphWasUseful = selectedNodeIdsSet.size > 0;
  const initialGraphWasSufficient = isGraphSufficient({
    searchPlan: rootSearchPlan,
    selectedNodes: idsToNodes(Array.from(selectedNodeIdsSet), initialGraphAfterGate),
    selectedEdges: idsToEdges(Array.from(selectedEdgeIdsSet), initialGraphAfterGate),
    selectedNodeCount: selectedNodeIdsSet.size,
    selectedEdgeCount: selectedEdgeIdsSet.size,
    budget,
  });
  if (!initialGraphWasUseful && initialSeedNodes.length > 0) {
    for (const node of initialSeedNodes) {
      enqueueConstructFrontier({ type: "node", node, origin: "graph_seed" }, "graph_seed_not_selected");
    }
  }

  async function processGraphFrontier(frontier) {
    if (frontier.type !== "node") return;
    return timing.step("graph_frontier_step", async () => {
    const nodeId = frontier.node.id;
    const discloseCount = graphDiscloseCountByNode.get(nodeId) || 0;
    if (discloseCount >= budget.maxGraphDiscloseAttemptsPerNode) return;
    graphDiscloseCountByNode.set(nodeId, discloseCount + 1);
    graphFrontierSteps += 1;
    const graphForWalk = await timing.step("graph_frontier_load_graph", () => loadGraphWithState(storeRoot), { nodeId });
    if (!energy.consume("graph_disclose", 1)) return;
    const disclosure = await timing.step("graph_frontier_disclose", () => discloseGraph([nodeId], graphForWalk, {
      ...graphOptions,
      maxGraphHops: budget.maxGraphHops,
      maxGraphEdges: budget.maxGraphEdges,
      visited: traversalVisited,
    }), { nodeId });
    graphDisclosureCount += 1;
    rememberDisclosure(disclosure);

    if (disclosure.edges.length === 0) {
      enqueueConstructFrontier(frontier, "graph_no_unvisited_edge");
      return;
    }

    if (energy.consume("root_relevance_graph", 4)) {
      const selection = await timing.step("llm_graph_frontier_relevance", () => reasoner.selectRootRelevant({
        query,
        nodes: disclosure.nodes,
        edges: disclosure.edges,
        minSelected: 0,
        allowEmpty: true,
        allowReject: true,
      }), {
        nodeId,
        nodeCount: disclosure.nodes.length,
        edgeCount: disclosure.edges.length,
      });
      const selectionResult = rememberSelection(selection, graphForWalk, { excludeNodeId: nodeId });
      if (!selectionResult.addedRoute) {
        enqueueConstructFrontier(frontier, "graph_no_selected_next");
      }
    }
    }, {
      nodeId: frontier.node.id,
      origin: frontier.origin,
    });
  }

  async function processConstructFrontier(frontier) {
    return timing.step("construct_frontier_step", async () => {
    if (!hasSourceRoots) return;
    const frontierKey = frontier.type === "root" ? "root_query" : frontier.node.id;
    const attemptCount = constructAttemptByFrontier.get(frontierKey) || 0;
    if (attemptCount >= budget.maxConstructAttemptsPerNode) return;
    if (frontier.type === "root" && rootConstructCount >= budget.maxRootConstructAttempts) return;
    constructAttemptByFrontier.set(frontierKey, attemptCount + 1);
    sourceConstructCount += 1;
    if (frontier.type === "root") rootConstructCount += 1;
    else nodeConstructCount += 1;

    if (!energy.consume("source_grep", 3)) return;
    if (!docsLoaded) {
      docs = await timing.step("source_docs_load", () => loadSearchDocs({
        rootPaths: sourceRootPaths,
        storeRoot,
      }), {
        rootCount: sourceRootPaths.length,
      });
      docsLoaded = true;
    }
    const parent = frontier.node;
    const parentSearchPlan = frontier.type === "root"
      ? rootSearchPlan
      : await timing.step("construct_search_plan", () => createReasonedSearchPlan({ query, input, budget, reasoner, parent }), {
        frontierType: frontier.type,
        parentNodeId: parent.id,
      });
    const stepHits = await timing.step("source_search", () => scanDocs(docs, parentSearchPlan, { budget }), {
      frontierType: frontier.type,
      parentNodeId: frontier.type === "node" ? parent.id : undefined,
      docCount: docs.length,
    });
    hits.push(...stepHits);
    const stepWindows = await timing.step("source_windows", () => buildSourceWindowsFromHits(stepHits, {
      budget,
      maxEvidence: budget.maxWindows,
      maxEvidenceChars: budget.maxEvidenceChars,
    }), {
      hitCount: stepHits.length,
    });
    windows.push(...stepWindows);

    let stepEvidence = [];
    if (stepWindows.length > 0 && energy.consume("llm_extract_evidence", 6)) {
      const extractionQuery = frontier.type === "root" ? query : (parent.text || query);
      const extracted = await timing.step("llm_extract_evidence", () => reasoner.extractEvidence({
        query: extractionQuery,
        rootQuery: query,
        parent,
        windows: stepWindows,
        maxEvidence: budget.maxEvidence,
      }), {
        frontierType: frontier.type,
        parentNodeId: frontier.type === "node" ? parent.id : undefined,
        windowCount: stepWindows.length,
      });
      stepEvidence = evidenceNodesFromWindowEvidence(extracted, stepWindows, {
        timestamp,
        budget,
        maxEvidence: budget.maxEvidence,
        runId,
      });
    }
    if (stepEvidence.length === 0) {
      stepEvidence = extractEvidenceFromHits(stepHits, {
        timestamp,
        budget,
        maxEvidence: budget.maxEvidence,
        runId,
      });
    }
    stepEvidence = stepEvidence.filter((node) => node.id !== parent.id);
    for (const node of stepEvidence) sourceEvidenceById.set(node.id, node);
    sourceTrace.push(...searchTrace(parentSearchPlan, stepHits, stepEvidence).map((entry) => ({
      ...entry,
      termId: `${frontierKey}:${entry.termId}`,
      phase: "source_construct",
      parentNodeId: frontier.type === "node" ? frontier.node.id : undefined,
      parent: frontier.type,
      constructReason: frontier.reason,
    })));

    if (stepEvidence.length === 0) return;
    const graphBeforeNodeWrites = await timing.step("construct_load_graph_before_nodes", () => loadGraphWithState(storeRoot));
    const stepCreatedNodes = await timing.step("persist_construct_nodes", () => upsertNodes(storeRoot, stepEvidence), {
      evidenceCount: stepEvidence.length,
    });
    for (const node of stepCreatedNodes) createdNodeById.set(node.id, node);
    await timing.step("persist_initial_node_states", () => appendInitialNodeStates(storeRoot, graphBeforeNodeWrites, stepEvidence, tick), {
      evidenceCount: stepEvidence.length,
    });

    if (frontier.type === "root") {
      if (energy.consume("root_relevance_graph", 4)) {
        const selection = await timing.step("llm_root_relevance_construct", () => reasoner.selectRootRelevant({
          query,
          nodes: stepEvidence,
          edges: [],
          minSelected: 0,
          allowEmpty: true,
          allowReject: true,
        }), {
          evidenceCount: stepEvidence.length,
        });
        rememberSelection(selection, { nodes: stepEvidence, edges: [] });
      }
      return;
    }

    if (energy.consume("write_local_edges", 6)) {
      const graphForWalk = await timing.step("construct_load_graph_before_edges", () => loadGraphWithState(storeRoot));
      const candidateEdges = await timing.step("llm_write_local_edges", () => createConstructEdges({
        query,
        runId,
        timestamp,
        reasoner,
        parents: [frontier.node],
        sourceNodes: stepEvidence,
        existingEdges: graphForWalk.edges,
        maxEdges: Math.max(0, budget.maxRunEdges - constructEdges.length),
        maxParents: 1,
        maxIncomingEdgesPerRun: budget.maxIncomingConstructEdgesPerRun,
      }), {
        parentNodeId: frontier.node.id,
        sourceNodeCount: stepEvidence.length,
      });
      const stepConstructEdges = [];
      for (const edge of candidateEdges) {
        const incomingCount = constructIncomingByTarget.get(edge.to) || 0;
        if (incomingCount >= budget.maxIncomingConstructEdgesPerRun) continue;
        if (constructEdges.length + stepConstructEdges.length >= budget.maxRunEdges) break;
        stepConstructEdges.push(edge);
        constructIncomingByTarget.set(edge.to, incomingCount + 1);
      }
      constructEdges.push(...stepConstructEdges);
      const stepCreatedEdges = await timing.step("persist_construct_edges", () => upsertEdges(storeRoot, stepConstructEdges), {
        edgeCount: stepConstructEdges.length,
      });
      for (const edge of stepCreatedEdges) createdEdgeById.set(edge.id, edge);
      const graphAfterEdges = await timing.step("construct_load_graph_after_edges", () => loadGraphWithState(storeRoot));
      await timing.step("persist_initial_edge_states", () => appendInitialEdgeStates(storeRoot, graphAfterEdges, stepCreatedEdges, tick), {
        edgeCount: stepCreatedEdges.length,
      });
      if (stepCreatedEdges.length > 0) {
        enqueueGraphNode(frontier.node, "construct_refresh", { force: true });
      }
    }
    }, {
      frontierType: frontier.type,
      parentNodeId: frontier.type === "node" ? frontier.node.id : undefined,
      reason: frontier.reason,
    });
  }

  while (frontierSteps < budget.maxFrontierSteps && energy.remaining > 0) {
    if (graphQueue.length > 0) {
      const frontier = graphQueue.shift();
      queuedGraphNodeIds.delete(frontier.node.id);
      frontierSteps += 1;
      await processGraphFrontier(frontier);
      continue;
    }

    if (!hasSourceRoots) break;
    if (!budget.forceConstruct && currentGraphSufficient()) break;

    if (constructQueue.length > 0) {
      const frontier = constructQueue.shift();
      const key = frontier.type === "root" ? "root_query" : frontier.node.id;
      queuedConstructKeys.delete(key);
      frontierSteps += 1;
      await processConstructFrontier(frontier);
      continue;
    }

    if (rootConstructCount < budget.maxRootConstructAttempts) {
      frontierSteps += 1;
      await processConstructFrontier({
        type: "root",
        node: { id: "root_query", query },
        origin: "root",
        reason: graphMatch.seedNodeIds.length > 0 ? "graph_exhausted" : "cold_start",
      });
      continue;
    }

    break;
  }

  const selectedNodeIds = uniqueIds(Array.from(selectedNodeIdsSet));
  const selectedEdgeIds = uniqueIds(Array.from(selectedEdgeIdsSet));
  const createdNodes = Array.from(createdNodeById.values());
  const createdEdges = Array.from(createdEdgeById.values());
  const returnedConstructEdges = createdEdges;
  const createdEdgeIds = createdEdges.map((edge) => edge.id);
  const selectedCreatedEdgeIds = createdEdgeIds.filter((edgeId) => selectedEdgeIds.includes(edgeId));
  const returnedEdgeIds = uniqueIds(selectedEdgeIds);
  const rejectedNodeIds = uniqueIds(Array.from(rejectedNodeIdsSet));
  const rejectedEdgeIds = uniqueIds(Array.from(rejectedEdgeIdsSet));

  const graphAfterWrites = await timing.step("load_graph_before_state_updates", () => loadGraphWithState(storeRoot));
  await timing.step("persist_state_updates", () => appendStateUpdates(storeRoot, graphAfterWrites, {
    tick,
    selectedNodeIds,
    selectedEdgeIds,
    rejectedNodeIds,
    rejectedEdgeIds,
  }), {
    selectedNodeCount: selectedNodeIds.length,
    selectedEdgeCount: selectedEdgeIds.length,
  });

  const graphFinal = await timing.step("load_graph_final", () => loadGraphWithState(storeRoot));
  const evidence = idsToNodes(selectedNodeIds, graphFinal);
  const finalGraphWasSufficient = isGraphSufficient({
    searchPlan: rootSearchPlan,
    selectedNodes: evidence,
    selectedEdges: idsToEdges(selectedEdgeIds, graphFinal),
    selectedNodeCount: evidence.length,
    selectedEdgeCount: selectedEdgeIds.length,
    budget,
  });
  const promptGraph = filterGraphForPrompt({
    graph: graphFinal,
    disclosedGraph: {
      nodes: Array.from(disclosedNodeById.values()),
      edges: Array.from(disclosedEdgeById.values()),
    },
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
    createdEdgeIds: selectedCreatedEdgeIds,
  };
  const trace = mergeTrace(graphMatch.trace, sourceTrace);
  const retrieveMode = sourceConstructCount > 0
    ? (graphMatch.seedNodeIds.length > 0 ? "graph_then_construct" : "source_construct")
    : "graph_first";
  const run = {
    runId,
    query,
    timestamp,
    callType: input.callType || "passive",
    searchPlan: rootSearchPlan,
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
      sourceEvidenceCount: sourceEvidenceById.size,
      graphSeedCount: graphMatch.seedNodeIds.length,
      graphEdgeSeedCount: graphMatch.seedEdgeIds.length,
      constructedNodeCount: createdNodes.length,
      constructedEdgeCount: createdEdges.length,
      constructCandidateEdgeCount: constructEdges.length,
      edgeCount: returnedEdgeIds.length,
      graphWasSufficient: initialGraphWasSufficient,
      finalGraphWasSufficient,
      retrieveAlgorithm: "frontier_loop_v0.2",
      frontierSteps,
      graphFrontierSteps,
      sourceConstructCount,
      nodeConstructCount,
      rootConstructCount,
      graphDisclosureCount,
      constructAttemptCount: Array.from(constructAttemptByFrontier.values()).reduce((sum, count) => sum + count, 0),
      promptCharCount: promptBundle.length,
      promptTruncated: promptBundle.length < rawPromptBundle.length,
      energyInitial: budget.energy,
      energyRemaining: energy.remaining,
      energyTrace: energy.trace,
      reasoner: reasoner.constructor.name,
    },
  };
  const runEndedAt = new Date().toISOString();
  const runDurationMs = timing.totalDurationMs();
  run.startedAt = timing.startedAt;
  run.endedAt = runEndedAt;
  run.durationMs = runDurationMs;
  run.timings = timing.entries();
  run.stats.durationMs = runDurationMs;
  run.stats.timingCount = run.timings.length;

  appendRun(storeRoot, run);
  const runEvents = buildEvents({
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
    returnedEdgeIds,
    rejectedNodeIds,
    rejectedEdgeIds,
  });
  appendEvents(storeRoot, runEvents);

  return {
    runId,
    query,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
    timings: run.timings,
    searchPlan: rootSearchPlan,
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

function createTimingRecorder() {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const timings = [];

  async function step(stepName, task, metadata = {}) {
    const stepStarted = performance.now();
    try {
      return await task();
    } finally {
      timings.push(cleanTiming({
        step: stepName,
        durationMs: elapsedMs(stepStarted),
        ...metadata,
      }));
    }
  }

  return {
    startedAt,
    step,
    entries: () => timings.slice(),
    totalDurationMs: () => elapsedMs(started),
  };
}

function elapsedMs(started) {
  return Math.max(0, Math.round(performance.now() - started));
}

function cleanTiming(timing) {
  const out = {};
  for (const [key, value] of Object.entries(timing)) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    out[key] = value;
  }
  return out;
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
  const defaultEnergy = callType === "tool_search" ? 96 : 64;
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
    maxFrontierSteps: raw.maxFrontierSteps ?? (callType === "tool_search" ? 12 : 8),
    maxFrontierNodes: raw.maxFrontierNodes ?? (callType === "tool_search" ? 16 : 10),
    maxConstructAttemptsPerNode: raw.maxConstructAttemptsPerNode ?? 2,
    maxGraphDiscloseAttemptsPerNode: raw.maxGraphDiscloseAttemptsPerNode ?? 3,
    maxRootConstructAttempts: raw.maxRootConstructAttempts ?? 1,
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
  const selectedCreatedEdgeIds = (run.createdEdgeIds || []).filter((edgeId) => (run.selectedEdgeIds || []).includes(edgeId));
  return {
    runId: run.runId,
    query: run.query,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
    timings: run.timings || [],
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
      createdEdgeIds: selectedCreatedEdgeIds,
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

async function createReasonedSearchPlan({ query, input, budget, reasoner, parent }) {
  const parentText = parent?.text || "";
  const isLocalParent = Boolean(parentText && parent?.id !== "root_query");
  const queryText = isLocalParent ? parentText : query;
  const explicitTerms = isLocalParent ? [] : (input.searchTerms || []);
  const basePlan = createSearchPlan({
    query: queryText,
    searchTerms: explicitTerms,
    maxTerms: budget.maxTerms,
    budget,
  });
  const baseTerms = basePlan.termGroups.map((group) => group.term);
  const reasonedTerms = await reasoner.generateSearchTerms({
    query: queryText,
    rootQuery: query,
    parent,
    explicitTerms,
    maxTerms: budget.maxTerms,
  });
  const searchPlan = createSearchPlan({
    query: queryText,
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
  const disclosedEdges = input.disclosedGraph.edges || [];
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
  for (const edgeId of input.returnedEdgeIds || []) {
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
  const merged = (graphTrace || []).map((entry) => {
    const source = (sourceTrace || []).find((item) => item.termId === entry.termId);
    return {
      ...entry,
      sourceHitCount: source?.hitCount || 0,
      sourceEvidenceCount: source?.evidenceCount || 0,
    };
  });
  const graphTermIds = new Set(merged.map((entry) => entry.termId));
  for (const entry of sourceTrace || []) {
    if (graphTermIds.has(entry.termId)) continue;
    merged.push({
      ...entry,
      graphNodeHits: entry.graphNodeHits || 0,
      graphEdgeHits: entry.graphEdgeHits || 0,
      sourceHitCount: entry.hitCount || entry.sourceHitCount || 0,
      sourceEvidenceCount: entry.evidenceCount || entry.sourceEvidenceCount || 0,
    });
  }
  return merged;
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
