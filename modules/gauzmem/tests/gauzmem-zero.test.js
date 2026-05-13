"use strict";

process.env.GAUZMEM_LLM_API_KEY = "";
process.env.GAUZMEM_LLM_BASE_URL = "";
process.env.GAUZMEM_LLM_MODEL = "";
process.env.GAUZMEM_LLM_TIMEOUT_MS = "";
process.env.GAUZ_LLM_API_KEY = "";
process.env.GAUZ_LLM_API_BASE = "";
process.env.GAUZ_LLM_MODEL = "";
process.env.GAUZ_LLM_TIMEOUT_MS = "";
process.env.GAUZMEM_ALLOWED_ROOTS = "";
process.env.GAUZMEM_HTTP_TOKEN = "";
process.env.GAUZMEM_AUTH_TOKEN = "";
process.env.GAUZMEM_TOKEN = "";

const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");

const {
  appendEdgeStates,
  appendNodeStates,
  AnthropicCompatibleReasoner,
  createReasoner,
  defaultEdgeState,
  defaultNodeState,
  DeterministicReasoner,
  evidenceEdgeId,
  findCaseInsensitiveMatches,
  loadSearchDocs,
  loadGraph,
  listen,
  parseXiaoBaLogFile,
  recordFeedback,
  registerAttachment,
  retrieve,
  storePaths,
  upsertEdges,
  upsertNodes,
} = require("../src/gauzmem-zero");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJsonl(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8");
}

function turn(overrides = {}) {
  return {
    entry_type: "turn",
    turn: overrides.turn || 1,
    timestamp: overrides.timestamp || "2026-05-06T00:00:00.000Z",
    session_id: overrides.session_id || "cli",
    session_type: overrides.session_type || "chat",
    user: { text: overrides.user || "" },
    assistant: {
      text: overrides.assistant || "",
      tool_calls: overrides.tool_calls || [],
    },
    tokens: { prompt: 1, completion: 1 },
  };
}

function postJson(url, body) {
  return postJsonWithHeaders(url, body);
}

function postJsonWithHeaders(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      method: "POST",
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      headers: { "content-type": "application/json", ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (res.statusCode >= 400) reject(new Error(payload.error || `HTTP ${res.statusCode}`));
        else resolve(payload);
      });
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("reasoner uses deterministic mode when neither GauzMem nor XiaoBa LLM key is configured", () => {
  withEnv({
    GAUZMEM_LLM_API_KEY: "",
    GAUZ_LLM_API_KEY: "",
  }, () => {
    assert.equal(createReasoner() instanceof DeterministicReasoner, true);
  });
});

test("reasoner falls back to XiaoBa Anthropic-compatible LLM config", () => {
  withEnv({
    GAUZMEM_LLM_API_KEY: "",
    GAUZMEM_LLM_BASE_URL: "",
    GAUZMEM_LLM_MODEL: "",
    GAUZ_LLM_API_KEY: "xiaoba-key",
    GAUZ_LLM_API_BASE: "https://model.example.test/v1/messages",
    GAUZ_LLM_MODEL: "claude-test",
  }, () => {
    const reasoner = createReasoner();
    assert.equal(reasoner instanceof AnthropicCompatibleReasoner, true);
    assert.equal(reasoner.constructor.name, "AnthropicCompatibleReasoner");
    assert.equal(reasoner.apiKey, "xiaoba-key");
    assert.equal(reasoner.baseUrl, "https://model.example.test");
    assert.equal(reasoner.model, "claude-test");
  });
});

test("reasoner keeps GauzMem LLM config ahead of XiaoBa fallback", () => {
  withEnv({
    GAUZMEM_LLM_API_KEY: "gauzmem-key",
    GAUZMEM_LLM_BASE_URL: "https://gauzmem.example.test/anthropic",
    GAUZMEM_LLM_MODEL: "gauzmem-model",
    GAUZMEM_LLM_TIMEOUT_MS: "1234",
    GAUZ_LLM_API_KEY: "xiaoba-key",
    GAUZ_LLM_API_BASE: "https://xiaoba.example.test/v1/messages",
    GAUZ_LLM_MODEL: "xiaoba-model",
  }, () => {
    const reasoner = createReasoner();
    assert.equal(reasoner.constructor.name, "AnthropicCompatibleReasoner");
    assert.equal(reasoner.apiKey, "gauzmem-key");
    assert.equal(reasoner.baseUrl, "https://gauzmem.example.test/anthropic");
    assert.equal(reasoner.model, "gauzmem-model");
    assert.equal(reasoner.timeoutMs, 1234);
  });
});

test("XiaoBa source adapter only parses current turn entries", () => {
  const root = tmpDir("gauzmem-zero-source-");
  const logPath = path.join(root, "logs", "sessions", "chat", "2026-05-06", "chat_cli.jsonl");
  writeJsonl(logPath, [
    {
      entry_type: "runtime",
      timestamp: "2026-05-06T00:00:00.000Z",
      session_id: "cli",
      session_type: "chat",
      level: "INFO",
      message: "runtime should be ignored",
    },
    turn({
      user: "用户说 relation 第一版不要固定 taxonomy。",
      assistant: "助手确认 whyRelevant 只保留自然语言。",
      tool_calls: [{ id: "tc1", name: "read_file", arguments: {}, result: "工具结果包含 TaskRegistry。" }],
    }),
    {
      turn: 2,
      timestamp: "2026-05-06T00:00:01.000Z",
      session_id: "legacy",
      session_type: "chat",
      user: { text: "legacy should be ignored" },
      assistant: { text: "legacy", tool_calls: [] },
      tokens: { prompt: 1, completion: 1 },
    },
  ]);

  const docs = parseXiaoBaLogFile(logPath);
  assert.equal(docs.length, 3);
  assert.deepEqual(docs.map((doc) => doc.sourceRef.role), ["user", "assistant", "tool"]);
  assert.equal(docs.some((doc) => doc.text.includes("legacy")), false);
  assert.equal(docs[2].sourceRef.toolCallId, "tc1");
});

