"use strict";

const { extractKeywords } = require("../utils/text");
const { loadGauzMemEnv } = require("./env");

const DEFAULT_LLM_BASE_URL = "https://api.minimaxi.com/anthropic";
const DEFAULT_LLM_MODEL = "MiniMax-M2.7-highspeed";

function createReasoner(input = {}) {
  loadGauzMemEnv();
  if (input.reasoner) return input.reasoner;
  const apiKey = input.apiKey || process.env.GAUZMEM_LLM_API_KEY;
  if (apiKey) {
    return new AnthropicCompatibleReasoner({
      apiKey,
      baseUrl: input.baseUrl || process.env.GAUZMEM_LLM_BASE_URL || DEFAULT_LLM_BASE_URL,
      model: input.model || process.env.GAUZMEM_LLM_MODEL || DEFAULT_LLM_MODEL,
      timeoutMs: input.timeoutMs || Number(process.env.GAUZMEM_LLM_TIMEOUT_MS || 20000),
    });
  }
  return new DeterministicReasoner();
}

class DeterministicReasoner {
  async generateSearchTerms(input = {}) {
    const parentText = input.parent?.text || input.parent?.query || "";
    return uniqueTerms([
      ...(input.explicitTerms || []),
      ...extractKeywords(input.query || "", input.maxTerms || 8),
      ...extractKeywords(parentText, input.maxTerms || 8),
    ], input.maxTerms || 8);
  }

  async extractEvidence(input = {}) {
    const out = [];
    for (const window of input.windows || []) {
      if (!window.text || out.length >= (input.maxEvidence || 8)) continue;
      out.push({
        text: window.text,
        reason: "Matched by deterministic source window extraction.",
        windowId: window.id,
      });
    }
    return out;
  }

  async selectRootRelevant(input = {}) {
    const queryTokens = new Set(extractKeywords(input.query || "", 16).map((item) => item.toLowerCase()));
    const minSelected = input.allowEmpty ? 0 : (input.minSelected ?? 1);
    const selectedNodeIds = [];
    const selectedEdgeIds = [];
    const rejectedNodeIds = [];
    const rejectedEdgeIds = [];
    const reasonById = {};
    const nodesById = new Map((input.nodes || []).map((node) => [node.id, node]));
    for (const node of input.nodes || []) {
      const nodeTokens = extractKeywords(node.text || "", 16).map((item) => item.toLowerCase());
      const hit = nodeTokens.some((token) => queryTokens.has(token)) || selectedNodeIds.length < minSelected;
      if (hit) {
        selectedNodeIds.push(node.id);
        reasonById[node.id] = "Selected by deterministic token overlap.";
      } else if (input.allowReject) {
        rejectedNodeIds.push(node.id);
        reasonById[node.id] = "Rejected by deterministic token overlap.";
      }
    }
    for (const edge of input.edges || []) {
      const edgeTokens = extractKeywords(edge.whyRelevant || "", 24).map((item) => item.toLowerCase());
      const edgeHit = edgeTokens.some((token) => queryTokens.has(token));
      if (edgeHit || (selectedNodeIds.includes(edge.from) && selectedNodeIds.includes(edge.to))) {
        selectedEdgeIds.push(edge.id);
        reasonById[edge.id] = edgeHit
          ? "Selected by deterministic edge whyRelevant overlap."
          : "Selected because both endpoints were selected.";
        for (const endpoint of [edge.from, edge.to]) {
          if (nodesById.has(endpoint) && !selectedNodeIds.includes(endpoint)) {
            selectedNodeIds.push(endpoint);
            reasonById[endpoint] = "Selected because a relevant association edge points here.";
          }
        }
      }
    }
    return {
      selectedNodeIds,
      selectedEdgeIds,
      rejectedNodeIds,
      rejectedEdgeIds,
      reasonById,
    };
  }

  async writeWhyRelevant(input = {}) {
    return [
      `Local association found while answering: ${input.query}`,
      `From: ${shortText(input.from?.text || "")}`,
      `To: ${shortText(input.to?.text || "")}`,
    ].join("\n");
  }
}

class AnthropicCompatibleReasoner extends DeterministicReasoner {
  constructor(options = {}) {
    super();
    this.apiKey = options.apiKey;
    this.baseUrl = String(options.baseUrl || DEFAULT_LLM_BASE_URL).replace(/\/+$/, "");
    this.model = options.model || DEFAULT_LLM_MODEL;
    this.timeoutMs = options.timeoutMs || 20000;
  }

  async completeJson(system, user, options = {}) {
    const text = await this.completeText(system, `${user}\n\nReturn only valid JSON.`, options);
    return parseJsonObject(text);
  }

