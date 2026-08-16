/**
 * Test helper: writes a fake xurl CLI executable to a temp path that speaks the
 * official agents:// rendered-Timeline contract. It is a real child process
 * (spawned via execFileSync/execFile by XurlOfficialRunner), so Node's real
 * maxBuffer overflow path (ERR_CHILD_PROCESS_STDIO_MAXBUFFER) is exercised.
 *
 * Controls (via env):
 *   FAKE_XURL_READ_BYTES   number of bytes of User content in the read body.
 *                          Used to cross the 256 KiB / 4 MiB boundaries.
 *   FAKE_XURL_CATALOG_THREADS  number of threads to render in the catalog.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface FakeXurlScript {
  readonly command: string;
  readonly env: NodeJS.ProcessEnv;
  setReadBytes(bytes: number): void;
  setCatalogThreads(count: number): void;
  cleanup(): void;
}

export function writeFakeXurlScript(baseEnv: NodeJS.ProcessEnv = process.env): FakeXurlScript {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-xurl-'));
  const command = path.join(dir, 'fake-xurl.cjs');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const readBytes = Number(process.env.FAKE_XURL_READ_BYTES || 0);
const catalogThreads = Math.max(0, Number(process.env.FAKE_XURL_CATALOG_THREADS || 1));

function writeOut(text) {
  // Synchronous write-all to fd 1 so the parent (execFileSync) observes the
  // real byte count and triggers ERR_CHILD_PROCESS_STDIO_MAXBUFFER / ENOBUFS
  // when output exceeds maxBuffer. fs.writeSync returns the bytes written in a
  // single syscall (which may be less than the buffer on a full pipe), so loop
  // until the whole payload is flushed. The parent reads concurrently and
  // terminates this child once maxBuffer is exceeded.
  const buf = Buffer.from(text, 'utf8');
  let written = 0;
  while (written < buf.length) {
    try {
      const n = fs.writeSync(1, buf, written, Math.min(65536, buf.length - written));
      if (n <= 0) break;
      written += n;
    } catch {
      process.exit(2);
    }
  }
}

if (args[0] === '--version') {
  writeOut('xurl 0.0.27\\n');
  process.exit(0);
}

if (args[0] === '-I') {
  const uri = args[1] || '';
  writeOut('---\\nuri: ' + uri + '\\nordinal: 2\\nfingerprint: stable-fingerprint\\n---\\n');
  process.exit(0);
}

const arg = args[0] || '';

if (arg.startsWith('agents://codex?')) {
  let body = '---\\nuri: agents://codex\\nprovider: codex\\n---\\n\\n# Threads\\n\\n- Matched: \`' + catalogThreads + '\`\\n\\n';
  for (let i = 0; i < catalogThreads; i += 1) {
    const threadId = 'thread-' + String(i + 1).padStart(3, '0');
    body += '## ' + (i + 1) + '. \`agents://codex/' + threadId + '\`\\n\\n- Provider: \`codex\`\\n- Thread ID: \`' + threadId + '\`\\n- Updated At: \`1735689600\`\\n\\n';
  }
  writeOut(body);
  process.exit(0);
}

if (arg.startsWith('agents://codex/thread-')) {
  const threadId = arg.split('agents://codex/')[1] || 'thread-001';
  const userContent = 'x'.repeat(Math.max(1, readBytes));
  writeOut('---\\nuri: agents://codex/' + threadId + '\\nprovider: codex\\nthread: ' + threadId + '\\nordinal: 2\\nfingerprint: stable-fingerprint\\nqueried_at: 2026-01-01T00:00:00Z\\n---\\n\\n## Thread\\n\\n' + threadId + '\\n\\n## Timeline\\n\\n### 1. User\\n\\n' + userContent + '\\n\\n### 2. Assistant\\n\\nDone.\\n');
  process.exit(0);
}

process.stderr.write('fake-xurl: unknown args ' + JSON.stringify(args) + '\\n');
process.exit(1);
`;
  fs.writeFileSync(command, script, { encoding: 'utf8', mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...baseEnv, FAKE_XURL_READ_BYTES: '0', FAKE_XURL_CATALOG_THREADS: '1' };
  return {
    command,
    env,
    setReadBytes(bytes: number) { env.FAKE_XURL_READ_BYTES = String(bytes); },
    setCatalogThreads(count: number) { env.FAKE_XURL_CATALOG_THREADS = String(count); },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}