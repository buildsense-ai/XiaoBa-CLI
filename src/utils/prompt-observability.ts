import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  getPromptOverridesDir,
  isSafePromptOverridesDir,
  readPromptFile,
  resolvePromptPathWithin,
} from './prompt-template';

export interface PromptFileDigest {
  path: string;
  sha256: string;
  short_hash: string;
  bytes: number;
  chars: number;
  lines: number;
  overridden?: boolean;
}

export interface PromptTraceSnapshot {
  source: string;
  prompt_version: string;
  prompts_dir: string;
  generated_at: string;
  system: {
    sha256: string;
    short_hash: string;
    chars: number;
    lines: number;
  };
  bundle: {
    sha256: string;
    short_hash: string;
    file_count: number;
    files: PromptFileDigest[];
  };
  loaded_files: string[];
}

export interface PromptTurnMetadata {
  source: string;
  prompt_version: string;
  system_hash: string;
  system_chars: number;
  bundle_hash: string;
  bundle_file_count: number;
}

export function buildPromptTraceSnapshot(options: {
  promptsDir: string;
  systemPrompt: string;
  source: string;
  loadedFiles?: string[];
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): PromptTraceSnapshot {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const files = listPromptFiles(options.promptsDir);
  const bundleHash = hashText(files.map(file => `${file.path}\0${file.sha256}`).join('\n'));
  const systemHash = hashText(options.systemPrompt);

  return {
    source: options.source,
    prompt_version: (env.CATSCO_PROMPT_VERSION || env.XIAOBA_PROMPT_VERSION || 'local').trim() || 'local',
    prompts_dir: labelPromptDir(options.promptsDir),
    generated_at: now.toISOString(),
    system: {
      sha256: systemHash,
      short_hash: shortHash(systemHash),
      chars: options.systemPrompt.length,
      lines: countLines(options.systemPrompt),
    },
    bundle: {
      sha256: bundleHash,
      short_hash: shortHash(bundleHash),
      file_count: files.length,
      files,
    },
    loaded_files: [...new Set(options.loadedFiles || [])].sort(),
  };
}

export function toPromptTurnMetadata(snapshot: PromptTraceSnapshot): PromptTurnMetadata {
  return {
    source: snapshot.source,
    prompt_version: snapshot.prompt_version,
    system_hash: snapshot.system.short_hash,
    system_chars: snapshot.system.chars,
    bundle_hash: snapshot.bundle.short_hash,
    bundle_file_count: snapshot.bundle.file_count,
  };
}

export function listPromptFiles(promptsDir: string): PromptFileDigest[] {
  const root = path.resolve(promptsDir);
  if (!fs.existsSync(root)) return [];

  const relativePaths: string[] = [];
  walk(root, filePath => {
    if (path.extname(filePath).toLowerCase() !== '.md') return;
    relativePaths.push(normalizeRelativePath(path.relative(root, filePath)));
  });

  return relativePaths.sort((a, b) => a.localeCompare(b)).map(relativePath => {
    const content = readPromptFile(root, relativePath);
    const sha256 = hashText(content);
    return {
      path: relativePath,
      sha256,
      short_hash: shortHash(sha256),
      bytes: Buffer.byteLength(content, 'utf-8'),
      chars: content.length,
      lines: countLines(content),
      ...(isPromptOverridden(root, relativePath) ? { overridden: true } : {}),
    } as PromptFileDigest;
  });
}

export function hashText(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
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

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join('/');
}

function isPromptOverridden(promptsDir: string, relativePath: string): boolean {
  const overridesDir = getPromptOverridesDir();
  if (!overridesDir) return false;
  if (!isSafePromptOverridesDir(promptsDir, overridesDir)) return false;
  try {
    return fs.existsSync(resolvePromptPathWithin(overridesDir, relativePath));
  } catch {
    return false;
  }
}

function labelPromptDir(promptsDir: string): string {
  const resolved = path.resolve(promptsDir);
  if (path.basename(resolved).toLowerCase() === 'prompts') {
    return 'app/prompts';
  }
  return `custom:${shortHash(hashText(resolved))}`;
}