test("retrieve stores exact substrings from decoded XiaoBa fields", async () => {
  const root = tmpDir("gauzmem-zero-exact-");
  const storeRoot = path.join(root, ".gauzmem-zero");
  const logPath = path.join(root, "logs", "sessions", "chat", "2026-05-06", "chat_cli.jsonl");
  writeJsonl(logPath, [
    turn({
      user: "前文: relation 第一版不要固定 taxonomy，应该开放定义。后文: 暂时不要 kind 字段。",
      assistant: "收到。",
    }),
  ]);

  const result = await retrieve({
    storeRoot,
    rootPaths: [path.join(root, "logs", "sessions")],
    query: "relation taxonomy",
    budget: { maxTerms: 4, maxEvidence: 5 },
    timestamp: "2026-05-06T00:00:02.000Z",
  });

  assert.equal(result.evidence.length >= 1, true);
  const evidence = result.evidence.find((item) => item.text.includes("relation 第一版"));
  assert.ok(evidence);
  const docs = parseXiaoBaLogFile(logPath);
  const sourceText = docs.find((doc) => doc.sourceRef.fieldPath === evidence.sourceRef.fieldPath).text;
  assert.equal(sourceText.slice(evidence.sourceRef.charStart, evidence.sourceRef.charEnd), evidence.text);
});

test("case-insensitive search keeps offsets in original source coordinates", () => {
  const matches = findCaseInsensitiveMatches("prefix İ suffix", "İ");
  assert.deepEqual(matches, [{ start: 7, end: 8 }]);
  assert.equal("prefix İ suffix".slice(matches[0].start, matches[0].end), "İ");
});

test("retrieve writes graph and later discloses one-hop associated evidence", async () => {
  const root = tmpDir("gauzmem-zero-graph-");
  const storeRoot = path.join(root, ".gauzmem-zero");
  const logPath = path.join(root, "logs", "sessions", "chat", "2026-05-06", "chat_cli.jsonl");
  writeJsonl(logPath, [
    turn({
      user: "避免重复造模块，要先查已有 TaskRegistry。",
      assistant: "TaskRegistry 已经提供任务注册和复用。",
    }),
  ]);

  const first = await retrieve({
    storeRoot,
    rootPaths: [path.join(root, "logs", "sessions")],
    query: "重复造模块",
    budget: { maxTerms: 4, maxEvidence: 5, maxGraphHops: 1 },
    timestamp: "2026-05-06T00:00:03.000Z",
  });
  assert.equal(first.evidence.length, 1);
  assert.equal(first.retrieveMode, "source_construct");
  assert.equal(loadGraph(storeRoot).edges.length, 0);

  const expanded = await retrieve({
    storeRoot,
    rootPaths: [path.join(root, "logs", "sessions")],
    query: "重复造模块 TaskRegistry 任务注册",
    budget: { maxTerms: 6, maxEvidence: 5, maxGraphHops: 1, forceConstruct: true },
    timestamp: "2026-05-06T00:00:03.500Z",
  });
  assert.equal(expanded.retrieveMode, "graph_then_construct");
  assert.equal(loadGraph(storeRoot).edges.length >= 1, true);
  assert.equal(expanded.selectedEdgeIds.length, 0);
  assert.equal(expanded.createdEdgeIds.length >= 1, true);
  assert.equal(loadGraph(storeRoot).edges.every((edge) => !Object.hasOwn(edge, "kind") && !Object.hasOwn(edge, "relationLabel")), true);

  const second = await retrieve({
    storeRoot,
    rootPaths: [],
    query: "重复造模块",
    budget: { maxTerms: 4, maxEvidence: 2, maxGraphHops: 1 },
    timestamp: "2026-05-06T00:00:04.000Z",
  });

  assert.equal(second.retrieveMode, "graph_first");
  assert.equal(second.stats.docsScanned, 0);
  assert.equal(second.evidence.some((node) => node.text.includes("避免重复造模块")), true);
  assert.equal(second.disclosedGraph.nodes.some((node) => node.text.includes("任务注册和复用")), true);
  assert.match(second.promptBundle, /associations/);

  const third = await retrieve({
    storeRoot,
    rootPaths: [],
    query: "任务注册",
    budget: { maxTerms: 4, maxEvidence: 2, maxGraphHops: 1 },
    timestamp: "2026-05-06T00:00:05.000Z",
  });
  assert.equal(third.retrieveMode, "graph_first");
  assert.equal(third.stats.docsScanned, 0);
  assert.equal(third.evidence.some((node) => node.text.includes("任务注册和复用")), true);
});

