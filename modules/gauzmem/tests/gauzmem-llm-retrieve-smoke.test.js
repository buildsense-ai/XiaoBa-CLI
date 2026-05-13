"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

require("../src/gauzmem-zero/env").loadGauzMemEnv();
const { loadGraph, retrieve } = require("../src/gauzmem-zero");

function hasLlmKey() {
  return Boolean(process.env.GAUZMEM_LLM_API_KEY || process.env.GAUZ_LLM_API_KEY);
}

test("configured LLM retrieve constructs evidence and localAssociation edges", {
  skip: !hasLlmKey(),
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gauzmem-llm-retrieve-"));
  const storeRoot = path.join(root, ".gauzmem-zero");
  const logPath = path.join(root, "logs", "sessions", "chat", "2026-05-12", "chat_cli.jsonl");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, JSON.stringify({
    entry_type: "turn",
    turn: 1,
    timestamp: "2026-05-12T00:00:00.000Z",
    session_id: "cli",
    session_type: "chat",
    user: { text: "一年前用户说自己喜欢 C。最近用户说自己喜欢 Python。" },
    assistant: { text: "代码语言偏好应该优先参考最近的 Python。", tool_calls: [] },
    tokens: { prompt: 1, completion: 1 },
  }), "utf8");

  const result = await retrieve({
    storeRoot,
    rootPaths: [path.join(root, "logs", "sessions")],
    query: "用户现在的代码语言偏好是什么？",
    searchTerms: ["用户", "Python", "C"],
    budget: {
      maxTerms: 8,
      maxEvidence: 4,
      maxRunEdges: 4,
      energy: 40,
    },
    timestamp: "2026-05-12T00:00:01.000Z",
  });

  assert.match(result.stats.reasoner, /^(AnthropicCompatibleReasoner|OpenAICompatibleReasoner)$/);
  assert.equal(result.evidence.length >= 1, true);
  assert.match(result.promptBundle, /\[gauzmem_recall\]/);

  const graph = loadGraph(storeRoot);
  assert.equal(graph.nodes.length >= 1, true);
  assert.equal(graph.edges.every((edge) => edge.mode === "localAssociation"), true);
});
