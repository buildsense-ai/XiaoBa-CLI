"use strict";

const { isRetrievableEdge, isRetrievableNode } = require("./state");

function scanGraph(searchPlan, graph, options = {}) {
  const maxHitsPerTerm = options.maxGraphHitsPerTerm || options.budget?.maxGraphHitsPerTerm || 50;
  const excludeNodeIds = new Set(options.excludeNodeIds || []);
  const nodesById = new Map((graph.nodes || []).map((node) => [node.id, node]));
  const seedNodeIds = new Set();
  const seedEdgeIds = new Set();
  const nodeHits = [];
  const edgeHits = [];
  const trace = [];
  for (const termGroup of searchPlan.termGroups || []) {
    const term = String(termGroup.term || "");
    if (!term) continue;
    let nodeHitCount = 0;
    let edgeHitCount = 0;
    for (const node of graph.nodes || []) {
      if (nodeHitCount >= maxHitsPerTerm) break;
      if (excludeNodeIds.has(node.id)) continue;
      if (!isRetrievableNode(node, graph, options)) continue;
      if (!textIncludes(node.text, term)) continue;
      seedNodeIds.add(node.id);
      nodeHits.push({ termId: termGroup.id, term, nodeId: node.id });
      nodeHitCount += 1;
    }
    for (const edge of graph.edges || []) {
      if (edgeHitCount >= maxHitsPerTerm) break;
      if (!isRetrievableEdge(edge, graph, options)) continue;
      if (!textIncludes(edge.whyRelevant, term)) continue;
      const fromNode = nodesById.get(edge.from);
      const toNode = nodesById.get(edge.to);
      if (!fromNode || !toNode) continue;
      const fromRetrievable = !excludeNodeIds.has(edge.from) && isRetrievableNode(fromNode, graph, options);
      const toRetrievable = !excludeNodeIds.has(edge.to) && isRetrievableNode(toNode, graph, options);
      if (!fromRetrievable || !toRetrievable) continue;
      seedEdgeIds.add(edge.id);
      seedNodeIds.add(edge.from);
      seedNodeIds.add(edge.to);
      edgeHits.push({ termId: termGroup.id, term, edgeId: edge.id, from: edge.from, to: edge.to });
      edgeHitCount += 1;
    }
    trace.push({
      termId: termGroup.id,
      pattern: term,
      graphNodeHits: nodeHitCount,
      graphEdgeHits: edgeHitCount,
    });
  }
  return {
    seedNodeIds: Array.from(seedNodeIds),
    seedEdgeIds: Array.from(seedEdgeIds),
    nodeHits,
    edgeHits,
    trace,
  };
}

function discloseGraph(seedNodeIds, graph, options = {}) {
  const maxHops = options.maxGraphHops ?? options.hops ?? 1;
  const maxEdges = options.maxGraphEdges || 24;
  const traversalVisited = options.visited || { nodeIds: new Set(), edgeIds: new Set() };
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const adjacency = new Map();
  for (const edge of graph.edges) {
    if (!isRetrievableEdge(edge, graph, options)) continue;
    const fromNode = nodesById.get(edge.from);
    const toNode = nodesById.get(edge.to);
    if (!fromNode || !toNode) continue;
    if (!isRetrievableNode(fromNode, graph, options) || !isRetrievableNode(toNode, graph, options)) continue;
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency.get(edge.from).push(edge);
    adjacency.get(edge.to).push(edge);
  }

  const seenNodeIds = new Set(
    seedNodeIds.filter((nodeId) => {
      const node = nodesById.get(nodeId);
      return node && isRetrievableNode(node, graph, options);
    }),
  );
  const disclosedEdgeIds = new Set();
  const queue = Array.from(seenNodeIds).map((nodeId) => ({ nodeId, depth: 0 }));
  for (const nodeId of seenNodeIds) traversalVisited.nodeIds?.add(nodeId);
  while (queue.length > 0 && disclosedEdgeIds.size < maxEdges) {
    const { nodeId, depth } = queue.shift();
    if (depth >= maxHops) continue;
    for (const edge of adjacency.get(nodeId) || []) {
      if (disclosedEdgeIds.size >= maxEdges) break;
      if (traversalVisited.edgeIds?.has(edge.id)) continue;
      disclosedEdgeIds.add(edge.id);
      traversalVisited.edgeIds?.add(edge.id);
      const next = edge.from === nodeId ? edge.to : edge.from;
      if (!seenNodeIds.has(next)) {
        seenNodeIds.add(next);
        traversalVisited.nodeIds?.add(next);
        queue.push({ nodeId: next, depth: depth + 1 });
      }
    }
  }

  return {
    nodes: Array.from(seenNodeIds).map((id) => nodesById.get(id)).filter(Boolean),
    edges: graph.edges.filter((edge) => disclosedEdgeIds.has(edge.id)),
  };
}

function textIncludes(text, term) {
  return String(text || "").toLowerCase().includes(String(term || "").toLowerCase());
}

function buildPromptBundle(input = {}) {
  const evidence = input.evidence || [];
  const graph = input.disclosedGraph || { nodes: [], edges: [] };
  const lines = [
    "[gauzmem_recall]",
    `query: ${input.query}`,
    "discipline: This is source-grounded retrieved memory. Use evidence only after checking source refs. Do not treat associations as facts.",
    "",
    "evidence:",
  ];
  const byId = new Map(evidence.concat(graph.nodes || []).map((node) => [node.id, node]));
  let index = 1;
  for (const node of byId.values()) {
    lines.push(`${index}. ${node.id}: ${node.text}`);
    lines.push(`   source: ${formatSourceRef(node.sourceRef)}`);
    index += 1;
  }
  if ((graph.edges || []).length > 0) {
    lines.push("");
    lines.push("associations:");
    for (const edge of graph.edges) {
      lines.push(`- ${edge.from} -> ${edge.to}: ${edge.whyRelevant}`);
    }
  }
  lines.push("[/gauzmem_recall]");
  return lines.join("\n");
}

function formatSourceRef(sourceRef) {
  if (!sourceRef) return "unknown";
  if (sourceRef.kind === "conversation") {
    return `${sourceRef.kind}:${sourceRef.sessionType}/${sourceRef.sessionId} ${sourceRef.logPath}:${sourceRef.jsonlLine} ${sourceRef.fieldPath}[${sourceRef.charStart}:${sourceRef.charEnd}]`;
  }
  if (sourceRef.kind === "attachment") {
    return `${sourceRef.kind}:${sourceRef.originalPath} text=${sourceRef.extractedTextPath}[${sourceRef.charStart}:${sourceRef.charEnd}]`;
  }
  return JSON.stringify(sourceRef);
}

module.exports = {
  buildPromptBundle,
  discloseGraph,
  formatSourceRef,
  scanGraph,
};
