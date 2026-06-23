import * as fs from 'fs';
import * as path from 'path';
import { ContentBlock, Message } from '../types';
import { Logger } from '../utils/logger';
import {
  SyntheticObservation,
  SyntheticObservationEvidence,
  SyntheticObservationQueue,
} from './synthetic-observation';

export interface MemorySidecarBranchOptions {
  sessionKey: string;
  input: string | ContentBlock[];
  recentMessages: Message[];
  workingDirectory: string;
  queue: SyntheticObservationQueue;
  signal?: AbortSignal;
}

export interface MemorySidecarBranchHandle {
  cancel(): void;
  done: Promise<void>;
}

const MAX_SEARCH_FILES = 80;
const MAX_RESULTS = 6;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_RECENT_MESSAGES = 8;
const MIN_SCORE = 2;

export function startMemorySidecarBranch(options: MemorySidecarBranchOptions): MemorySidecarBranchHandle {
  const controller = new AbortController();
  const done = runMemorySidecarBranch(options, controller.signal).catch(error => {
    if (isAbortError(error) || options.signal?.aborted || controller.signal.aborted) return;
    Logger.warning(`[${options.sessionKey}] memory sidecar failed: ${error.message}`);
  });

  return {
    cancel: () => controller.abort(),
    done,
  };
}

async function runMemorySidecarBranch(
  options: MemorySidecarBranchOptions,
  localSignal: AbortSignal,
): Promise<void> {
  const startedAt = Date.now();
  const userInput = contentToText(options.input);
  if (!userInput.trim()) return;
  throwIfAborted(options.signal, localSignal);

  const terms = buildSearchTerms(userInput, options.recentMessages);
  if (terms.length === 0) return;

  const roots = resolveMemoryRoots(options.workingDirectory);
  if (roots.length === 0) return;

  const files = await collectCandidateFiles(roots, options.signal, localSignal);
  throwIfAborted(options.signal, localSignal);

  const matches: ScoredMemoryMatch[] = [];
  for (const file of files.slice(0, MAX_SEARCH_FILES)) {
    throwIfAborted(options.signal, localSignal);
    const fileMatches = await searchFile(file, terms, options.signal, localSignal);
    matches.push(...fileMatches);
  }

  const top = matches
    .sort((a, b) => b.score - a.score || b.timestamp.localeCompare(a.timestamp))
    .slice(0, MAX_RESULTS);

  if (top.length === 0 || top[0].score < MIN_SCORE) return;

  const observation = buildObservation({
    sessionKey: options.sessionKey,
    userInput,
    terms,
    matches: top,
    durationMs: Date.now() - startedAt,
  });
  options.queue.push(observation);
}

interface ScoredMemoryMatch {
  score: number;
  filePath: string;
  timestamp: string;
  sessionId?: string;
  turn?: number;
  snippet: string;
  reason: string;
}

async function collectCandidateFiles(
  roots: string[],
  outerSignal?: AbortSignal,
  localSignal?: AbortSignal,
): Promise<string[]> {
  const candidates: Array<{ file: string; mtimeMs: number }> = [];
  for (const root of roots) {
    await walkJsonl(root, candidates, outerSignal, localSignal);
  }
  return candidates
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(item => item.file);
}

async function walkJsonl(
  dir: string,
  output: Array<{ file: string; mtimeMs: number }>,
  outerSignal?: AbortSignal,
  localSignal?: AbortSignal,
): Promise<void> {
  throwIfAborted(outerSignal, localSignal);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    throwIfAborted(outerSignal, localSignal);
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkJsonl(fullPath, output, outerSignal, localSignal);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    try {
      const stat = await fs.promises.stat(fullPath);
      if (stat.size > MAX_FILE_BYTES) continue;
      output.push({ file: fullPath, mtimeMs: stat.mtimeMs });
    } catch {
      // ignore unreadable files
    }
  }
}

async function searchFile(
  filePath: string,
  terms: string[],
  outerSignal?: AbortSignal,
  localSignal?: AbortSignal,
): Promise<ScoredMemoryMatch[]> {
  throwIfAborted(outerSignal, localSignal);
  let content = '';
  try {
    content = await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const matches: ScoredMemoryMatch[] = [];
  const lines = content.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    throwIfAborted(outerSignal, localSignal);
    const lower = line.toLowerCase();
    const matchedTerms = terms.filter(term => lower.includes(term.toLowerCase()));
    if (matchedTerms.length === 0) continue;

    let parsed: any = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = null;
    }

    const text = parsed ? extractRecordText(parsed) : line;
    const score = scoreText(text, matchedTerms);
    if (score <= 0) continue;

    matches.push({
      score,
      filePath,
      timestamp: String(parsed?.timestamp || ''),
      sessionId: parsed?.session_id,
      turn: typeof parsed?.turn === 'number' ? parsed.turn : undefined,
      snippet: compactText(text, 700),
      reason: `matched ${matchedTerms.slice(0, 5).join(', ')}`,
    });
  }
  return matches;
}