  async completeText(system, user, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": this.apiKey,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: options.maxTokens || 1200,
          temperature: options.temperature ?? 0,
          system,
          messages: [{ role: "user", content: user }],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`LLM HTTP ${response.status}: ${body.slice(0, 300)}`);
      }
      const payload = await response.json();
      return extractAnthropicText(payload);
    } finally {
      clearTimeout(timer);
    }
  }

  async generateSearchTerms(input = {}) {
    const fallback = await super.generateSearchTerms(input);
    try {
      const payload = await this.completeJson(
        "You expand search terms for a source-grounded memory system. Keep terms short and literal.",
        JSON.stringify({
          task: "Generate search terms for grep-style search.",
          query: input.query,
          parent: input.parent ? { id: input.parent.id, text: shortText(input.parent.text || input.parent.query || "", 600) } : null,
          explicitTerms: input.explicitTerms || [],
          maxTerms: input.maxTerms || 8,
          outputSchema: { terms: ["short literal search term"] },
        }),
        { maxTokens: 600 },
      );
      return uniqueTerms([...(payload.terms || []), ...fallback], input.maxTerms || 8);
    } catch {
      return fallback;
    }
  }

  async extractEvidence(input = {}) {
    const fallback = await super.extractEvidence(input);
    try {
      const windows = (input.windows || []).map((window) => ({
        id: window.id,
        text: shortText(window.text, 1400),
      }));
      const payload = await this.completeJson(
        "You extract exact evidence quotes from source windows. Quotes must be copied verbatim from a provided window.",
        JSON.stringify({
          task: "Extract source-grounded evidence relevant to the query and optional parent evidence.",
          query: input.query,
          parent: input.parent ? { id: input.parent.id, text: shortText(input.parent.text || input.parent.query || "", 700) } : null,
          windows,
          maxEvidence: input.maxEvidence || 8,
          outputSchema: {
            evidence: [{ windowId: "window id", text: "exact quote copied from window", reason: "why this is evidence" }],
          },
        }),
        { maxTokens: 1600 },
      );
      const valid = [];
      for (const item of payload.evidence || []) {
        const window = (input.windows || []).find((candidate) => candidate.id === item.windowId);
        if (!window || typeof item.text !== "string") continue;
        if (!window.text.includes(item.text)) continue;
        valid.push({ windowId: window.id, text: item.text, reason: item.reason || "" });
        if (valid.length >= (input.maxEvidence || 8)) break;
      }
      return valid.length > 0 ? valid : fallback;
    } catch {
      return fallback;
    }
  }

  async selectRootRelevant(input = {}) {
    const fallback = await super.selectRootRelevant(input);
    try {
      const payload = await this.completeJson(
        "You judge which source-grounded memory items are relevant to a root query. Do not invent ids.",
        JSON.stringify({
          task: "Select relevant nodes and edges for the root query.",
          query: input.query,
          nodes: (input.nodes || []).map((node) => ({ id: node.id, text: shortText(node.text, 700), sourceTrust: node.sourceTrust })),
          edges: (input.edges || []).map((edge) => ({
            id: edge.id,
            from: edge.from,
            to: edge.to,
            mode: edge.mode,
            whyRelevant: shortText(edge.whyRelevant, 500),
          })),
          outputSchema: {
            selectedNodeIds: ["node id"],
            selectedEdgeIds: ["edge id explicitly useful for moving between nodes"],
            rejectedNodeIds: ["node id only if clearly irrelevant"],
            rejectedEdgeIds: ["edge id only if clearly irrelevant or misleading"],
            reasonById: { id: "short reason" },
          },
        }),
        { maxTokens: 1200 },
      );
      return sanitizeSelection(payload, input.nodes || [], input.edges || [], fallback, {
        allowEmpty: input.allowEmpty === true,
      });
    } catch {
      return fallback;
    }
  }

  async writeWhyRelevant(input = {}) {
    const fallback = await super.writeWhyRelevant(input);
    try {
      const text = await this.completeText(
        "You write concise local association notes for a memory graph. The note must explain why the target evidence is worth recalling from the source evidence. Do not make it a global fact.",
        JSON.stringify({
          task: "Write a concise whyRelevant localAssociation edge.",
          rootQuery: input.query,
          from: { id: input.from?.id, text: shortText(input.from?.text || "", 900) },
          to: { id: input.to?.id, text: shortText(input.to?.text || "", 900) },
          constraints: [
            "One or two short sentences.",
            "Explain the local association from from -> to.",
            "Do not say the edge itself is a fact.",
          ],
        }),
        { maxTokens: 300 },
      );
      return cleanOneLine(text) || fallback;
    } catch {
      return fallback;
    }
  }
}

function extractAnthropicText(payload) {
  const content = payload?.content || [];
  const text = content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text || "";
      return "";
    })
    .join("\n")
    .trim();
  if (!text) throw new Error("LLM response contained no text");
  return text;
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON object in LLM response");
    return JSON.parse(match[0]);
  }
}

function sanitizeSelection(payload, nodes, edges, fallback, options = {}) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeIds = new Set(edges.map((edge) => edge.id));
  const cleanIds = (items, allowed) => Array.from(new Set((items || []).filter((id) => allowed.has(id))));
  const selectedNodeIds = cleanIds(payload.selectedNodeIds, nodeIds);
  return {
    selectedNodeIds: selectedNodeIds.length > 0 || options.allowEmpty ? selectedNodeIds : fallback.selectedNodeIds,
    selectedEdgeIds: cleanIds(payload.selectedEdgeIds, edgeIds),
    rejectedNodeIds: cleanIds(payload.rejectedNodeIds, nodeIds),
    rejectedEdgeIds: cleanIds(payload.rejectedEdgeIds, edgeIds),
    reasonById: typeof payload.reasonById === "object" && payload.reasonById ? payload.reasonById : {},
  };
}

function shortText(text, limit = 240) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function cleanOneLine(text) {
  return String(text || "")
    .replace(/^```[a-z]*|```$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
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

module.exports = {
  AnthropicCompatibleReasoner,
  DeterministicReasoner,
  createReasoner,
};