test("graph parent construct writes parent to single new evidence edge", async () => {
  const root = tmpDir("gauzmem-zero-parent-edge-");
  const storeRoot = path.join(root, ".gauzmem-zero");
  const rootA = path.join(root, "a", "sessions");
  const rootB = path.join(root, "b", "sessions");
  writeJsonl(path.join(rootA, "chat", "2026-05-06", "chat_cli.jsonl"), [
    turn({ user: "old-anchor 代表旧模块入口。", assistant: "收到。" }),
  ]);
  writeJsonl(path.join(rootB, "chat", "2026-05-06", "chat_cli.jsonl"), [
    turn({ user: "new-child 代表新增复用实现。", assistant: "收到。" }),
  ]);

  await retrieve({
    storeRoot,
    rootPaths: [rootA],
    query: "old-anchor",
    budget: { maxTerms: 2, maxEvidence: 2 },
    timestamp: "2026-05-06T00:00:01.000Z",
  });
  const second = await retrieve({
    storeRoot,
    rootPaths: [rootB],
    query: "old-anchor new-child",
    budget: { maxTerms: 4, maxEvidence: 1, forceConstruct: true },
    timestamp: "2026-05-06T00:00:02.000Z",
  });

  const graph = loadGraph(storeRoot);
  assert.equal(second.retrieveMode, "graph_then_construct");
  assert.equal(second.createdEdgeIds.length, 1);
  assert.equal(graph.edges.length, 1);
  assert.match(second.promptBundle, /associations/);

  const repeated = await retrieve({
    storeRoot,
    rootPaths: [rootB],
    query: "old-anchor new-child",
    budget: { maxTerms: 4, maxEvidence: 1, forceConstruct: true },
    timestamp: "2026-05-06T00:00:03.000Z",
  });
  assert.equal(repeated.createdEdgeIds.length, 0);
  assert.equal(loadGraph(storeRoot).edges.length, 1);
});

test("graph root relevance can return empty and fall back to source construct", async () => {
  const root = tmpDir("gauzmem-zero-empty-gate-");
  const storeRoot = path.join(root, ".gauzmem-zero");
  const rootA = path.join(root, "a", "sessions");
  const rootB = path.join(root, "b", "sessions");
  writeJsonl(path.join(rootA, "chat", "2026-05-06", "chat_cli.jsonl"), [
    turn({ user: "weak-hit 这条旧信息不该阻止继续搜索。", assistant: "收到。" }),
  ]);
  writeJsonl(path.join(rootB, "chat", "2026-05-06", "chat_cli.jsonl"), [
    turn({ user: "fallback-target 是真正应该找到的新信息。", assistant: "收到。" }),
  ]);
  const reasoner = {
    async generateSearchTerms(input) {
      return input.query.split(/\s+/).filter(Boolean);
    },
    async extractEvidence(input) {
      return input.windows.map((window) => ({
        windowId: window.id,
        text: window.text,
        reason: "test",
      }));
    },
    async selectRootRelevant(input) {
      if (input.allowEmpty) return { selectedNodeIds: [], selectedEdgeIds: [], rejectedNodeIds: [], rejectedEdgeIds: [] };
      return { selectedNodeIds: input.nodes.slice(0, 1).map((node) => node.id), selectedEdgeIds: [], rejectedNodeIds: [], rejectedEdgeIds: [] };
    },
    async writeWhyRelevant() {
      return "test association";
    },
  };

  await retrieve({
    storeRoot,
    rootPaths: [rootA],
    query: "weak-hit",
    reasoner,
    budget: { maxTerms: 2, maxEvidence: 2 },
    timestamp: "2026-05-06T00:00:01.000Z",
  });
  const second = await retrieve({
    storeRoot,
    rootPaths: [rootB],
    query: "weak-hit fallback-target",
    reasoner,
    budget: { maxTerms: 4, maxEvidence: 2 },
    timestamp: "2026-05-06T00:00:02.000Z",
  });

  assert.equal(second.retrieveMode, "graph_then_construct");
  assert.equal(second.evidence.some((node) => node.text.includes("fallback-target")), true);
});

test("partial graph hit continues source construct when source roots are available", async () => {
  const root = tmpDir("gauzmem-zero-partial-hit-");
  const storeRoot = path.join(root, ".gauzmem-zero");
  const rootA = path.join(root, "a", "sessions");
  const rootB = path.join(root, "b", "sessions");
  writeJsonl(path.join(rootA, "chat", "2026-05-06", "chat_cli.jsonl"), [
    turn({ user: "ANCHOR_MAIN 是旧模块入口。", assistant: "收到。" }),
  ]);
  writeJsonl(path.join(rootB, "chat", "2026-05-06", "chat_cli.jsonl"), [
    turn({ user: "CHILD_NEW_FACT 是新加入的关键事实。", assistant: "收到。" }),
  ]);

  await retrieve({
    storeRoot,
    rootPaths: [rootA],
    query: "ANCHOR_MAIN",
    budget: { maxTerms: 2, maxEvidence: 2 },
    timestamp: "2026-05-06T00:00:01.000Z",
  });
  const result = await retrieve({
    storeRoot,
    rootPaths: [rootB],
    query: "ANCHOR_MAIN CHILD_NEW_FACT",
    budget: { maxTerms: 4, maxEvidence: 2 },
    timestamp: "2026-05-06T00:00:02.000Z",
  });

  assert.equal(result.retrieveMode, "graph_then_construct");
  assert.equal(result.stats.docsScanned > 0, true);
  assert.equal(result.evidence.some((node) => node.text.includes("CHILD_NEW_FACT")), true);
});