function buildObservation(params: {
  sessionKey: string;
  userInput: string;
  terms: string[];
  matches: ScoredMemoryMatch[];
  durationMs: number;
}): SyntheticObservation {
  const evidence: SyntheticObservationEvidence[] = params.matches.map(match => ({
    sourceType: 'session',
    title: match.sessionId || path.basename(match.filePath),
    pathOrUrl: path.relative(process.cwd(), match.filePath) || match.filePath,
    locator: [
      match.turn !== undefined ? `turn ${match.turn}` : '',
      match.timestamp,
    ].filter(Boolean).join(' | '),
    snippet: match.snippet,
    relevanceReason: match.reason,
  }));

  const keyFacts = params.matches.slice(0, 4).map(match => {
    const label = match.sessionId ? `${match.sessionId}${match.turn !== undefined ? ` turn ${match.turn}` : ''}` : path.basename(match.filePath);
    return `${label}: ${compactText(match.snippet, 220)}`;
  });

  return {
    id: `memory-${Date.now().toString(36)}`,
    source: 'memory',
    status: 'completed',
    relevance: params.matches[0]?.score >= 5 ? 'high' : 'medium',
    confidence: Math.min(0.95, 0.45 + params.matches[0].score * 0.08),
    userIntent: compactText(params.userInput, 300),
    summary: [
      'Memory sidecar found potentially relevant prior session context.',
      'Use it only if it helps answer the current user request; ignore it if it conflicts with newer user input.',
    ].join(' '),
    keyFacts,
    evidence,
    recommendedUse: {
      shouldUse: true,
      howToUse: 'Use these prior-session snippets as background facts, preferences, or prior decisions. Do not mention the memory search unless it is useful to the user.',
      missingInfo: evidence.length === 0 ? ['No matching session evidence was found.'] : undefined,
    },
    debug: {
      queries: params.terms.slice(0, 12),
      toolsUsed: ['session-log-search'],
      durationMs: params.durationMs,
    },
  };
}

function resolveMemoryRoots(workingDirectory: string): string[] {
  const roots = [
    path.resolve(workingDirectory, 'logs', 'sessions'),
    path.resolve(workingDirectory, 'data', 'sessions'),
    path.resolve(process.cwd(), 'logs', 'sessions'),
    path.resolve(process.cwd(), 'data', 'sessions'),
  ];
  return Array.from(new Set(roots)).filter(root => {
    try {
      return fs.existsSync(root) && fs.statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
}

function buildSearchTerms(userInput: string, recentMessages: Message[]): string[] {
  const basis = [
    userInput,
    ...recentMessages.slice(-MAX_RECENT_MESSAGES).map(message => contentToText(message.content)),
  ].join('\n');

  const terms = new Set<string>();
  for (const token of basis.match(/[A-Za-z0-9_\-./:@#]{3,}/g) || []) {
    const normalized = token.toLowerCase();
    if (STOP_WORDS.has(normalized)) continue;
    terms.add(normalized);
  }
  for (const token of basis.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    if (token.length <= 8) {
      terms.add(token);
    } else {
      for (let i = 0; i < token.length - 1 && i < 16; i += 2) {
        terms.add(token.slice(i, Math.min(token.length, i + 4)));
      }
    }
  }
  return Array.from(terms).slice(0, 24);
}

function scoreText(text: string, matchedTerms: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const term of matchedTerms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const occurrences = lower.match(new RegExp(escaped, 'g'))?.length || 0;
    score += Math.min(3, occurrences);
  }
  if (/decision|决定|偏好|previous|之前|记得|remember|error|失败|修复|fix/i.test(text)) {
    score += 1;
  }
  return score;
}

function extractRecordText(record: any): string {
  const parts: string[] = [];
  if (record.user?.text) parts.push(`User: ${record.user.text}`);
  if (record.assistant?.text) parts.push(`Assistant: ${record.assistant.text}`);
  const toolCalls = Array.isArray(record.assistant?.tool_calls) ? record.assistant.tool_calls : [];
  for (const tool of toolCalls.slice(0, 4)) {
    parts.push(`Tool ${tool.name || 'unknown'}: ${compactText(String(tool.result || tool.arguments || ''), 300)}`);
  }
  if (parts.length === 0) return JSON.stringify(record);
  return parts.join('\n');
}

function contentToText(content: string | ContentBlock[] | null): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => block.type === 'text' ? block.text : '').join('\n');
}

function compactText(text: string, maxChars: number): string {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

function throwIfAborted(...signals: Array<AbortSignal | undefined>): void {
  if (signals.some(signal => signal?.aborted)) {
    const error = new Error('memory sidecar aborted');
    error.name = 'AbortError';
    throw error;
  }
}

function isAbortError(error: any): boolean {
  return error?.name === 'AbortError' || /aborted|cancelled|canceled/i.test(String(error?.message || ''));
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'into', 'about',
  'what', 'when', 'where', 'which', 'your', 'have', 'has', 'was', 'were',
  'are', 'but', 'not', 'you', 'can', 'could', 'should', 'would',
]);
