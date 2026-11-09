import { isDeepStrictEqual } from 'util';
import matter from 'gray-matter';

export interface PublicationCandidateFile {
  path: string;
  contentBase64: string;
}

export function normalizeDirectoryNameToSkillName(directoryName: string): string | undefined {
  const input = String(directoryName || '')
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  if (!input || /[^\x00-\x7f]/.test(input)) return undefined;
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (normalized.length > 72) return undefined;
  return /^[a-z0-9](?:[a-z0-9-]{0,70}[a-z0-9])?$/.test(normalized) ? normalized : undefined;
}

export function createMissingNameCandidate<T extends PublicationCandidateFile[]>(
  files: T,
  report: any,
  directoryName: string,
): { files: T; name: string } | undefined {
  const blocking = Array.isArray(report?.issues)
    ? report.issues.filter((issue: any) => issue?.blocking === true)
    : [];
  const nameIssues = blocking.filter((issue: any) => issue?.code === 'metadata.name_missing');
  const name = normalizeDirectoryNameToSkillName(directoryName);
  if (report?.coverage !== 'complete' || !nameIssues.length || !name || blocking.some((issue: any) => {
    const location = issue?.location;
    if (!Number.isInteger(location?.entryIndex) || files[location.entryIndex]?.path !== 'SKILL.md'
      || (location?.relativePath && location.relativePath !== 'SKILL.md')) return true;
    if (issue?.code === 'metadata.name_missing') {
      return issue?.category !== 'format' || issue?.repairPolicy !== 'automatic' || location?.field !== 'name';
    }
    if (issue?.code === 'metadata.description_missing') {
      return issue?.category !== 'format' || issue?.repairPolicy !== 'confirmation_required' || location?.field !== 'description'
        || !nameIssues.some((nameIssue: any) => nameIssue?.location?.entryIndex === location.entryIndex);
    }
    return true;
  })) return undefined;

  const candidate = files.map(file => ({ ...file })) as T;
  for (const issue of nameIssues) {
    const index = issue?.location?.entryIndex;
    if (!Number.isInteger(index) || candidate[index]?.path !== 'SKILL.md') return undefined;
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(candidate[index].contentBase64, 'base64'));
    } catch {
      return undefined;
    }
    const frontmatter = text.match(/^(---[ \t]*\r?\n)([\s\S]*?)(^---[ \t]*(?:\r?\n|$))/m);
    if (!frontmatter) return undefined;
    try {
      const before = matter(text);
      if (Object.prototype.hasOwnProperty.call(before.data, 'name')) return undefined;
      const lineEnding = text.includes('\r\n') ? '\r\n' : '\n';
      const body = frontmatter[2];
      const separator = body.endsWith(lineEnding) ? '' : lineEnding;
      const nextText: string = `${frontmatter[1]}${body}${separator}name: ${JSON.stringify(name)}${lineEnding}${frontmatter[3]}${text.slice(frontmatter[0].length)}`;
      const after: ReturnType<typeof matter> = matter(nextText);
      if (after.data.name !== name || after.content !== before.content
        || !isDeepStrictEqual(before.data, Object.fromEntries(Object.entries(after.data).filter(([key]) => key !== 'name')))) return undefined;
      candidate[index] = { ...candidate[index], contentBase64: Buffer.from(nextText, 'utf8').toString('base64') };
    } catch {
      return undefined;
    }
  }
  const unchanged = files.length === candidate.length
    && files.every(file => candidate.some(next => next.path === file.path && next.contentBase64 === file.contentBase64));
  return unchanged ? undefined : { files: candidate, name };
}

