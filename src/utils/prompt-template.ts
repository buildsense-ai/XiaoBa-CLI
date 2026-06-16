import * as fs from 'fs';
import * as path from 'path';

export const DEFAULT_PROMPTS_DIR = path.join(__dirname, '../../prompts');

export function readPromptFile(promptsDir: string, relativePath: string): string {
  try {
    return normalizePromptText(fs.readFileSync(path.join(promptsDir, relativePath), 'utf-8'));
  } catch {
    return '';
  }
}

export function readDefaultPromptFile(relativePath: string): string {
  return readPromptFile(DEFAULT_PROMPTS_DIR, relativePath);
}

export function readDefaultPromptLines(relativePath: string): string[] {
  return readDefaultPromptFile(relativePath)
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
