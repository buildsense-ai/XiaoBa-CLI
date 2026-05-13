"use strict";

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "with",
  "is", "are", "was", "were", "be", "been", "by", "as", "at", "from",
  "that", "this", "it", "we", "you", "they", "he", "she", "i", "not",
  "要", "的", "了", "是", "在", "和", "或", "也", "就", "都", "而", "及",
]);

function normalizeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ \u00a0]+/g, " ")
    .trim();
}

function tokenize(text) {
  const normalized = normalizeText(text).toLowerCase();
  const ascii = normalized.match(/[a-z0-9_./:-]{2,}/g) || [];
  const cjk = normalized.match(/[\u3400-\u9fff]{1,}/g) || [];
  const cjkTokens = [];
  for (const run of cjk) {
    for (let i = 0; i < run.length; i += 1) {
      cjkTokens.push(run[i]);
      if (i + 1 < run.length) cjkTokens.push(run.slice(i, i + 2));
      if (i + 2 < run.length) cjkTokens.push(run.slice(i, i + 3));
    }
  }
  return ascii.concat(cjkTokens).filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

function splitSentences(text) {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  return normalized
    .split(/(?<=[。！？!?；;.\n])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function extractKeywords(text, limit = 12) {
  const counts = new Map();
  for (const token of tokenize(text)) {
    if (token.length === 1 && !/[\u3400-\u9fff]/.test(token)) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([token]) => token.length > 1)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([token]) => token);
}

function stableHash(input) {
  const text = String(input || "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const av = a[key] || 0;
    const bv = b[key] || 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

module.exports = {
  normalizeText,
  tokenize,
  splitSentences,
  extractKeywords,
  stableHash,
  cosineSimilarity,
};
