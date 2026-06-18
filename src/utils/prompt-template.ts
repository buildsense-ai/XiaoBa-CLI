import * as fs from 'fs';
import * as path from 'path';

export const DEFAULT_PROMPTS_DIR = path.join(__dirname, '../../prompts');

export function getPromptBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.XIAOBA_PROMPTS_DIR || env.CATSCO_PROMPTS_DIR || '').trim();
  return explicit ? path.resolve(explicit) : DEFAULT_PROMPTS_DIR;
}

export function getPromptOverridesDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (/^(1|true|yes|on)$/i.test(String(env.XIAOBA_DISABLE_PROMPT_OVERRIDES || '').trim())) {
    return undefined;
  }
  const explicit = (env.XIAOBA_PROMPT_OVERRIDES_DIR || env.CATSCO_PROMPT_OVERRIDES_DIR || '').trim();
  if (explicit) return path.resolve(explicit);
  const userDataDir = (env.XIAOBA_USER_DATA_DIR || env.CATSCO_USER_DATA_DIR || '').trim();
  if (userDataDir) return path.resolve(userDataDir, 'prompt-overrides');
  const runtimeRoot = (env.XIAOBA_RUNTIME_ROOT || '').trim();
  return runtimeRoot ? path.resolve(runtimeRoot, 'prompt-overrides') : undefined;
}

export function isSafePromptOverridesDir(promptsDir: string, overridesDir: string): boolean {
  const base = canonicalPath(promptsDir);
  const overrides = canonicalPath(overridesDir);
  if (base === overrides) return false;
  return !isPathInside(base, overrides) && !isPathInside(overrides, base);
}

export function assertSafePromptOverridesDir(promptsDir: string): string {
  const overridesDir = getPromptOverridesDir();
  if (!overridesDir) {
    throw new Error('Prompt override directory is not configured');
  }
  if (!isSafePromptOverridesDir(promptsDir, overridesDir)) {
    throw new Error('Prompt override directory must be separate from the bundled prompts directory');
  }
  return overridesDir;
}

export function normalizePromptRelativePath(relativePath: string): string {
  const input = String(relativePath || '').replace(/\\/g, '/').trim();
  const normalized = path.posix.normalize(input);
  if (
    !input
    || normalized === '.'
    || normalized.startsWith('../')
    || normalized.includes('/../')
    || path.posix.isAbsolute(normalized)
    || path.posix.extname(normalized).toLowerCase() !== '.md'
  ) {
    throw new Error(`Invalid prompt file path: ${relativePath}`);
  }
  return normalized;
}

export function resolvePromptFilePath(promptsDir: string, relativePath: string): string {
  const normalized = normalizePromptRelativePath(relativePath);
  const overridePath = resolvePromptOverrideFilePath(promptsDir, normalized);
  if (overridePath && fs.existsSync(overridePath)) {
    return overridePath;
  }
  return resolvePromptPathWithin(promptsDir, normalized);
}

export function resolvePromptPathWithin(rootDir: string, relativePath: string): string {
  const normalized = normalizePromptRelativePath(relativePath);
  const root = path.resolve(rootDir);
  const filePath = path.resolve(root, ...normalized.split('/'));
  const relative = path.relative(root, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Invalid prompt file path: ${relativePath}`);
  }
  return filePath;
}

export function resolvePromptOverrideFilePath(promptsDir: string, relativePath: string): string | undefined {
  if (!shouldUsePromptOverrides(promptsDir)) return undefined;
  const overridesDir = getPromptOverridesDir();
  if (overridesDir && !isSafePromptOverridesDir(promptsDir, overridesDir)) return undefined;
  return overridesDir ? resolvePromptPathWithin(overridesDir, relativePath) : undefined;
}

export function readPromptFile(promptsDir: string, relativePath: string): string {
  try {
    return normalizePromptText(fs.readFileSync(resolvePromptFilePath(promptsDir, relativePath), 'utf-8'));
  } catch {
    return '';
  }
}

export function readRequiredPromptFile(promptsDir: string, relativePath: string): string {
  const filePath = resolvePromptFilePath(promptsDir, relativePath);
  try {
    const text = normalizePromptText(fs.readFileSync(filePath, 'utf-8'));
    if (!text) {
      throw new Error(`Prompt file is empty: ${relativePath}`);
    }
    return text;
  } catch (error: any) {
    if (error?.message?.startsWith('Prompt file is empty:')) {
      throw error;
    }
    throw new Error(`Required prompt file is missing or unreadable: ${relativePath}`);
  }
}

export function readDefaultPromptFile(relativePath: string): string {
  return readPromptFile(getPromptBaseDir(), relativePath);
}

export function readRequiredDefaultPromptFile(relativePath: string): string {
  return readRequiredPromptFile(getPromptBaseDir(), relativePath);
}

export function readDefaultPromptLines(relativePath: string): string[] {
  return readDefaultPromptFile(relativePath)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

export function readRequiredDefaultPromptLines(relativePath: string): string[] {
  return readRequiredDefaultPromptFile(relativePath)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

export function renderDefaultPromptFile(
  relativePath: string,
  values: Record<string, string | number | boolean | undefined | null>,
): string {
  return renderPromptTemplate(readDefaultPromptFile(relativePath), values);
}

export function renderRequiredDefaultPromptFile(
  relativePath: string,
  values: Record<string, string | number | boolean | undefined | null>,
): string {
  return renderPromptTemplate(readRequiredDefaultPromptFile(relativePath), values);
}

export function renderPromptTemplate(
  template: string,
  values: Record<string, string | number | boolean | undefined | null>,
): string {
  let rendered = template.replace(/\{\{#([a-zA-Z0-9_]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_match, key, body) => {
    const value = values[key];
    return value === undefined || value === null || value === false || value === '' ? '' : body;
  });

  rendered = rendered.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key) => {
    const value = values[key];
    return value === undefined || value === null ? '' : String(value);
  });

  return normalizePromptText(rendered);
}

export function normalizePromptText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function shouldUsePromptOverrides(promptsDir: string): boolean {
  const overridesDir = getPromptOverridesDir();
  if (!overridesDir) return false;
  const resolved = path.resolve(promptsDir);
  return resolved === path.resolve(getPromptBaseDir()) || resolved === path.resolve(DEFAULT_PROMPTS_DIR);
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}