test("sufficient graph hit avoids source construct unless forced", async () => {
  const root = tmpDir("gauzmem-zero-sufficient-hit-");
  const storeRoot = path.join(root, ".gauzmem-zero");
  const rootA = path.join(root, "a", "sessions");
  const rootB = path.join(root, "b", "sessions");
  writeJsonl(path.join(rootA, "chat", "2026-05-06", "chat_cli.jsonl"), [
    turn({ user: "alpha-term 是第一条相关证据。", assistant: "beta-term 是第二条相关证据。" }),
  ]);
  writeJsonl(path.join(rootB, "chat", "2026-05-06", "chat_cli.jsonl"), [
    turn({ user: "source-should-not-scan", assistant: "收到。" }),
  ]);

  await retrieve({
    storeRoot,
    rootPaths: [rootA],
    query: "alpha-term beta-term",
    budget: { maxTerms: 4, maxEvidence: 4 },
    timestamp: "2026-05-06T00:00:01.000Z",
  });
  const result = await retrieve({
    storeRoot,
    rootPaths: [rootB],
    query: "alpha-term beta-term",
    budget: { maxTerms: 4, maxEvidence: 4 },
    timestamp: "2026-05-06T00:00:02.000Z",
  });

  assert.equal(result.retrieveMode, "graph_first");
  assert.equal(result.stats.docsScanned, 0);
  assert.equal(result.stats.graphWasSufficient, true);
});

test("graph sufficiency checks uncovered query terms before skipping source", async () => {
  const root = tmpDir("gauzmem-zero-uncovered-term-");
  const storeRoot = path.join(root, ".gauzmem-zero");
  const rootA = path.join(root, "a", "sessions");
  const rootB = path.join(root, "b", "sessions");
  writeJsonl(path.join(rootA, "chat", "2026-05-06", "chat_cli.jsonl"), [
    turn({ user: "old-alpha 是旧证据之一。", assistant: "old-beta 是旧证据之二。" }),
  ]);
  writeJsonl(path.join(rootB, "chat", "2026-05-06", "chat_cli.jsonl"), [
    turn({ user: "new-gamma 是 source 中的新事实。", assistant: "收到。" }),
  ]);

  await retrieve({
    storeRoot,
    rootPaths: [rootA],
    query: "old-alpha old-beta",
    budget: { maxTerms: 4, maxEvidence: 4 },
    timestamp: "2026-05-06T00:00:01.000Z",
  });
  const result = await retrieve({
    storeRoot,
    rootPaths: [rootB],
    query: "old-alpha old-beta new-gamma",
    budget: { maxTerms: 6, maxEvidence: 4 },
    timestamp: "2026-05-06T00:00:02.000Z",
  });

  assert.equal(result.retrieveMode, "graph_then_construct");
  assert.equal(result.stats.graphWasSufficient, false);
  assert.equal(result.stats.docsScanned > 0, true);
  assert.equal(result.evidence.some((node) => node.text.includes("new-gamma")), true);
});

test("graph sufficiency does not count whyRelevant text as evidence term coverage", async () => {
  const root = tmpDir("gauzmem-zero-edge-coverage-");
  const storeRoot = path.join(root, ".gauzmem-zero");
  const logRoot = path.join(root, "logs", "sessions");
  writeJsonl(path.join(logRoot, "chat", "2026-05-06", "chat_cli.jsonl"), [
    turn({ user: "edge-only-gamma 是 source 里真正的新事实。", assistant: "收到。" }),
  ]);
  const nodes = [
    {
      schemaVersion: 1,
      id: "node_alpha",
      text: "node-alpha 是已有图证据。",
      sourceTrust: "user",
      sourceRef: { kind: "conversation", role: "user", logPath: "old.jsonl", jsonlLine: 1, fieldPath: "user.text" },
    },
    {
      schemaVersion: 1,
      id: "node_beta",
      text: "node-beta 是另一个已有图证据。",
      sourceTrust: "user",
      sourceRef: { kind: "conversation", role: "user", logPath: "old.jsonl", jsonlLine: 2, fieldPath: "user.text" },
    },
  ];
  const edgeId = evidenceEdgeId("node_alpha", "node_beta");
  upsertNodes(storeRoot, nodes);
  upsertEdges(storeRoot, [{
    schemaVersion: 1,
    id: edgeId,
    from: "node_alpha",
    to: "node_beta",
    mode: "localAssociation",
    direction: "directed",
    whyRelevant: "edge-only-gamma only appears in association text, not source-backed evidence.",
    runId: "manual",
    createdAt: "2026-05-06T00:00:00.000Z",
  }]);
  appendNodeStates(storeRoot, nodes.map((node) => defaultNodeState(node.id, 1, "manual")));
  appendEdgeStates(storeRoot, [defaultEdgeState(edgeId, 1, "localAssociation", "manual")]);
  const reasoner = {
    async generateSearchTerms(input) {
      return input.query.split(/\s+/).filter(Boolean);
    },
    async extractEvidence(input) {
      return input.windows.map((window) => ({
        windowId: window.id,
        text: window.text,
        reason: "test",
      }));
    },
    async selectRootRelevant(input) {
      return {
        selectedNodeIds: input.nodes.map((node) => node.id),
        selectedEdgeIds: input.edges.map((edge) => edge.id),
        rejectedNodeIds: [],
        rejectedEdgeIds: [],
      };
    },
    async writeWhyRelevant() {
      return "manual association";
    },
  };

  const result = await retrieve({
    storeRoot,
    rootPaths: [logRoot],
    query: "node-alpha node-beta edge-only-gamma",
    reasoner,
    budget: { maxTerms: 3, maxEvidence: 4 },
    timestamp: "2026-05-06T00:00:01.000Z",
  });

  assert.equal(result.stats.graphWasSufficient, false);
  assert.equal(result.retrieveMode, "graph_then_construct");
  assert.equal(result.stats.docsScanned > 0, true);
  assert.equal(result.evidence.some((node) => node.text.includes("edge-only-gamma")), true);
});

