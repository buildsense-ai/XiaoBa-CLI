import * as fs from 'fs';
import * as path from 'path';
import { PromptManager } from './prompt-manager';
import {
  getPromptOverridesDir,
  normalizePromptRelativePath,
  normalizePromptText,
  readPromptFile,
  resolvePromptPathWithin,
} from './prompt-template';
import { buildPromptTraceSnapshot, hashText } from './prompt-observability';

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

  return {
    base_dir: labelLocalPath(baseDir),
    overrides_dir: overridesDir ? labelLocalPath(overridesDir) : undefined,
    writable: Boolean(overridesDir),
    trace: buildPromptTraceSnapshot({
      promptsDir: baseDir,
      systemPrompt,
      source: 'prompt-editor',
      loadedFiles: ['runtime-context.md', 'system-prompt.md'],
    }),
    files,
  };
}

export function getPromptEditorFile(relativePath: string): PromptEditorFileDetail {
  const normalized = normalizeEditablePromptPath(relativePath);
  const baseDir = PromptManager.getPromptsDir();
  const basePath = resolvePromptPathWithin(baseDir, normalized);
  const baseContent = normalizePromptText(fs.readFileSync(basePath, 'utf-8'));
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

  const overridesDir = getPromptOverridesDir();
  if (!overridesDir) {
    throw new Error('Prompt override directory is not configured');
  }

  const outputPath = resolvePromptPathWithin(overridesDir, normalized);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${text}\n`, 'utf-8');
  return getPromptEditorFile(normalized);
}

export function deletePromptOverride(relativePath: string): PromptEditorFileDetail {
  const normalized = normalizeEditablePromptPath(relativePath);
  const overridesDir = getPromptOverridesDir();
  if (overridesDir) {
    const filePath = resolvePromptPathWithin(overridesDir, normalized);
    fs.rmSync(filePath, { force: true });
    pruneEmptyPromptDirs(path.dirname(filePath), overridesDir);
  }
  return getPromptEditorFile(normalized);
}

function listPromptEditorFiles(): PromptEditorFile[] {
  const baseDir = PromptManager.getPromptsDir();
  return listBasePromptPaths(baseDir).map(relativePath => {
    const basePath = resolvePromptPathWithin(baseDir, relativePath);
    const baseContent = normalizePromptText(fs.readFileSync(basePath, 'utf-8'));
    const effectiveContent = readPromptFile(baseDir, relativePath);
    return buildPromptEditorFile(relativePath, baseContent, effectiveContent);
  });
}

function buildPromptEditorFile(relativePath: string, baseContent: string, effectiveContent: string): PromptEditorFile {
  const baseHash = hashText(baseContent);
  const effectiveHash = hashText(effectiveContent);
  return {
    path: relativePath,
    overridden: baseHash !== effectiveHash || promptOverrideExists(relativePath),
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
  const available = new Set(listBasePromptPaths(PromptManager.getPromptsDir()));
  if (!available.has(normalized)) {
    throw new Error(`Prompt file is not editable: ${relativePath}`);
  }
  return normalized;
}

function listBasePromptPaths(baseDir: string): string[] {
  const root = path.resolve(baseDir);
  if (!fs.existsSync(root)) return [];
  const results: string[] = [];
  walk(root, filePath => {
    if (path.extname(filePath).toLowerCase() !== '.md') return;
    results.push(path.relative(root, filePath).split(path.sep).join('/'));
  });
  return results.sort((a, b) => a.localeCompare(b));
}

function promptOverrideExists(relativePath: string): boolean {
  const overridesDir = getPromptOverridesDir();
  if (!overridesDir) return false;
  return fs.existsSync(resolvePromptPathWithin(overridesDir, relativePath));
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

function walk(directory: string, visit: (filePath: string) => void): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(filePath, visit);
    } else if (entry.isFile()) {
      visit(filePath);
    }
  }
}

function labelLocalPath(value: string): string {
  return path.resolve(value);
}
