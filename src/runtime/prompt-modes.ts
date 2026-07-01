import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { Message } from '../types';
import {
  getPromptBaseDir,
  getPromptOverridesDir,
  normalizePromptText,
  resolvePromptFilePath,
} from '../utils/prompt-template';

export const TRANSIENT_PROMPT_MODES_LIST_PREFIX = '[transient_prompt_modes_list]';
export const TRANSIENT_FIXED_PROMPT_MODE_PREFIX = '[transient_fixed_prompt_mode]';

export type PromptModeId = string;

export interface PromptModeDefinition {
  id: PromptModeId;
  title: string;
  description: string;
  filePath: string;
  content: string;
}

export interface PreviousPromptModeState {
  mode: PromptModeId;
  title: string;
  turnsSinceLoaded: number;
}

export interface BuildPromptModesListMessageOptions {
  promptsDir?: string;
  previousMode?: PreviousPromptModeState;
}

export interface FixedPromptModeState {
  mode: PromptModeId;
  title: string;
}

export function listPromptModeDefinitions(promptsDir = getPromptBaseDir()): PromptModeDefinition[] {
  const root = path.resolve(promptsDir);
  return listPromptModeFiles(root)
    .map(fileName => loadPromptModeDefinition(root, fileName))
    .filter((definition): definition is PromptModeDefinition => Boolean(definition))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function clearPromptModeRegistryCache(): void {
  // Kept for tests and future cached implementations. The current registry is
  // file-backed on every read so prompt edits take effect without a restart.
}

export function listPromptModeIds(promptsDir = getPromptBaseDir()): PromptModeId[] {
  return listPromptModeDefinitions(promptsDir).map(definition => definition.id);
}

export function getPromptModeDefinition(
  mode: unknown,
  promptsDir = getPromptBaseDir(),
): PromptModeDefinition | undefined {
  const normalized = normalizePromptModeSlug(mode);
  if (!normalized) return undefined;
  return listPromptModeDefinitions(promptsDir)
    .find(definition => definition.id === normalized);
}

export function isPromptModeId(value: unknown, promptsDir = getPromptBaseDir()): value is PromptModeId {
  return Boolean(getPromptModeDefinition(value, promptsDir));
}

export function normalizePromptModeId(value: unknown, promptsDir = getPromptBaseDir()): PromptModeId | undefined {
  return getPromptModeDefinition(value, promptsDir)?.id;
}

export function loadPromptModePrompt(promptsDir: string, mode: unknown): string | undefined {
  const definition = getPromptModeDefinition(mode, promptsDir);
  if (!definition?.content) return undefined;
  return [`[mode:${definition.id}]`, definition.content].join('\n');
}

export function findFixedPromptModeState(
  messages: Message[],
  promptsDir = getPromptBaseDir(),
): FixedPromptModeState | undefined {
  for (const message of messages) {
    if (message.role !== 'system' || typeof message.content !== 'string') continue;
    const mode = parseLoadedPromptModeId(message.content);
    const definition = getPromptModeDefinition(mode, promptsDir);
    if (!definition) continue;
    return {
      mode: definition.id,
      title: definition.title,
    };
  }
  return undefined;
}

export function buildFixedPromptModeMessage(
  fixedMode: FixedPromptModeState,
): Message {
  return {
    role: 'user',
    content: [
      TRANSIENT_FIXED_PROMPT_MODE_PREFIX,
      `Fixed prompt mode active: ${fixedMode.mode} (${fixedMode.title}).`,
      'This mode is already part of the system prompt.',
      'Do not load another prompt mode unless the runtime profile changes.',
    ].join('\n'),
    __injected: true,
  };
}

export function findPreviousPromptModeState(
  messages: Message[],
  options: { promptsDir?: string; maxTurnsSinceLoaded?: number } = {},
): PreviousPromptModeState | undefined {
  const promptsDir = options.promptsDir ?? getPromptBaseDir();
  const maxTurnsSinceLoaded = options.maxTurnsSinceLoaded ?? 5;
  let turnsSinceLoaded = 0;

  for (let idx = messages.length - 1; idx >= 0; idx--) {
    const message = messages[idx];
    if (message.role === 'user' && !message.__injected) {
      turnsSinceLoaded += 1;
    }
    if (message.role !== 'tool' || message.name !== 'prompt_mode') continue;

    const mode = parseLoadedPromptModeId(message.content);
    const definition = getPromptModeDefinition(mode, promptsDir);
    if (!definition) continue;
    if (turnsSinceLoaded > maxTurnsSinceLoaded) return undefined;

    return {
      mode: definition.id,
      title: definition.title,
      turnsSinceLoaded,
    };
  }

  return undefined;
}

export function buildPromptModesListMessage(
  options: BuildPromptModesListMessageOptions = {},
): Message | undefined {
  const promptsDir = options.promptsDir ?? getPromptBaseDir();
  const modes = listPromptModeDefinitions(promptsDir);
  if (modes.length === 0) return undefined;

  const modeList = modes
    .map(mode => `- ${mode.id}: ${mode.title}${mode.description ? ` - ${mode.description}` : ''}`)
    .join('\n');
  const previousMode = options.previousMode
    ? [
      '',
      `Previously active prompt mode: ${options.previousMode.mode} (${options.previousMode.title}), last loaded ${formatTurnsAgo(options.previousMode.turnsSinceLoaded)}.`,
      'Use the previous mode only if the current user message continues the same task. If the user changed task, ignore it.',
      'Do not load prompt modes directly; current mode selection is handled by runtime routing.',
    ].join('\n')
    : '';

  return {
    role: 'user',
    content: [
      TRANSIENT_PROMPT_MODES_LIST_PREFIX,
      'Available prompt modes. This is routing context, not a user request.',
      'Do not select or load prompt modes directly; current mode selection is handled by runtime routing.',
      'If no active mode is supplied by runtime routing, answer normally.',
      previousMode,
      '',
      modeList,
    ].join('\n'),
    __injected: true,
  };
}

function listPromptModeFiles(promptsDir: string): string[] {
  const fileNames = new Set<string>();

  addModeFilesFromDir(path.join(promptsDir, 'modes'), fileNames);
  const overridesDir = getPromptOverridesDir();
  if (overridesDir) {
    addModeFilesFromDir(path.join(overridesDir, 'modes'), fileNames);
  }

  return [...fileNames].sort();
}

function addModeFilesFromDir(dirPath: string, fileNames: Set<string>): void {
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        fileNames.add(entry.name);
      }
    }
  } catch {
    // Missing prompt mode directories are allowed.
  }
}