test("edge hits do not disclose non-retrievable endpoint nodes", async () => {
  const root = tmpDir("gauzmem-zero-hidden-endpoint-");
  const storeRoot = path.join(root, ".gauzmem-zero");
  const rootA = path.join(root, "a", "sessions");
  const rootB = path.join(root, "b", "sessions");
  writeJsonl(path.join(rootA, "chat", "2026-05-06", "chat_cli.jsonl"), [
    turn({ user: "visible-anchor 用来建立父节点。", assistant: "收到。" }),
  ]);
  writeJsonl(path.join(rootB, "chat", "2026-05-06", "chat_cli.jsonl"), [
    turn({ user: "hidden-child 用来建立子节点。", assistant: "收到。" }),
  ]);
  await retrieve({
    storeRoot,
    rootPaths: [rootA],
    query: "visible-anchor",
    budget: { maxTerms: 2, maxEvidence: 2 },
    timestamp: "2026-05-06T00:00:01.000Z",
  });
  const linked = await retrieve({
    storeRoot,
    rootPaths: [rootB],
    query: "visible-anchor hidden-child",
    budget: { maxTerms: 4, maxEvidence: 2, forceConstruct: true },
    timestamp: "2026-05-06T00:00:02.000Z",
  });
  const graph = loadGraph(storeRoot);
  const hidden = graph.nodes.find((node) => node.text.includes("hidden-child"));
  assert.ok(hidden);
  appendNodeStates(storeRoot, [{
    ...defaultNodeState(hidden.id, 3, "test_dormant"),
    visibility: "dormant",
  }]);
  const edge = graph.edges.find((item) => linked.createdEdgeIds.includes(item.id));
  assert.ok(edge);
  appendEdgeStates(storeRoot, [{
    ...defaultEdgeState(edge.id, 3, "localAssociation", "test_visible_edge"),
    weight: 2,
  }]);

  const result = await retrieve({
    storeRoot,
    rootPaths: [],
    query: "Local association",
    budget: { maxTerms: 4, maxEvidence: 2, maxGraphHops: 1 },
    timestamp: "2026-05-06T00:00:03.000Z",
  });

  assert.equal(result.evidence.some((node) => node.text.includes("hidden-child")), false);
  assert.equal(result.disclosedGraph.nodes.some((node) => node.text.includes("hidden-child")), false);
});

test("feedback usefulEdgeIds are honored when usedEdgeIds is empty", async () => {
  const root = tmpDir("gauzmem-zero-feedback-edge-");
  const storeRoot = path.join(root, ".gauzmem-zero");
  const rootA = path.join(root, "a", "sessions");
  const rootB = path.join(root, "b", "sessions");
  writeJsonl(path.join(rootA, "chat", "2026-05-06", "chat_cli.jsonl"), [
    turn({ user: "feedback-parent 旧节点。", assistant: "收到。" }),
  ]);
  writeJsonl(path.join(rootB, "chat", "2026-05-06", "chat_cli.jsonl"), [
    turn({ user: "feedback-child 新节点。", assistant: "收到。" }),
  ]);
  await retrieve({
    storeRoot,
    rootPaths: [rootA],
    query: "feedback-parent",
    budget: { maxTerms: 2, maxEvidence: 2 },
    timestamp: "2026-05-06T00:00:01.000Z",
  });
  const linked = await retrieve({
    storeRoot,
    rootPaths: [rootB],
    query: "feedback-parent feedback-child",
    budget: { maxTerms: 4, maxEvidence: 2, forceConstruct: true },
    timestamp: "2026-05-06T00:00:02.000Z",
  });
  const edgeId = linked.createdEdgeIds[0];
  assert.ok(edgeId);

  const feedback = recordFeedback({
    storeRoot,
    runId: linked.runId,
    usedEdgeIds: [],
    usefulEdgeIds: [edgeId],
    timestamp: "2026-05-06T00:00:03.000Z",
  });
  assert.equal(feedback.edgeStatesWritten, 1);
  const graph = loadGraph(storeRoot);
  const state = graph.edgeStates.filter((item) => item.edgeId === edgeId).at(-1);
  assert.equal(state.reason, "used");
  assert.equal(state.selectedCount, 1);
});

