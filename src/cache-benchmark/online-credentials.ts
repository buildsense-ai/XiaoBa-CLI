import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ApiType, CacheReadSource, ProviderAdapter } from './types';

const ALLOWED_KEYS = new Set([
  'XIAOBA_BENCH_NEWCLI_API_KEY',
  'XIAOBA_BENCH_NEWCLI_BASE_URL',
  'XIAOBA_BENCH_NEWCLI_MODEL',
  'XIAOBA_BENCH_DEEPSEEK_API_KEY',
  'XIAOBA_BENCH_DEEPSEEK_BASE_URL',
  'XIAOBA_BENCH_DEEPSEEK_MODEL',
]);

export type OnlineProviderAlias = 'newcli' | 'deepseek';

export interface OnlineProviderCredential {
  alias: OnlineProviderAlias;
  providerAdapter: ProviderAdapter;
  apiType: ApiType;
  cacheReadSource: CacheReadSource;
  apiKey: string;
  apiBase: string;
  model: string;
}

export class OnlineCredentialError extends Error {
  constructor(readonly code: OnlineCredentialErrorCode) {
    super(code);
    this.name = 'OnlineCredentialError';
  }
}

export type OnlineCredentialErrorCode =
  | 'credential_path_invalid'
  | 'credential_file_not_private'
  | 'credential_parent_not_private'
  | 'credential_owner_mismatch'
  | 'credential_file_invalid'
  | 'credential_key_unknown'
  | 'credential_key_duplicate'
  | 'credential_value_invalid'
  | 'credential_provider_incomplete';

/** Reads a deliberately tiny, non-shell env format from a private external file. */
export function loadOnlineProviderCredentials(filePath: string): OnlineProviderCredential[] {
  const resolved = path.resolve(filePath);
  const values = parseStrictEnv(readPrivateCredentialFile(resolved));
  return [
    providerFromValues(values, {
      alias: 'newcli',
      prefix: 'XIAOBA_BENCH_NEWCLI_',
      apiType: 'openai-responses',
      cacheReadSource: 'openai.input_tokens_details.cached_tokens',
    }),
    providerFromValues(values, {
      alias: 'deepseek',
      prefix: 'XIAOBA_BENCH_DEEPSEEK_',
      apiType: 'openai-chat-completions',
      // The supplied DeepSeek v4-compatible surface currently reports the
      // standard nested OpenAI field. The provider parser still supports the
      // documented top-level DeepSeek field when it is actually present.
      cacheReadSource: 'openai.prompt_tokens_details.cached_tokens',
    }),
  ];
}

function readPrivateCredentialFile(filePath: string): string {
  let descriptor: number | undefined;
  try {
    const parent = path.dirname(filePath);
    const parentLstat = fs.lstatSync(parent);
    if (parentLstat.isSymbolicLink() || !parentLstat.isDirectory()) fail('credential_path_invalid');
    validateOwnerAndMode(parentLstat, 'parent');

    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) fail('credential_path_invalid');
    validateOwnerAndMode(before, 'file');

    const content = fs.readFileSync(descriptor, 'utf8');
    const after = fs.fstatSync(descriptor);
    if (!sameStableFile(before, after)) fail('credential_path_invalid');

    const parentAfter = fs.lstatSync(parent);
    if (
      parentAfter.isSymbolicLink()
      || !parentAfter.isDirectory()
      || parentAfter.dev !== parentLstat.dev
      || parentAfter.ino !== parentLstat.ino
    ) fail('credential_path_invalid');
    validateOwnerAndMode(parentAfter, 'parent');
    return content;
  } catch (error) {
    if (error instanceof OnlineCredentialError) throw error;
    return fail('credential_path_invalid');
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* best effort */ }
    }
  }
}

function validateOwnerAndMode(stat: fs.Stats, kind: 'file' | 'parent'): void {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    fail('credential_owner_mismatch');
  }
  if (process.platform === 'win32') return;
  const expected = kind === 'file' ? 0o600 : 0o700;
  if ((stat.mode & 0o777) !== expected) {
    fail(kind === 'file' ? 'credential_file_not_private' : 'credential_parent_not_private');
  }
}

function sameStableFile(before: fs.Stats, after: fs.Stats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

function parseStrictEnv(source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const rawLine of source.split(/\r?\n/)) {
    if (!rawLine) continue;
    if (/^\s|\s$/.test(rawLine) || rawLine.startsWith('#') || rawLine.startsWith('export ')) {
      fail('credential_file_invalid');
    }
    const match = rawLine.match(/^([A-Z0-9_]+)=([^\r\n]+)$/);
    if (!match) fail('credential_file_invalid');
    const [, key, value] = match;
    if (!ALLOWED_KEYS.has(key)) fail('credential_key_unknown');
    if (result.has(key)) fail('credential_key_duplicate');
    if (!isSafeValue(value)) fail('credential_value_invalid');
    result.set(key, value);
  }
  return result;
}

function providerFromValues(
  values: Map<string, string>,
  contract: {
    alias: OnlineProviderAlias;
    prefix: string;
    apiType: ApiType;
    cacheReadSource: CacheReadSource;
  },
): OnlineProviderCredential {
  const apiKey = values.get(`${contract.prefix}API_KEY`);
  const apiBase = values.get(`${contract.prefix}BASE_URL`);
  const model = values.get(`${contract.prefix}MODEL`);
  if (!apiKey || !apiBase || !model) fail('credential_provider_incomplete');
  return {
    alias: contract.alias,
    providerAdapter: 'openai',
    apiType: contract.apiType,
    cacheReadSource: contract.cacheReadSource,
    apiKey,
    apiBase: validateHttpsEndpoint(apiBase),
    model: validateModel(model),
  };
}

function validateHttpsEndpoint(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.search
      || url.hash
    ) fail('credential_value_invalid');
    return url.toString().replace(/\/$/, '');
  } catch (error) {
    if (error instanceof OnlineCredentialError) throw error;
    return fail('credential_value_invalid');
  }
}

function validateModel(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/.test(value) || value.includes('://')) {
    fail('credential_value_invalid');
  }
  return value;
}

function isSafeValue(value: string): boolean {
  return Boolean(value)
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !/[`$]/.test(value)
    && !value.includes('$(')
    && !value.includes('${');
}

function fail(code: OnlineCredentialErrorCode): never {
  throw new OnlineCredentialError(code);
}
