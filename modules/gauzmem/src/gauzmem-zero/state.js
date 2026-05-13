"use strict";

const DEFAULT_THRESHOLDS = {
  node: 0.1,
  edge: 0.1,
  aliasCandidate: 0.15,
};

function currentTick(graph) {
  return (graph.runs || []).length + 1;
}

function resolveThresholds(input = {}) {
  return {
    ...DEFAULT_THRESHOLDS,
    ...(input || {}),
  };
}

function sourceTrustFor(sourceRef = {}) {
  const role = sourceRef.role || sourceRef.kind;
  if (role === "assistant") return "assistant";
  if (role === "tool") return "tool";
  if (role === "user") return "user";
  if (sourceRef.kind === "attachment") return "doc";
  if (sourceRef.kind === "file") return sourceRef.role === "code" ? "code" : "doc";
  return "doc";
}

function defaultNodeState(nodeId, tick, reason = "created") {
  return {
    schemaVersion: 1,
    nodeId,
    tick,
    weight: 0.5,
    selectedCount: 0,
    createdTick: tick,
    lastTouchedTick: tick,
    visibility: "active",
    reason,
  };
}

function defaultEdgeState(edgeId, tick, mode = "localAssociation", reason = "created") {
  return {
    schemaVersion: 1,
    edgeId,
    tick,
    weight: mode === "aliasCandidate" ? 0.2 : 0.4,
    selectedCount: 0,
    createdTick: tick,
    lastTouchedTick: tick,
    visibility: "active",
    reason,
  };
}

function effectiveWeight(state, tick) {
  if (!state) return 0;
  if (state.visibility === "dormant") return 0;
  const age = Math.max(0, tick - (state.lastTouchedTick ?? state.tick ?? tick));
  const memoryFactor = 1 + Math.max(0, state.selectedCount || 0);
  return (state.weight || 0) / (1 + age / memoryFactor);
}

function isRetrievableNode(node, graph, options = {}) {
  const tick = options.tick || currentTick(graph);
  const thresholds = resolveThresholds(options.thresholds);
  const state = graph.nodeStateById?.get(node.id);
  const trust = node.sourceTrust || sourceTrustFor(node.sourceRef);
  if ((options.allowedSourceTrust || ["user", "tool", "code", "doc", "assistant"]).includes(trust) === false) {
    return false;
  }
  return effectiveWeight(state, tick) >= thresholds.node;
}

function isRetrievableEdge(edge, graph, options = {}) {
  const tick = options.tick || currentTick(graph);
  const thresholds = resolveThresholds(options.thresholds);
  const state = graph.edgeStateById?.get(edge.id);
  const threshold = edge.mode === "aliasCandidate" ? thresholds.aliasCandidate : thresholds.edge;
  return effectiveWeight(state, tick) >= threshold;
}

function reinforceNodeState(previous, tick, reason = "selected") {
  const base = previous || defaultNodeState("", tick, reason);
  return {
    ...base,
    tick,
    weight: Math.min(2, (base.weight || 0) + 0.12),
    selectedCount: (base.selectedCount || 0) + 1,
    lastTouchedTick: tick,
    visibility: "active",
    reason,
  };
}

function reinforceEdgeState(previous, tick, reason = "selected") {
  const base = previous || defaultEdgeState("", tick, "localAssociation", reason);
  return {
    ...base,
    tick,
    weight: Math.min(2, (base.weight || 0) + 0.08),
    selectedCount: (base.selectedCount || 0) + 1,
    lastTouchedTick: tick,
    visibility: "active",
    reason,
  };
}

function penalizeNodeState(previous, tick, reason = "rejected") {
  if (!previous) return null;
  const weight = Math.max(0, (previous.weight || 0) - 0.01);
  return {
    ...previous,
    tick,
    weight,
    lastTouchedTick: tick,
    visibility: weight <= 0.02 ? "faint" : previous.visibility,
    reason,
  };
}

function penalizeEdgeState(previous, tick, reason = "rejected") {
  if (!previous) return null;
  const weight = Math.max(0, (previous.weight || 0) - 0.03);
  return {
    ...previous,
    tick,
    weight,
    lastTouchedTick: tick,
    visibility: weight < 0.05 ? "faint" : previous.visibility,
    reason,
  };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  currentTick,
  defaultEdgeState,
  defaultNodeState,
  effectiveWeight,
  isRetrievableEdge,
  isRetrievableNode,
  penalizeEdgeState,
  penalizeNodeState,
  reinforceEdgeState,
  reinforceNodeState,
  resolveThresholds,
  sourceTrustFor,
};