test("construct limits densification and uses one localAssociation per node pair", async () => {
  const root = tmpDir("gauzmem-zero-dense-");
  const storeRoot = path.join(root, ".gauzmem-zero");
  const parentsRoot = path.join(root, "parents", "sessions");
  const childrenRoot = path.join(root, "children", "sessions");
  writeJsonl(path.join(parentsRoot, "chat", "2026-05-06", "chat_cli.jsonl"), [
    turn({ user: "parent-a 旧入口。 parent-b 旧入口。 parent-c 旧入口。", assistant: "收到。" }),
  ]);
  writeJsonl(path.join(childrenRoot, "chat", "2026-05-06", "chat_cli.jsonl"), [
    turn({ user: "child-a 新事实。 child-b 新事实。 child-c 新事实。", assistant: "收到。" }),
  ]);
  const reasoner = {
    async generateSearchTerms(input) {
      return input.query.split(/\s+/).filter(Boolean);
    },
    async extractEvidence(input) {
      return input.windows.map((window) => ({
        windowId: window.id,
        text: window.text,
        reason: "test",
      }));
    },
    async selectRootRelevant(input) {
      return {
        selectedNodeIds: input.nodes.map((node) => node.id),
        selectedEdgeIds: [],
        rejectedNodeIds: [],
        rejectedEdgeIds: [],
      };
    },
    async writeWhyRelevant(input) {
      return `association ${input.from.id} ${input.to.id} ${Date.now()}`;
    },
  };

  await retrieve({
    storeRoot,
    rootPaths: [parentsRoot],
    query: "parent-a parent-b parent-c",
    reasoner,
    budget: { maxTerms: 3, maxEvidence: 3 },
    timestamp: "2026-05-06T00:00:01.000Z",
  });
  const linked = await retrieve({
    storeRoot,
    rootPaths: [childrenRoot],
    query: "parent-a parent-b parent-c child-a child-b child-c",
    reasoner,
    budget: { maxTerms: 6, maxEvidence: 3, forceConstruct: true, maxRunEdges: 20 },
    timestamp: "2026-05-06T00:00:02.000Z",
  });
  assert.equal(linked.createdEdgeIds.length <= 3, true);

  const repeated = await retrieve({
    storeRoot,
    rootPaths: [childrenRoot],
    query: "parent-a parent-b parent-c child-a child-b child-c",
    reasoner,
    budget: { maxTerms: 6, maxEvidence: 3, forceConstruct: true, maxRunEdges: 20 },
    timestamp: "2026-05-06T00:00:03.000Z",
  });
  assert.equal(repeated.createdEdgeIds.length, 0);
});

test("same runId replays persisted result without appending duplicate events or states", async () => {
  const root = tmpDir("gauzmem-zero-idempotent-");
  const storeRoot = path.join(root, ".gauzmem-zero");
  const logRoot = path.join(root, "logs", "sessions");
  writeJsonl(path.join(logRoot, "chat", "2026-05-06", "chat_cli.jsonl"), [
    turn({ user: "idempotent-anchor 是稳定证据。", assistant: "收到。" }),
  ]);

  const first = await retrieve({
    storeRoot,
    runId: "run_idempotent",
    rootPaths: [logRoot],
    query: "idempotent-anchor",
    budget: { maxTerms: 2, maxEvidence: 2 },
    timestamp: "2026-05-06T00:00:01.000Z",
  });
  const afterFirst = loadGraph(storeRoot);
  const second = await retrieve({
    storeRoot,
    runId: "run_idempotent",
    rootPaths: [logRoot],
    query: "idempotent-anchor",
    budget: { maxTerms: 2, maxEvidence: 2 },
    timestamp: "2026-05-06T00:00:02.000Z",
  });
  const afterSecond = loadGraph(storeRoot);

  assert.equal(first.runId, second.runId);
  assert.equal(second.stats.idempotentReplay, true);
  assert.equal(afterSecond.runs.length, afterFirst.runs.length);
  assert.equal(afterSecond.events.length, afterFirst.events.length);
  assert.equal(afterSecond.nodeStates.length, afterFirst.nodeStates.length);
  assert.equal(afterSecond.edgeStates.length, afterFirst.edgeStates.length);

  await assert.rejects(
    () => retrieve({
      storeRoot,
      runId: "run_idempotent",
      rootPaths: [logRoot],
      query: "different-query",
      budget: { maxTerms: 2, maxEvidence: 2 },
      timestamp: "2026-05-06T00:00:03.000Z",
    }),
    /different query/,
  );
});

test("prompt bundle has a hard character cap", async () => {
  const root = tmpDir("gauzmem-zero-prompt-cap-");
  const storeRoot = path.join(root, ".gauzmem-zero");
  const logRoot = path.join(root, "logs", "sessions");
  writeJsonl(path.join(logRoot, "chat", "2026-05-06", "chat_cli.jsonl"), [
    turn({ user: `long-memory ${"x".repeat(3000)}`, assistant: "收到。" }),
  ]);

  const result = await retrieve({
    storeRoot,
    runId: "run_prompt_cap",
    rootPaths: [logRoot],
    query: "long-memory",
    budget: { maxTerms: 2, maxEvidence: 2, maxEvidenceChars: 2000, maxPromptChars: 500 },
    timestamp: "2026-05-06T00:00:01.000Z",
  });

  assert.equal(result.promptBundle.length <= 500, true);
  assert.match(result.promptBundle, /truncated/);
  assert.match(result.promptBundle, /\[\/gauzmem_recall\]$/);

  const replay = await retrieve({
    storeRoot,
    runId: "run_prompt_cap",
    rootPaths: [logRoot],
    query: "long-memory",
    budget: { maxTerms: 2, maxEvidence: 2, maxPromptChars: 300 },
    timestamp: "2026-05-06T00:00:02.000Z",
  });
  assert.equal(replay.stats.idempotentReplay, true);
  assert.equal(replay.promptBundle.length <= 300, true);
  assert.match(replay.promptBundle, /\[\/gauzmem_recall\]$/);
});

