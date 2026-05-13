"use strict";

const fs = require("fs");
const path = require("path");

const { stableHash } = require("../utils/text");

const DEFAULT_STORE_ROOT = ".gauzmem-zero";
const storeWriteQueues = new Map();

function resolveStoreRoot(storeRoot) {
  return path.resolve(storeRoot || DEFAULT_STORE_ROOT);
}

function storePaths(storeRoot) {
  const root = resolveStoreRoot(storeRoot);
  return {
    root,
    nodesFile: path.join(root, "nodes.jsonl"),
    edgesFile: path.join(root, "edges.jsonl"),
    nodeStateFile: path.join(root, "node_state.jsonl"),
    edgeStateFile: path.join(root, "edge_state.jsonl"),
    runsFile: path.join(root, "runs.jsonl"),
    eventsFile: path.join(root, "events.jsonl"),
    turnMetadataFile: path.join(root, "turn_metadata.jsonl"),
    attachmentsFile: path.join(root, "attachments.jsonl"),
    attachmentTextDir: path.join(root, "attachment-text"),
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function ensureStore(storeRoot) {
  const paths = storePaths(storeRoot);
  ensureDir(paths.root);
  ensureDir(paths.attachmentTextDir);
  for (const file of [
    paths.nodesFile,
    paths.edgesFile,
    paths.nodeStateFile,
    paths.edgeStateFile,
    paths.runsFile,
    paths.eventsFile,
    paths.turnMetadataFile,
    paths.attachmentsFile,
  ]) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, "", "utf8");
  }
  return paths;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const out = [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      appendJsonl(`${filePath}.bad`, {
        filePath,
        lineNumber: index + 1,
        line,
        quarantinedAt: new Date().toISOString(),
      });
    }
  }
  return out;
}

