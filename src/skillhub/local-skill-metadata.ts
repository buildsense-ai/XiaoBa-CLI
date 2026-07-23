import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';

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

const SOURCE_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '__pycache__',
]);

const GENERATED_PACKAGE_FILES = new Set([
  'skill.json',
  'REVIEW.json',
  'SBOM.json',
  '.xiaoba-bundled-skill.json',
  '.xiaoba-skillhub-install.json',
  '.xiaoba-local-skill.json',
]);

export function readSkillHubLocalMetadata(skillFilePath: string): SkillHubLocalMetadata | null {
  if (!fs.existsSync(skillFilePath)) return null;
  const parsed = matter(fs.readFileSync(skillFilePath, 'utf8'));
  const metadata = fromMatterData(parsed.data);
  return metadata.author || metadata.version || metadata.uploadedAt ? metadata : null;
}

export function writeSkillHubLocalMetadata(skillFilePath: string, metadata: Required<SkillHubLocalMetadata>): void {
  const raw = fs.readFileSync(skillFilePath, 'utf8');
  const updated = applySkillHubLocalMetadata(raw, metadata);
  matter(updated);
  const temporary = path.join(
    path.dirname(skillFilePath),
    `.${path.basename(skillFilePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  fs.writeFileSync(temporary, updated, { encoding: 'utf8', flag: 'wx' });
  try {
    fs.renameSync(temporary, skillFilePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
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
  const root = path.resolve(skillDir);
  const files = walkSkillFiles(root);
  const initialFingerprint = fingerprintFiles(root, files);
  const entries = files
    .map(filePath => {
      const relative = path.relative(root, filePath).replace(/\\/g, '/');
      const hashPath = canonicalSkillHashPath(relative);
      const before = fs.lstatSync(filePath);
      if (!before.isFile() || before.isSymbolicLink()) {
        throw new Error(`Skill hash input is not a regular file: ${filePath}`);
      }
      const buffer = skillHashBuffer(hashPath, fs.readFileSync(filePath));
      const after = fs.lstatSync(filePath);
      if (
        !after.isFile()
        || after.isSymbolicLink()
        || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs
        || before.ino !== after.ino
      ) {
        throw new Error(`Skill changed while its content hash was being computed: ${filePath}`);
      }
      return {
        path: hashPath,
        size: buffer.length,
        sha256: sha256(buffer),
      };
    })
    .sort((a, b) => compareUtf8(a.path, b.path));
  const afterFiles = walkSkillFiles(root);
  const afterFingerprint = fingerprintFiles(root, afterFiles);
  if (initialFingerprint !== afterFingerprint) {
    throw new Error(`Skill changed while its file list was being hashed: ${root}`);
  }
  return sha256(Buffer.from(JSON.stringify(entries), 'utf8'));
}

function fingerprintFiles(root: string, files: string[]): string {
  return JSON.stringify(files.map(filePath => {
    const stat = fs.lstatSync(filePath);
    return {
      path: canonicalSkillHashPath(path.relative(root, filePath).replace(/\\/g, '/')),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ino: stat.ino,
      regular: stat.isFile() && !stat.isSymbolicLink(),
    };
  }).sort((left, right) => compareUtf8(left.path, right.path)));
}

function skillHashBuffer(relativePath: string, buffer: Buffer): Buffer {
  if (relativePath !== 'SKILL.md') return buffer;
  return Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

function canonicalSkillHashPath(relativePath: string): string {
  return relativePath === 'SKILL.md.disabled' ? 'SKILL.md' : relativePath;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function fromMatterData(data: Record<string, any>): SkillHubLocalMetadata {
  return {
    author: stringOrUndefined(data[SKILLHUB_METADATA_KEYS.author]),
    version: stringOrUndefined(data[SKILLHUB_METADATA_KEYS.version]),
    uploadedAt: stringOrUndefined(data[SKILLHUB_METADATA_KEYS.uploadedAt]),
  };
}

function walkSkillFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (current: string): void => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SOURCE_SKIP_DIRS.has(entry.name)) visit(fullPath);
      } else if (entry.isFile() && !GENERATED_PACKAGE_FILES.has(entry.name)) {
        result.push(fullPath);
      }
    }
  };
  visit(root);
  return result;
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

function sha256(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
