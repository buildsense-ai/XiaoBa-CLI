import { isDeepStrictEqual } from 'util';
import matter from 'gray-matter';

export interface PublicationCandidateFile {
  path: string;
  contentBase64: string;
}

export function createNameWhitespaceCandidate<T extends PublicationCandidateFile[]>(
  files: T,
  report: any,
): T | undefined {
  const blocking = Array.isArray(report?.issues)
    ? report.issues.filter((issue: any) => issue?.blocking === true)
    : [];
  if (report?.coverage !== 'complete' || !blocking.length || blocking.some((issue: any) => (
    issue?.code !== 'metadata.name_whitespace'
    || issue?.repairPolicy !== 'automatic'
    || issue?.location?.field !== 'name'
    || (issue?.location?.relativePath && issue.location.relativePath !== 'SKILL.md')
  ))) return undefined;

  const candidate = files.map(file => ({ ...file })) as T;
  for (const issue of blocking) {
    const index = issue?.location?.entryIndex;
    if (!Number.isInteger(index) || candidate[index]?.path !== 'SKILL.md') return undefined;
    const entry = candidate[index];
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(entry.contentBase64, 'base64'));
    } catch {
      return undefined;
    }
    let before: ReturnType<typeof matter>;
    try {
      before = matter(text);
    } catch {
      return undefined;
    }
    if (typeof before.data?.name !== 'string' || before.data.name === before.data.name.trim()) return undefined;

    const frontmatter = text.match(/^(---[ \t]*(?:yaml[ \t]*)?\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
    if (!frontmatter) return undefined;
    const lines = frontmatter[2].split(/(\r?\n)/);
    let changed = false;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 2) {
      const line = lines[lineIndex];
      const match = line.match(/^(name:[ \t]*)(["'])([^\r\n]*)\2([ \t]*(?:#.*)?)$/);
      if (!match) continue;
      const trimmed = match[3].trim();
      if (!trimmed || trimmed === match[3]) return undefined;
      lines[lineIndex] = `${match[1]}${match[2]}${trimmed}${match[2]}${match[4]}`;
      changed = true;
      break;
    }
    if (!changed) return undefined;
    const nextText = `${frontmatter[1]}${lines.join('')}${frontmatter[3]}${text.slice(frontmatter[0].length)}`;
    if (!isNameWhitespaceOnlyChange(text, nextText)) return undefined;
    candidate[index] = { ...entry, contentBase64: Buffer.from(nextText, 'utf8').toString('base64') };
  }
  const unchanged = files.length === candidate.length
    && files.every(file => candidate.some(next => next.path === file.path && next.contentBase64 === file.contentBase64));
  return unchanged ? undefined : candidate;
}

export function isNameWhitespaceOnlyChange(beforeText: string, afterText: string): boolean {
  try {
    const before = matter(beforeText);
    const after = matter(afterText);
    return typeof before.data?.name === 'string'
      && typeof after.data?.name === 'string'
      && before.data.name !== before.data.name.trim()
      && after.data.name === before.data.name.trim()
      && before.content === after.content
      && isDeepStrictEqual({ ...before.data, name: before.data.name.trim() }, after.data)
      && normalizeNameScalar(beforeText) === normalizeNameScalar(afterText);
  } catch {
    return false;
  }
}

function normalizeNameScalar(text: string): string {
  const lines = text.split(/(?<=\n)/);
  let replaced = false;
  return lines.map(line => {
    if (replaced) return line;
    const match = line.match(/^(name:[ \t]*)(["'])(.*)\2([ \t]*(?:#.*)?)(\r?\n?)$/);
    if (!match) return line;
    replaced = true;
    return `${match[1]}${match[2]}<name>${match[2]}${match[4]}${match[5]}`;
  }).join('');
}