function loadPromptModeDefinition(
  promptsDir: string,
  fileName: string,
): PromptModeDefinition | undefined {
  const relativePath = `modes/${fileName}`;
  const filePath = resolvePromptFilePath(promptsDir, relativePath);
  let parsed: matter.GrayMatterFile<string>;

  try {
    parsed = matter(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return undefined;
  }

  const data = parsed.data || {};
  const id = normalizePromptModeSlug(data.id) || normalizePromptModeSlug(path.basename(fileName, '.md'));
  if (!id) return undefined;

  return {
    id,
    title: firstNonEmptyString(data.name, data.title, id),
    description: firstNonEmptyString(data.description, ''),
    filePath,
    content: normalizePromptText(parsed.content),
  };
}

function parseLoadedPromptModeId(content: Message['content']): string | undefined {
  if (typeof content !== 'string') return undefined;
  const match = content.match(/\[mode:([a-z0-9_-]+)\]/i);
  return normalizePromptModeSlug(match?.[1]);
}

function formatTurnsAgo(turnsSinceLoaded: number): string {
  if (turnsSinceLoaded <= 0) return 'in this turn';
  if (turnsSinceLoaded === 1) return '1 user turn ago';
  return `${turnsSinceLoaded} user turns ago`;
}

function normalizePromptModeSlug(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]*$/.test(normalized) ? normalized : undefined;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}
