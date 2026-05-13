"use strict";

const { evidenceNodeId } = require("./store");
const { sourceTrustFor } = require("./state");
const { stableHash } = require("../utils/text");

function lower(value) {
  return String(value || "").toLowerCase();
}

function findCaseInsensitiveMatches(text, term) {
  const matches = [];
  const needle = lower(term);
  if (!needle) return matches;
  const step = Math.max(1, term.length);
  for (let index = 0; index < text.length; index += 1) {
    const candidate = text.slice(index, index + step);
    if (lower(candidate) === needle) {
      matches.push({ start: index, end: index + step });
    }
  }
  return matches;
}

function scanDocs(docs, searchPlan, options = {}) {
  const maxHitsPerTerm = options.maxHitsPerTerm || options.budget?.maxHitsPerTerm || 50;
  const hits = [];
  const hitCountByTerm = new Map();
  for (const termGroup of searchPlan.termGroups || []) {
    const term = String(termGroup.term || "");
    if (!term) continue;
    for (const doc of docs) {
      if ((hitCountByTerm.get(termGroup.id) || 0) >= maxHitsPerTerm) break;
      for (const match of findCaseInsensitiveMatches(doc.text, term)) {
        const count = hitCountByTerm.get(termGroup.id) || 0;
        if (count >= maxHitsPerTerm) break;
        hits.push({
          termId: termGroup.id,
          term,
          doc,
          matchStart: match.start,
          matchEnd: match.end,
        });
        hitCountByTerm.set(termGroup.id, count + 1);
      }
    }
  }
  return hits;
}

function boundaryBefore(text, index) {
  const punct = "\n。！？!?；;.";
  for (let i = index - 1; i >= 0; i -= 1) {
    if (punct.includes(text[i])) return i + 1;
  }
  return 0;
}

function boundaryAfter(text, index) {
  const punct = "\n。！？!?；;.";
  for (let i = index; i < text.length; i += 1) {
    if (punct.includes(text[i])) return i + 1;
  }
  return text.length;
}

function trimSpan(text, start, end) {
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  return { start, end };
}

function evidenceSpanForHit(hit, maxChars) {
  const text = hit.doc.text;
  let start = boundaryBefore(text, hit.matchStart);
  let end = boundaryAfter(text, hit.matchEnd);
  if (end - start > maxChars) {
    const half = Math.floor(maxChars / 2);
    start = Math.max(0, hit.matchStart - half);
    end = Math.min(text.length, hit.matchEnd + half);
  }
  return trimSpan(text, start, end);
}

function extractEvidenceFromHits(hits, options = {}) {
  const maxEvidence = options.maxEvidence || options.budget?.maxEvidence || 20;
  const windows = buildSourceWindowsFromHits(hits, {
    maxEvidence,
    maxEvidenceChars: options.maxEvidenceChars || 280,
  });
  const evidence = windows.map((window) => ({
    windowId: window.id,
    text: window.text,
    reason: "Matched by deterministic source window extraction.",
  }));
  return evidenceNodesFromWindowEvidence(evidence, windows, options);
}

function buildSourceWindowsFromHits(hits, options = {}) {
  const maxEvidence = options.maxEvidence || options.budget?.maxEvidence || 20;
  const maxChars = options.maxEvidenceChars || 280;
  const byId = new Map();
  for (const hit of hits) {
    const span = evidenceSpanForHit(hit, maxChars);
    const text = hit.doc.text.slice(span.start, span.end);
    if (!text.trim()) continue;
    const id = [
      hit.doc.id,
      span.start,
      span.end,
    ].join(":");
    const existing = byId.get(id);
    if (existing) {
      if (!existing.supportingTermIds.includes(hit.termId)) existing.supportingTermIds.push(hit.termId);
      continue;
    }
    byId.set(id, {
      id,
      text,
      doc: hit.doc,
      span,
      supportingTermIds: [hit.termId],
    });
    if (byId.size >= maxEvidence) break;
  }
  return Array.from(byId.values());
}

function evidenceNodesFromWindowEvidence(evidence, windows, options = {}) {
  const maxEvidence = options.maxEvidence || options.budget?.maxEvidence || 20;
  const byId = new Map();
  for (const item of evidence || []) {
    const window = windows.find((candidate) => candidate.id === item.windowId);
    if (!window || typeof item.text !== "string") continue;
    const quote = item.text.trim();
    if (!quote) continue;
    const localStart = window.text.indexOf(quote);
    if (localStart < 0) continue;
    const charStart = window.span.start + localStart;
    const charEnd = charStart + quote.length;
    const sourceRef = {
      ...window.doc.sourceRef,
      charStart,
      charEnd,
    };
    const node = {
      schemaVersion: 1,
      id: evidenceNodeId({ text: quote, sourceRef }),
      text: quote,
      contentHash: stableHash(quote),
      sourceRef,
      sourceTrust: sourceTrustFor(sourceRef),
      createdAt: options.timestamp || new Date().toISOString(),
      createdFromRunId: options.runId,
      extractionReason: item.reason || "",
      supportingTermIds: window.supportingTermIds.slice(),
    };
    const existing = byId.get(node.id);
    if (existing) {
      for (const termId of node.supportingTermIds) {
        if (!existing.supportingTermIds.includes(termId)) existing.supportingTermIds.push(termId);
      }
      continue;
    }
    byId.set(node.id, node);
    if (byId.size >= maxEvidence) break;
  }
  return Array.from(byId.values());
}

function searchTrace(searchPlan, hits, evidence) {
  return (searchPlan.termGroups || []).map((termGroup) => {
    const termHits = hits.filter((hit) => hit.termId === termGroup.id);
    const evidenceCount = evidence.filter((item) => item.supportingTermIds.includes(termGroup.id)).length;
    return {
      termId: termGroup.id,
      pattern: termGroup.term,
      hitCount: termHits.length,
      evidenceCount,
    };
  });
}

module.exports = {
  buildSourceWindowsFromHits,
  evidenceNodesFromWindowEvidence,
  extractEvidenceFromHits,
  findCaseInsensitiveMatches,
  scanDocs,
  searchTrace,
};