test("bad JSONL lines are quarantined without breaking graph load", () => {
  const root = tmpDir("gauzmem-zero-bad-jsonl-");
  const storeRoot = path.join(root, ".gauzmem-zero");
  const paths = storePaths(storeRoot);
  loadGraph(storeRoot);
  fs.writeFileSync(paths.nodesFile, `${JSON.stringify({ id: "ok-node", text: "ok" })}\n{bad json\n`, "utf8");

  const graph = loadGraph(storeRoot);
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].id, "ok-node");
  assert.equal(fs.existsSync(`${paths.nodesFile}.bad`), true);
});

test("HTTP retrieve returns run trace and persists runs/events", async () => {
  const root = tmpDir("gauzmem-zero-api-");
  const storeRoot = path.join(root, ".gauzmem-zero");
  const logPath = path.join(root, "logs", "sessions", "chat", "2026-05-06", "chat_cli.jsonl");
  writeJsonl(logPath, [
    turn({
      user: "Graph evidence 只能临时注入，不进入长期 session。",
      assistant: "GauzMem 单独记录 nodes edges runs events。",
    }),
  ]);

  const allowedRoot = path.join(root, "logs", "sessions");
  const { server, url } = await listen({ storeRoot, port: 0, allowedRootPaths: [allowedRoot] });
  try {
    const result = await postJson(`${url}/v1/retrieve`, {
      query: "GauzMem events",
      rootPaths: [allowedRoot],
      budget: { maxTerms: 5, maxEvidence: 5 },
    });
    assert.ok(result.runId);
    assert.equal(Array.isArray(result.searchTrace), true);
    assert.equal(result.evidence.length >= 1, true);
    assert.match(result.promptBundle, /\[gauzmem_recall\]/);

    const graph = loadGraph(storeRoot);
    assert.equal(graph.runs.length, 1);
    assert.equal(graph.events.some((event) => event.eventType === "retrieved"), true);
  } finally {
    server.close();
  }
});

test("source registration requires searchable extracted text and records source event", () => {
  const root = tmpDir("gauzmem-zero-source-event-");
  const storeRoot = path.join(root, ".gauzmem-zero");
  const originalPath = path.join(root, "image.png");
  fs.writeFileSync(originalPath, "fake", "utf8");

  assert.throws(() => registerAttachment(storeRoot, { path: originalPath }), /text or extractedTextPath is required/);
  const record = registerAttachment(storeRoot, {
    path: originalPath,
    text: "图片里写着 TaskRegistry 已经存在。",
    sessionId: "cli",
    sessionType: "chat",
  });
  assert.ok(record.extractedTextPath);
  const graph = loadGraph(storeRoot);
  assert.equal(graph.attachments.length, 1);
  assert.equal(graph.events.some((event) => event.eventType === "source_registered"), true);
});

test("attachment registration copies extracted text into store and ignores unsafe legacy paths", () => {
  const root = tmpDir("gauzmem-zero-attachment-copy-");
  const storeRoot = path.join(root, ".gauzmem-zero");
  const originalPath = path.join(root, "image.png");
  const externalTextPath = path.join(root, "external.txt");
  fs.writeFileSync(originalPath, "fake", "utf8");
  fs.writeFileSync(externalTextPath, "external TaskRegistry text", "utf8");

  const record = registerAttachment(storeRoot, {
    path: originalPath,
    extractedTextPath: externalTextPath,
  });
  fs.writeFileSync(externalTextPath, "mutated external text", "utf8");
  const docs = loadSearchDocs({ storeRoot });
  assert.equal(docs.some((doc) => doc.text.includes("external TaskRegistry text")), true);
  assert.equal(docs.some((doc) => doc.text.includes("mutated external text")), false);

  const paths = storePaths(storeRoot);
  fs.appendFileSync(paths.attachmentsFile, `${JSON.stringify({
    attachmentId: "legacy_external",
    originalPath,
    extractedTextPath: externalTextPath,
  })}\n`, "utf8");
  const afterLegacy = loadSearchDocs({ storeRoot });
  assert.equal(afterLegacy.some((doc) => doc.sourceRef.attachmentId === "legacy_external"), false);
  assert.equal(record.extractedTextPath.startsWith(paths.attachmentTextDir), true);
});

test("attachment registration rejects unsafe attachment ids", () => {
  const root = tmpDir("gauzmem-zero-attachment-id-");
  const storeRoot = path.join(root, ".gauzmem-zero");
  const originalPath = path.join(root, "image.png");
  const outsidePath = path.join(root, "escape.txt");
  fs.writeFileSync(originalPath, "fake", "utf8");

  assert.throws(
    () => registerAttachment(storeRoot, {
      attachmentId: "../escape",
      path: originalPath,
      text: "should not be written outside attachment text dir",
    }),
    /attachmentId is not allowed/,
  );
  assert.equal(fs.existsSync(outsidePath), false);
});

