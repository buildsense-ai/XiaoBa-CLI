import * as fs from 'fs';
import * as path from 'path';
import { PromptManager } from './prompt-manager';
import {
  assertSafePromptOverridesDir,
  getBundledPromptsDir,
  getPromptOverridesDir,
  isSafePromptOverridesDir,
  normalizePromptRelativePath,
  normalizePromptText,
  readRequiredBundledPromptFile,
  readPromptFile,
  resolvePromptPathWithin,
  SYSTEM_PROMPT_RELATIVE_PATH,
} from './prompt-template';
import { buildPromptTraceSnapshot, hashText } from './prompt-observability';
import { BRANCH_AGENTS_ENABLED_ENV } from '../core/branch-agent-settings';
import { loadBranchAgentConfig } from '../core/branch-agent-config';

const MAX_PROMPT_EDIT_BYTES = 256 * 1024;

export interface PromptEditorFile {
  path: string;
  overridden: boolean;
  base: {
    sha256: string;
    short_hash: string;
    chars: number;
    lines: number;
  };
  effective: {
    sha256: string;
    short_hash: string;
    chars: number;
    lines: number;
  };
}

export interface PromptEditorState {
  base_dir: string;
  overrides_dir?: string;
  writable: boolean;
  trace: ReturnType<typeof buildPromptTraceSnapshot>;
  files: PromptEditorFile[];
  branch_agents: PromptBranchAgentsState;
}

export interface PromptBranchAgentsState {
  enabled: boolean;
  env_key: string;
}

export interface PromptEditorFileDetail extends PromptEditorFile {
  content: string;
  base_content: string;
}

export async function getPromptEditorState(): Promise<PromptEditorState> {
  const baseDir = PromptManager.getPromptsDir();
  const systemPrompt = await PromptManager.buildSystemPrompt();
  const files = listPromptEditorFiles();
  const overridesDir = getPromptOverridesDir();
  const writable = Boolean(overridesDir && isSafePromptOverridesDir(baseDir, overridesDir));

  return {
    base_dir: labelLocalPath(getBundledPromptsDir()),
    overrides_dir: overridesDir ? labelLocalPath(overridesDir) : undefined,
    writable,
    trace: buildPromptTraceSnapshot({
      promptsDir: baseDir,
      systemPrompt,
      source: 'prompt-editor',
      loadedFiles: ['runtime-context.md', 'system-prompt.md'],
    }),
    files,
    branch_agents: getPromptBranchAgentsState(),
  };
}

export function getPromptBranchAgentsState(): PromptBranchAgentsState {
  return {
    enabled: loadBranchAgentConfig().branches.memorySearch.enabled,
    env_key: BRANCH_AGENTS_ENABLED_ENV,
  };
}

export function getPromptEditorFile(relativePath: string): PromptEditorFileDetail {
  const normalized = normalizeEditablePromptPath(relativePath);
  const baseDir = PromptManager.getPromptsDir();
  const baseContent = readRequiredBundledPromptFile(normalized);
  const content = readPromptFile(baseDir, normalized);
  const file = buildPromptEditorFile(normalized, baseContent, content);
  return {
    ...file,
    content,
    base_content: baseContent,
  };
}

export function writePromptOverride(relativePath: string, content: string): PromptEditorFileDetail {
  const normalized = normalizeEditablePromptPath(relativePath);
  const text = normalizePromptText(String(content ?? ''));
  const bytes = Buffer.byteLength(text, 'utf-8');
  if (bytes > MAX_PROMPT_EDIT_BYTES) {
    throw new Error(`Prompt file is too large: ${bytes} bytes`);
  }
  if (!text) {
    throw new Error('Prompt content cannot be empty');
  }

  const baseDir = PromptManager.getPromptsDir();
  const overridesDir = assertSafePromptOverridesDir(baseDir);

  const outputPath = resolvePromptPathWithin(overridesDir, normalized);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${text}\n`, 'utf-8');
  return getPromptEditorFile(normalized);
}

export function deletePromptOverride(relativePath: string): PromptEditorFileDetail {
  const normalized = normalizeEditablePromptPath(relativePath);
  const baseDir = PromptManager.getPromptsDir();
  const overridesDir = getPromptOverridesDir();
  if (overridesDir) {
    assertSafePromptOverridesDir(baseDir);
    const filePath = resolvePromptPathWithin(overridesDir, normalized);
    fs.rmSync(filePath, { force: true });
    pruneEmptyPromptDirs(path.dirname(filePath), overridesDir);
  }
  return getPromptEditorFile(normalized);
}

function listPromptEditorFiles(): PromptEditorFile[] {
  const baseDir = PromptManager.getPromptsDir();
  return [SYSTEM_PROMPT_RELATIVE_PATH].map(relativePath => {
    const baseContent = readRequiredBundledPromptFile(relativePath);
    const effectiveContent = readPromptFile(baseDir, relativePath);
    return buildPromptEditorFile(relativePath, baseContent, effectiveContent);
  });
}

function buildPromptEditorFile(relativePath: string, baseContent: string, effectiveContent: string): PromptEditorFile {
  const baseHash = hashText(baseContent);
  const effectiveHash = hashText(effectiveContent);
  return {
    path: relativePath,
    overridden: baseHash !== effectiveHash,
    base: textDigest(baseContent),
    effective: textDigest(effectiveContent),
  };
}

function textDigest(text: string): PromptEditorFile['effective'] {
  const sha256 = hashText(text);
  return {
    sha256,
    short_hash: sha256.slice(0, 12),
    chars: text.length,
    lines: text ? text.split(/\r?\n/).length : 0,
  };
}

function normalizeEditablePromptPath(relativePath: string): string {
  const normalized = normalizePromptRelativePath(relativePath);
  if (normalized !== SYSTEM_PROMPT_RELATIVE_PATH) {
    throw new Error(`Prompt file is not editable: ${relativePath}`);
  }
  return normalized;
}

function pruneEmptyPromptDirs(startDir: string, rootDir: string): void {
  const root = path.resolve(rootDir);
  let current = path.resolve(startDir);
  while (current.startsWith(root) && current !== root) {
    try {
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

function labelLocalPath(value: string): string {
  return path.resolve(value);
}
