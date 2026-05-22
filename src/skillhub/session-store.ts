import * as fs from 'fs';
import * as path from 'path';
import type { SkillHubConfig } from './config';

interface StoredCookie {
  name: string;
  value: string;
  path?: string;
  maxAge?: number;
  expiresAt?: string;
}

interface StoredSkillHubSession {
  baseUrl: string;
  cookies: StoredCookie[];
  updatedAt: string;
}

export class SkillHubSessionStore {
  constructor(private readonly config: SkillHubConfig) {}

  getBaseUrl(): string {
    return this.read()?.baseUrl || this.config.baseUrl;
  }

  getCookieHeader(baseUrl = this.getBaseUrl()): string {
    const session = this.read();
    if (!session || normalizeOrigin(session.baseUrl) !== normalizeOrigin(baseUrl)) return '';
    const now = Date.now();
    const cookies = session.cookies.filter(cookie => {
      if (!cookie.value) return false;
      if (!cookie.expiresAt) return true;
      return new Date(cookie.expiresAt).getTime() > now;
    });
    return cookies.map(cookie => `${cookie.name}=${encodeURIComponent(cookie.value)}`).join('; ');
  }

  storeSetCookieHeaders(baseUrl: string, headers: Headers): void {
    const values = getSetCookieHeaders(headers);
    if (!values.length) return;

    const current = normalizeOrigin(this.read()?.baseUrl) === normalizeOrigin(baseUrl)
      ? this.read()?.cookies ?? []
      : [];
    const next = new Map(current.map(cookie => [cookie.name, cookie]));

    for (const header of values) {
      const parsed = parseSetCookie(header);
      if (!parsed) continue;
      if (!parsed.value || parsed.maxAge === 0) next.delete(parsed.name);
      else next.set(parsed.name, parsed);
    }

    this.write({
      baseUrl,
      cookies: [...next.values()],
      updatedAt: new Date().toISOString(),
    });
  }

  clear(): void {
    if (fs.existsSync(this.config.sessionFile)) {
      fs.rmSync(this.config.sessionFile, { force: true });
    }
  }

  private read(): StoredSkillHubSession | null {
    if (!fs.existsSync(this.config.sessionFile)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.config.sessionFile, 'utf-8')) as StoredSkillHubSession;
      if (!parsed || !Array.isArray(parsed.cookies)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private write(session: StoredSkillHubSession): void {
    fs.mkdirSync(path.dirname(this.config.sessionFile), { recursive: true });
    fs.writeFileSync(this.config.sessionFile, `${JSON.stringify(session, null, 2)}\n`, 'utf-8');
  }
}

function getSetCookieHeaders(headers: Headers): string[] {
  const fromNode = (headers as any).getSetCookie?.();
  if (Array.isArray(fromNode)) return fromNode;
  const single = headers.get('set-cookie');
  return single ? splitCombinedSetCookie(single) : [];
}

function splitCombinedSetCookie(value: string): string[] {
  const results: string[] = [];
  let start = 0;
  let inExpires = false;
  for (let i = 0; i < value.length; i += 1) {
    const chunk = value.slice(i, i + 8).toLowerCase();
    if (chunk === 'expires=') inExpires = true;
    if (inExpires && value[i] === ';') inExpires = false;
    if (!inExpires && value[i] === ',' && /\s*[^=;,\s]+=/.test(value.slice(i + 1, i + 80))) {
      results.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  results.push(value.slice(start).trim());
  return results.filter(Boolean);
}

function parseSetCookie(header: string): StoredCookie | null {
  const parts = header.split(';').map(part => part.trim()).filter(Boolean);
  const [nameValue, ...attrs] = parts;
  const index = nameValue.indexOf('=');
  if (index <= 0) return null;
  const cookie: StoredCookie = {
    name: nameValue.slice(0, index),
    value: decodeURIComponent(nameValue.slice(index + 1)),
  };
  for (const attr of attrs) {
    const attrIndex = attr.indexOf('=');
    const key = (attrIndex === -1 ? attr : attr.slice(0, attrIndex)).trim().toLowerCase();
    const value = attrIndex === -1 ? '' : attr.slice(attrIndex + 1).trim();
    if (key === 'path') cookie.path = value;
    if (key === 'max-age') {
      const maxAge = Number(value);
      if (Number.isFinite(maxAge)) {
        cookie.maxAge = maxAge;
        cookie.expiresAt = new Date(Date.now() + maxAge * 1000).toISOString();
      }
    }
    if (key === 'expires') {
      const expires = new Date(value);
      if (Number.isFinite(expires.getTime())) cookie.expiresAt = expires.toISOString();
    }
  }
  return cookie;
}

function normalizeOrigin(value?: string): string {
  if (!value) return '';
  try {
    return new URL(value).origin;
  } catch {
    return String(value).replace(/\/+$/, '');
  }
}
