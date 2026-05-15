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
    "相关记忆线索：",
  ];
  const byId = new Map(evidence.concat(graph.nodes || []).map((node) => [node.id, node]));
  const renderedNodeIds = new Set();
  const edgeGroups = groupEdgesByFrom(graph.edges || [], byId);
  for (const group of edgeGroups) {
    lines.push("");
    lines.push(`- ${cleanBundleLine(group.from.text)}`);
    lines.push("  可能联想到：");
    renderedNodeIds.add(group.from.id);
    for (const item of group.items) {
      lines.push(`  - ${cleanBundleLine(item.to.text)}：${cleanBundleLine(item.edge.whyRelevant)}`);
      renderedNodeIds.add(item.to.id);
    }
  }
  const standaloneNodes = Array.from(byId.values()).filter((node) => !renderedNodeIds.has(node.id));
  if (standaloneNodes.length > 0) {
    lines.push("");
    lines.push(edgeGroups.length > 0 ? "其他线索：" : "相关线索：");
    for (const node of standaloneNodes) lines.push(`- ${cleanBundleLine(node.text)}`);
  }
  if (edgeGroups.length === 0 && standaloneNodes.length === 0) {
    lines.push("");
    lines.push("- 暂时没有找到明确相关记忆。");
  }
  lines.push("[/gauzmem_recall]");
  return lines.join("\n");
}

function groupEdgesByFrom(edges, nodesById) {
  const groups = new Map();
  for (const edge of edges || []) {
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    if (!from || !to || !edge.whyRelevant) continue;
    if (!groups.has(from.id)) groups.set(from.id, { from, items: [] });
    const group = groups.get(from.id);
    if (group.items.some((item) => item.to.id === to.id && item.edge.whyRelevant === edge.whyRelevant)) continue;
    group.items.push({ edge, to });
  }
  return Array.from(groups.values()).filter((group) => group.items.length > 0);
}

function cleanBundleLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim().replace(/^[-*]\s+/, "");
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