export function createNameWhitespaceCandidate<T extends PublicationCandidateFile[]>(
  files: T,
  report: any,
): T | undefined {
  const blocking = Array.isArray(report?.issues)
    ? report.issues.filter((issue: any) => issue?.blocking === true)
    : [];
  const nameIssues = blocking.filter((issue: any) => issue?.code === 'metadata.name_whitespace');
  if (report?.coverage !== 'complete' || !nameIssues.length || blocking.some((issue: any) => {
    const location = issue?.location;
    if (!Number.isInteger(location?.entryIndex) || files[location.entryIndex]?.path !== 'SKILL.md'
      || (location?.relativePath && location.relativePath !== 'SKILL.md')) return true;
    if (issue?.code === 'metadata.name_whitespace') {
      return issue?.category !== 'format' || issue?.repairPolicy !== 'automatic' || location?.field !== 'name';
    }
    if (issue?.code === 'metadata.description_missing') {
      return issue?.category !== 'format' || issue?.repairPolicy !== 'confirmation_required' || location?.field !== 'description'
        || !nameIssues.some((nameIssue: any) => nameIssue?.location?.entryIndex === location.entryIndex);
    }
    return true;
  })) return undefined;

  const candidate = files.map(file => ({ ...file })) as T;
  for (const issue of nameIssues) {
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

export function createDescriptionCandidate<T extends PublicationCandidateFile[]>(
  files: T,
  report: any,
  description: string,
): T | undefined {
  const blocking = Array.isArray(report?.issues)
    ? report.issues.filter((issue: any) => issue?.blocking === true)
    : [];
  if (report?.coverage !== 'complete' || blocking.length !== 1 || !description.trim()
    || description.length > 1000 || /[\r\n\u0000-\u001f\u007f]/.test(description)) return undefined;
  const issue = blocking[0];
  const index = issue?.location?.entryIndex;
  if (issue?.code !== 'metadata.description_missing' || issue?.category !== 'format' || issue?.repairPolicy !== 'confirmation_required'
    || issue?.location?.field !== 'description' || issue?.location?.relativePath !== 'SKILL.md'
    || !Number.isInteger(index) || files[index]?.path !== 'SKILL.md') return undefined;

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(files[index].contentBase64, 'base64'));
  } catch {
    return undefined;
  }
  let before: ReturnType<typeof matter>;
  try {
    before = matter(text);
  } catch {
    return undefined;
  }
  if (typeof before.data?.name !== 'string' || before.data.description != null
    && !(typeof before.data.description === 'string' && !before.data.description.trim())) return undefined;

  const frontmatter = text.match(/^(---[ \t]*(?:yaml[ \t]*)?\r?\n)([\s\S]*?)(\r?\n---(?=[ \t]*(?:\r?\n|$)))/);
  if (!frontmatter) return undefined;
  const lineEnding = text.includes('\r\n') ? '\r\n' : '\n';
  let nextFrontmatter = frontmatter[2];
  if (Object.prototype.hasOwnProperty.call(before.data, 'description')) {
    // Replace only an unambiguous, empty, top-level scalar. Preserve comments,
    // line endings, the body and every unrelated field byte for byte.
    const lines = nextFrontmatter.split(/(\r?\n)/);
    const indices = lines.flatMap((line, index) => index % 2 === 0 && /^description:/.test(line) ? [index] : []);
    if (indices.length !== 1) return undefined;
    const index = indices[0];
    const scalar = lines[index].match(/^(description:[ \t]*)(?:"[ \t]*"|'[ \t]*'|null|Null|NULL|~)?([ \t]*(?:#.*)?)$/);
    if (!scalar) return undefined;
    lines[index] = `${scalar[1]}${/[ \t]$/.test(scalar[1]) ? '' : ' '}${JSON.stringify(description)}${scalar[2]}`;
    nextFrontmatter = lines.join('');
  } else {
    nextFrontmatter += `${lineEnding}description: ${JSON.stringify(description)}`;
  }
  const nextText = `${frontmatter[1]}${nextFrontmatter}${frontmatter[3]}${text.slice(frontmatter[0].length)}`;
  try {
    const after = matter(nextText);
    if (after.data.description !== description || after.content !== before.content
      || !isDeepStrictEqual(Object.fromEntries(Object.entries(before.data).filter(([key]) => key !== 'description')),
        Object.fromEntries(Object.entries(after.data).filter(([key]) => key !== 'description')))) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const candidate = files.map(file => ({ ...file })) as T;
  candidate[index] = { ...candidate[index], contentBase64: Buffer.from(nextText, 'utf8').toString('base64') };
  return candidate;
}

export function isConfirmedDescriptionCandidate(
  beforeBase64: string,
  afterBase64: string,
  description: string,
): boolean {
  try {
    const beforeBytes = Buffer.from(beforeBase64, 'base64');
    const afterBytes = Buffer.from(afterBase64, 'base64');
    if (beforeBytes.toString('base64') !== beforeBase64 || afterBytes.toString('base64') !== afterBase64) return false;
    const beforeText = new TextDecoder('utf-8', { fatal: true }).decode(beforeBytes);
    const afterText = new TextDecoder('utf-8', { fatal: true }).decode(afterBytes);
    const expected = createDescriptionCandidate([
      { path: 'SKILL.md', contentBase64: beforeBase64 },
    ], {
      coverage: 'complete',
      issues: [{ code: 'metadata.description_missing', category: 'format', blocking: true, repairPolicy: 'confirmation_required',
        location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' } }],
    }, description);
    return Boolean(expected && Buffer.from(expected[0].contentBase64, 'base64').toString('utf8') === afterText);
  } catch {
    return false;
  }
}

export function isNameWhitespaceAndConfirmedDescriptionCandidate(
  beforeBase64: string,
  afterBase64: string,
  description: string,
): boolean {
  const original = [{ path: 'SKILL.md', contentBase64: beforeBase64 }];
  const normalized = createNameWhitespaceCandidate(original, {
    coverage: 'complete',
    issues: [{ code: 'metadata.name_whitespace', category: 'format', blocking: true, repairPolicy: 'automatic',
      location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'name' } }],
  });
  if (!normalized) return false;
  const combined = createDescriptionCandidate(normalized, {
    coverage: 'complete',
    issues: [{ code: 'metadata.description_missing', category: 'format', blocking: true, repairPolicy: 'confirmation_required',
      location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' } }],
  }, description);
  return Boolean(combined && combined[0].contentBase64 === afterBase64);
}

export function isNameMissingAndConfirmedDescriptionCandidate(
  beforeBase64: string,
  afterBase64: string,
  description: string,
  directoryName: string,
): boolean {
  const original = [{ path: 'SKILL.md', contentBase64: beforeBase64 }];
  const normalized = createMissingNameCandidate(original, {
    coverage: 'complete',
    issues: [{ code: 'metadata.name_missing', category: 'format', blocking: true, repairPolicy: 'automatic',
      location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'name' } }],
  }, directoryName);
  if (!normalized) return false;
  const combined = createDescriptionCandidate(normalized.files, {
    coverage: 'complete',
    issues: [{ code: 'metadata.description_missing', category: 'format', blocking: true, repairPolicy: 'confirmation_required',
      location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' } }],
  }, description);
  return Boolean(combined && combined[0].contentBase64 === afterBase64);
}

export function isNameMissingOnlyChange(beforeText: string, afterText: string, directoryName: string): boolean {
  try {
    const before = matter(beforeText);
    const after = matter(afterText);
    const expectedName = normalizeDirectoryNameToSkillName(directoryName);
    if (!expectedName || Object.prototype.hasOwnProperty.call(before.data, 'name') || after.data.name !== expectedName) return false;
    const expected = createMissingNameCandidate([{ path: 'SKILL.md', contentBase64: Buffer.from(beforeText, 'utf8').toString('base64') }], {
      coverage: 'complete',
      issues: [{ code: 'metadata.name_missing', category: 'format', blocking: true, repairPolicy: 'automatic',
        location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'name' } }],
    }, directoryName);
    return Boolean(expected && Buffer.from(expected.files[0].contentBase64, 'base64').toString('utf8') === afterText);
  } catch {
    return false;
  }
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
