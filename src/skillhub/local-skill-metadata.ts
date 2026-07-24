import * as fs from 'fs';
import matter from 'gray-matter';
import { computeBotSkillSourceContentHash } from '../bot-skills/source-snapshot';

export interface SkillHubLocalMetadata {
  author?: string;
  version?: string;
  uploadedAt?: string;
}

const SKILLHUB_METADATA_KEYS = {
  author: 'skillhub_author',
  version: 'skillhub_version',
  uploadedAt: 'skillhub_uploaded_at',
} as const;

export function readSkillHubLocalMetadata(skillFilePath: string): SkillHubLocalMetadata | null {
  if (!fs.existsSync(skillFilePath)) return null;
  const parsed = matter(fs.readFileSync(skillFilePath, 'utf8'));
  const metadata = fromMatterData(parsed.data);
  return metadata.author || metadata.version || metadata.uploadedAt ? metadata : null;
}

export function writeSkillHubLocalMetadata(skillFilePath: string, metadata: Required<SkillHubLocalMetadata>): void {
  const raw = fs.readFileSync(skillFilePath, 'utf8');
  fs.writeFileSync(skillFilePath, applySkillHubLocalMetadata(raw, metadata), 'utf8');
}

export function applySkillHubLocalMetadata(markdown: string, metadata: Required<SkillHubLocalMetadata>): string {
  const text = String(markdown || '');
  const fields = {
    [SKILLHUB_METADATA_KEYS.author]: metadata.author,
    [SKILLHUB_METADATA_KEYS.version]: metadata.version,
    [SKILLHUB_METADATA_KEYS.uploadedAt]: metadata.uploadedAt,
  };
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return `---\n${frontmatterLines(fields)}---\n\n${text}`;
  }
  const head = match[1]
    .split(/\r?\n/)
    .filter(line => !/^skillhub_(author|version|uploaded_at)\s*:/.test(line));
  const body = text.slice(match[0].length).replace(/^\r?\n/, '');
  return `---\n${[...head, ...frontmatterLines(fields).trimEnd().split('\n')].filter(Boolean).join('\n')}\n---\n\n${body}`;
}

export function computeLocalSkillContentHash(skillDir: string): string {
  return computeBotSkillSourceContentHash(skillDir);
}

function fromMatterData(data: Record<string, any>): SkillHubLocalMetadata {
  return {
    author: stringOrUndefined(data[SKILLHUB_METADATA_KEYS.author]),
    version: stringOrUndefined(data[SKILLHUB_METADATA_KEYS.version]),
    uploadedAt: stringOrUndefined(data[SKILLHUB_METADATA_KEYS.uploadedAt]),
  };
}

function stringOrUndefined(value: any): string | undefined {
  const text = String(value || '').trim();
  return text || undefined;
}

function frontmatterLines(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}: ${JSON.stringify(String(value))}\n`)
    .join('');
}