test("HTTP API rejects bad requests as 4xx and does not allow storeRoot override", async () => {
  const root = tmpDir("gauzmem-zero-api-errors-");
  const storeRoot = path.join(root, ".gauzmem-zero");
  const otherStore = path.join(root, "other-store");
  const allowedRoot = path.join(root, "allowed", "sessions");
  const deniedRoot = path.join(root, "denied", "sessions");
  const { server, url } = await listen({ storeRoot, port: 0, allowedRootPaths: [allowedRoot] });
  try {
    await assert.rejects(
      () => postJson(`${url}/v1/retrieve`, { query: "", storeRoot: otherStore }),
      /storeRoot is not allowed/,
    );
    assert.equal(fs.existsSync(otherStore), false);
    await assert.rejects(
      () => postJson(`${url}/v1/retrieve`, { query: "secret", llmApiKey: "not-real" }),
      /llmApiKey is not allowed/,
    );
    await assert.rejects(
      () => postJson(`${url}/v1/retrieve`, { query: "secret", llmBaseUrl: "https://example.test/steal" }),
      /llmBaseUrl is not allowed/,
    );
    await assert.rejects(
      () => postJson(`${url}/v1/retrieve`, { query: "denied", rootPaths: [deniedRoot] }),
      /rootPath is not allowed/,
    );
    await assert.rejects(
      () => postJson(`${url}/v1/events/source`, { path: path.join(deniedRoot, "image.png"), text: "secret" }),
      /rootPath is not allowed/,
    );
    await assert.rejects(
      () => postJson(`${url}/v1/events/source`, {
        attachmentId: "../escape",
        path: path.join(allowedRoot, "image.png"),
        text: "secret",
      }),
      /attachmentId is not allowed/,
    );
  } finally {
    server.close();
  }
});

test("HTTP source paths require an explicit allowlist", async () => {
  const root = tmpDir("gauzmem-zero-api-no-allowlist-");
  const storeRoot = path.join(root, ".gauzmem-zero");
  const logRoot = path.join(root, "logs", "sessions");
  const { server, url } = await listen({ storeRoot, port: 0 });
  try {
    await assert.rejects(
      () => postJson(`${url}/v1/retrieve`, { query: "x", rootPaths: [logRoot] }),
      /GAUZMEM_ALLOWED_ROOTS is required/,
    );
    await assert.rejects(
      () => postJson(`${url}/v1/events/source`, { path: path.join(logRoot, "image.png"), text: "x" }),
      /GAUZMEM_ALLOWED_ROOTS is required/,
    );
  } finally {
    server.close();
  }
});

test("HTTP API requires bearer token when configured", async () => {
  const root = tmpDir("gauzmem-zero-api-auth-");
  const storeRoot = path.join(root, ".gauzmem-zero");
  const allowedRoot = path.join(root, "allowed", "sessions");
  const { server, url } = await listen({
    storeRoot,
    port: 0,
    allowedRootPaths: [allowedRoot],
    authToken: "secret-token",
  });
  try {
    await assert.rejects(
      () => postJson(`${url}/v1/events/turn`, { sessionId: "cli", gauzmemRunIds: [] }),
      /unauthorized/,
    );
    await assert.rejects(
      () => postJsonWithHeaders(
        `${url}/v1/events/turn`,
        { sessionId: "cli", gauzmemRunIds: [] },
        { authorization: "Bearer wrong" },
      ),
      /unauthorized/,
    );
    const ok = await postJsonWithHeaders(
      `${url}/v1/events/turn`,
      { sessionId: "cli", gauzmemRunIds: ["run_1"] },
      { authorization: "Bearer secret-token" },
    );
    assert.equal(ok.sessionId, "cli");
  } finally {
    server.close();
  }
});

test("HTTP retrieve validates root path schema, budget, and symlink roots", async () => {
  const root = tmpDir("gauzmem-zero-api-schema-");
  const storeRoot = path.join(root, ".gauzmem-zero");
  const allowedRoot = path.join(root, "allowed", "sessions");
  const deniedRoot = path.join(root, "denied", "sessions");
  fs.mkdirSync(allowedRoot, { recursive: true });
  fs.mkdirSync(deniedRoot, { recursive: true });
  const symlinkRoot = path.join(allowedRoot, "escape");
  try {
    fs.symlinkSync(deniedRoot, symlinkRoot, "dir");
  } catch {
    // Some CI environments disallow symlink creation; the schema assertions still run.
  }
  const { server, url } = await listen({ storeRoot, port: 0, allowedRootPaths: [allowedRoot] });
  try {
    await assert.rejects(
      () => postJson(`${url}/v1/retrieve`, { query: "x", rootPaths: deniedRoot }),
      /rootPaths must be an array/,
    );
    await assert.rejects(
      () => postJson(`${url}/v1/retrieve`, { query: "x", rootPaths: [deniedRoot] }),
      /rootPath is not allowed/,
    );
    await assert.rejects(
      () => postJson(`${url}/v1/retrieve`, { query: "x", rootPaths: [allowedRoot], budget: { thresholds: { nodeMinWeight: -1 } } }),
      /budget.thresholds is not allowed/,
    );
    if (fs.existsSync(symlinkRoot)) {
      await assert.rejects(
        () => postJson(`${url}/v1/retrieve`, { query: "x", rootPaths: [symlinkRoot] }),
        /rootPath is not allowed/,
      );
    }
  } finally {
    server.close();
  }
});