function appendJsonl(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function sourceIdentity(sourceRef) {
  if (!sourceRef) return "";
  if (sourceRef.kind === "conversation") {
    return [
      sourceRef.kind,
      sourceRef.logPath,
      sourceRef.jsonlLine,
      sourceRef.fieldPath,
      sourceRef.toolCallId || "",
      sourceRef.charStart,
      sourceRef.charEnd,
    ].join(":");
  }
  if (sourceRef.kind === "attachment") {
    return [
      sourceRef.kind,
      sourceRef.originalPath,
      sourceRef.extractedTextPath,
      sourceRef.charStart,
      sourceRef.charEnd,
    ].join(":");
  }
  return JSON.stringify(sourceRef);
}

function evidenceNodeId(input) {
  return `gzn_${stableHash(`${sourceIdentity(input.sourceRef)}:${input.text || ""}`)}`;
}

function evidenceEdgeId(from, to) {
  return `gze_${stableHash(`localAssociation:${from || ""}->${to || ""}`)}`;
}

function runIdFor(query, timestamp) {
  return `gzr_${stableHash(`${timestamp || ""}:${query || ""}`)}`;
}

function loadGraph(storeRoot) {
  const paths = ensureStore(storeRoot);
  return {
    paths,
    nodes: readJsonl(paths.nodesFile),
    edges: readJsonl(paths.edgesFile),
    nodeStates: readJsonl(paths.nodeStateFile),
    edgeStates: readJsonl(paths.edgeStateFile),
    runs: readJsonl(paths.runsFile),
    events: readJsonl(paths.eventsFile),
    turnMetadata: readJsonl(paths.turnMetadataFile),
    attachments: readJsonl(paths.attachmentsFile),
  };
}

function upsertNodes(storeRoot, nodes) {
  const paths = ensureStore(storeRoot);
  const existing = new Set(readJsonl(paths.nodesFile).map((node) => node.id));
  const created = [];
  for (const node of nodes) {
    if (existing.has(node.id)) continue;
    appendJsonl(paths.nodesFile, node);
    existing.add(node.id);
    created.push(node);
  }
  return created;
}

function upsertEdges(storeRoot, edges) {
  const paths = ensureStore(storeRoot);
  const existing = new Set(readJsonl(paths.edgesFile).map((edge) => edge.id));
  const created = [];
  for (const edge of edges) {
    if (existing.has(edge.id)) continue;
    appendJsonl(paths.edgesFile, edge);
    existing.add(edge.id);
    created.push(edge);
  }
  return created;
}

function appendRun(storeRoot, run) {
  const paths = ensureStore(storeRoot);
  appendJsonl(paths.runsFile, run);
  return run;
}

function appendEvents(storeRoot, events) {
  const paths = ensureStore(storeRoot);
  for (const event of events) appendJsonl(paths.eventsFile, event);
  return events;
}

function appendNodeStates(storeRoot, states) {
  const paths = ensureStore(storeRoot);
  for (const state of states) appendJsonl(paths.nodeStateFile, state);
  return states;
}

function appendEdgeStates(storeRoot, states) {
  const paths = ensureStore(storeRoot);
  for (const state of states) appendJsonl(paths.edgeStateFile, state);
  return states;
}

function appendTurnMetadata(storeRoot, metadata) {
  const paths = ensureStore(storeRoot);
  appendJsonl(paths.turnMetadataFile, metadata);
  return metadata;
}

function withStoreWriteLock(storeRoot, task) {
  const root = resolveStoreRoot(storeRoot);
  const previous = storeWriteQueues.get(root) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  storeWriteQueues.set(root, current.catch(() => {}).finally(() => {
    if (storeWriteQueues.get(root) === current) {
      storeWriteQueues.delete(root);
    }
  }));
  return current;
}

function latestById(items, idField) {
  const out = new Map();
  for (const item of items || []) out.set(item[idField], item);
  return out;
}

function loadGraphWithState(storeRoot) {
  const graph = loadGraph(storeRoot);
  return {
    ...graph,
    nodeStateById: latestById(graph.nodeStates, "nodeId"),
    edgeStateById: latestById(graph.edgeStates, "edgeId"),
  };
}

function registerAttachment(storeRoot, input = {}) {
  const paths = ensureStore(storeRoot);
  const timestamp = input.timestamp || new Date().toISOString();
  const originalPath = input.path || input.originalPath;
  if (!originalPath) throw new Error("attachment path is required");
  const attachmentId = safeAttachmentId(input.attachmentId || `gza_${stableHash(`${timestamp}:${originalPath}`)}`);
  const externalTextPath = input.extractedTextPath || input.textPath;
  const textRoot = path.resolve(paths.attachmentTextDir);
  const extractedTextPath = path.resolve(textRoot, `${attachmentId}.txt`);
  if (extractedTextPath !== textRoot && !extractedTextPath.startsWith(`${textRoot}${path.sep}`)) {
    throw new Error("attachmentId is not allowed");
  }
  if (input.text) {
    fs.writeFileSync(extractedTextPath, String(input.text), "utf8");
  } else if (externalTextPath) {
    if (!fs.existsSync(externalTextPath)) {
      throw new Error(`attachment extracted text not found: ${externalTextPath}`);
    }
    fs.copyFileSync(externalTextPath, extractedTextPath);
  } else {
    throw new Error("attachment text or extractedTextPath is required");
  }
  const record = {
    attachmentId,
    agent: input.agent || "xiaoba",
    sessionType: input.sessionType || input.metadata?.sessionType,
    sessionId: input.sessionId || input.metadata?.sessionId,
    turn: input.turn || input.metadata?.turn,
    timestamp,
    fileName: input.fileName || input.metadata?.fileName || path.basename(originalPath),
    mimeType: input.mimeType || input.metadata?.mimeType,
    originalPath: path.resolve(originalPath),
    extractedTextPath: path.resolve(extractedTextPath),
    metadata: {
      ...(input.metadata || {}),
      ...(externalTextPath ? { sourceExtractedTextPath: path.resolve(externalTextPath) } : {}),
    },
  };
  appendJsonl(paths.attachmentsFile, record);
  appendJsonl(paths.eventsFile, {
    eventId: `${attachmentId}:source_registered`,
    targetType: "attachment",
    targetId: attachmentId,
    eventType: "source_registered",
    timestamp,
  });
  return record;
}

function safeAttachmentId(raw) {
  const value = String(raw || "").trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error("attachmentId is not allowed");
  }
  return value;
}

module.exports = {
  DEFAULT_STORE_ROOT,
  appendEdgeStates,
  appendEvents,
  appendNodeStates,
  appendRun,
  appendJsonl,
  appendTurnMetadata,
  ensureStore,
  evidenceEdgeId,
  evidenceNodeId,
  loadGraph,
  loadGraphWithState,
  readJsonl,
  registerAttachment,
  resolveStoreRoot,
  runIdFor,
  storePaths,
  upsertEdges,
  upsertNodes,
  withStoreWriteLock,
};
