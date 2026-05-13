"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

require("../src/gauzmem-zero/env").loadGauzMemEnv();
const { createReasoner } = require("../src/gauzmem-zero");

test("MiniMax Anthropic-compatible reasoner returns real structured output", {
  skip: !process.env.GAUZMEM_LLM_API_KEY,
}, async () => {
  const reasoner = createReasoner();
  const selection = await reasoner.selectRootRelevant({
    query: "用户现在更偏好 Python 还是 C？",
    nodes: [
      { id: "n_old", text: "一年前用户说自己喜欢 C。", sourceTrust: "user" },
      { id: "n_new", text: "最近用户说自己喜欢 Python。", sourceTrust: "user" },
    ],
    edges: [{
      id: "e_pref_update",
      from: "n_old",
      to: "n_new",
      mode: "localAssociation",
      whyRelevant: "代码语言偏好更新：最近的 Python 偏好应该优先参考。",
    }],
    minSelected: 1,
  });

  assert.equal(Array.isArray(selection.selectedNodeIds), true);
  assert.equal(selection.selectedNodeIds.includes("n_new"), true);
});
