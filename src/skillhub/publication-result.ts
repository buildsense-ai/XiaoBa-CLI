import matter from 'gray-matter';
import { applySkillHubLocalMetadata } from './local-skill-metadata';
import type { SkillHubPackageFile } from './package-verifier';
import { Logger } from '../utils/logger';

export type PublicationProbe = { status: 'published' } | { status: 'unverified'; reason: string }
  | { status: 'verification_failed'; reason: string };
export type PublicationFile = { path: string; contentBase64: string };

/** Compare the validated upload copy, allowing only Hub-assigned tracking fields. */
export function publicationFilesMatch(expected: PublicationFile[], actual: SkillHubPackageFile[], version: string): boolean {
  if (!expected.length || expected.length !== actual.length || new Set(expected.map(f => f.path)).size !== expected.length) return false;
  const files = new Map(actual.map(f => [f.path, f]));
  if (files.size !== actual.length) return false;
  return expected.every(file => {
    const published = files.get(file.path);
    if (!published) return false;
    let bytes = Buffer.from(file.contentBase64, 'base64');
    const publishedBytes = Buffer.from(published.contentBase64, 'base64');
    if (file.path === 'SKILL.md') {
      const metadata = matter(publishedBytes.toString('utf8')).data;
      if (!metadata.skillhub_author || metadata.skillhub_version !== version || !metadata.skillhub_uploaded_at) return false;
      bytes = Buffer.from(applySkillHubLocalMetadata(bytes.toString('utf8'), {
        author: String(metadata.skillhub_author), version, uploadedAt: String(metadata.skillhub_uploaded_at),
      }).replace(/\r\n/g, '\n'));
    }
    return bytes.equals(publishedBytes);
  });
}

export interface PublicationResultOptions {
  probe: (budgetMs: number) => Promise<PublicationProbe>;
  followUp?: (result: PublicationProbe) => Promise<void>;
  signal?: AbortSignal;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  foregroundMs?: number;
  backgroundMs?: number;
  retainedBytes?: number;
}

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const active = new Set<Promise<void>>();
let activeBytes = 0;

/** Read-only polling: never retries the upload and never guesses success from absence. */
export async function confirmPublicationResult(options: PublicationResultOptions): Promise<PublicationProbe & { following?: boolean }> {
  const now = options.now || Date.now, delay = options.wait || wait;
  const deadline = now() + (options.foregroundMs ?? 60_000);
  const probe = async (budgetMs: number): Promise<PublicationProbe> => {
    try { return await options.probe(budgetMs); }
    catch { return { status: 'unverified', reason: 'public_read_unavailable' }; }
  };
  let last: PublicationProbe = { status: 'unverified', reason: 'not_ready' };
  while (!options.signal?.aborted && now() < deadline) {
    last = await probe(Math.max(1, deadline - now()));
    if (last.status !== 'unverified') return last;
    if (now() < deadline) await delay(Math.min(2000, deadline - now()));
  }
  const bytes = options.retainedBytes ?? 0;
  if (options.signal?.aborted || !options.followUp || active.size >= 64 || activeBytes + bytes > 64 * 1024 * 1024) return last;
  const followUp = options.followUp;
  const backgroundDeadline = now() + (options.backgroundMs ?? 10 * 60_000);
  const job = (async () => {
    // Let the foreground response finish before a later result notification.
    while (!options.signal?.aborted && now() < backgroundDeadline) {
      await delay(Math.min(15_000, backgroundDeadline - now()));
      if (options.signal?.aborted) return;
      last = await probe(Math.max(1, backgroundDeadline - now()));
      if (last.status !== 'unverified') break;
    }
    if (options.signal?.aborted) return;
    // Retry delivery only, never the upload or a terminal verification failure.
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await followUp(last); return; } catch {
        if (attempt < 2) await delay(5000);
      }
    }
    Logger.warning('SkillHub publication result notification could not be delivered after three attempts.');
  })();
  active.add(job);
  activeBytes += bytes;
  void job.catch(() => {}).finally(() => { active.delete(job); activeBytes -= bytes; });
  return { ...last, following: true };
}
