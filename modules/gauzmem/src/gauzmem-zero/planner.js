"use strict";

const { extractKeywords, normalizeText } = require("../utils/text");

function uniqueTerms(items, limit) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const term = normalizeText(item);
    if (!term || term.length < 2) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= limit) break;
  }
  return out;
}

function cjkWindows(text) {
  const out = [];
  const runs = String(text || "").match(/[\u3400-\u9fff]{2,}/g) || [];
  for (const run of runs) {
    if (run.length <= 8) out.push(run);
    for (let size = 2; size <= 4; size += 1) {
      for (let i = 0; i + size <= run.length; i += 1) {
        out.push(run.slice(i, i + size));
      }
    }
  }
  return out;
}

function createSearchPlan(input = {}) {
  const query = String(input.query || "");
  const explicit = Array.isArray(input.searchTerms) ? input.searchTerms : [];
  const quoted = Array.from(query.matchAll(/"([^"]+)"|'([^']+)'|`([^`]+)`/g))
    .map((match) => match[1] || match[2] || match[3]);
  const ascii = query.match(/[A-Za-z][A-Za-z0-9_./:-]{1,}/g) || [];
  const maxTerms = input.maxTerms || input.budget?.maxTerms || 12;
  const terms = uniqueTerms([
    ...explicit,
    ...quoted,
    ...ascii,
    ...extractKeywords(query, maxTerms * 2),
    ...cjkWindows(query),
  ], maxTerms);
  return {
    mode: "deterministic",
    termGroups: terms.map((term, index) => ({
      id: `term_${index + 1}`,
      term,
      rationale: "Generated from the root query without embedding or BM25.",
    })),
  };
}

module.exports = {
  createSearchPlan,
};
