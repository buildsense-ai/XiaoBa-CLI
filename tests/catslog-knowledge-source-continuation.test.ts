import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CatscoLogAgentClient } from '../src/utils/catsco-log-agent-client';
import { CatsLogKnowledgeRecallTool } from '../src/tools/catslog-knowledge-recall-tool';

const anchor = { kind: 'session_query' as const, id: 'turn-test', session_id: 'session-1', stream_id: 'stream-1', byte_offset: 0, revision: 'a'.repeat(64) };
const cursor = 'server-issued-next-context-page';
const response = {
 source: { anchor, status: 'read', role: 'organic', speaker: 'user', text: 'synthetic source', coverage: 'complete', truncated: false, redacted: false, missing: false, revoked: false, content_hash: `sha256:${'b'.repeat(64)}`, occurred_at: null },
 before: [], after: [], before_exhausted: true, after_exhausted: false, context_truncated: false,
 after_cursor: cursor, served_at: '2026-10-10T00:00:00Z',
};

test('source continuation: typed transport sends exact token and preserves returned token', async () => {
 const original = globalThis.fetch;
 let sent: any;
 globalThis.fetch = (async (_url: any, request: RequestInit) => {
  sent = JSON.parse(String(request.body));
  return Response.json(response);
 }) as any;
 try {
  const client = new CatscoLogAgentClient('https://synthetic.example.test');
  const page = await client.readKnowledgeSource({ anchor, cursor, after: 1, max_bytes: 256, token: 'synthetic-test-token' });
  assert.equal(sent.cursor, cursor);
  assert.deepEqual(sent.anchor, anchor);
  assert.equal(page.after_cursor, cursor);
 } finally { globalThis.fetch = original; }
});

test('source continuation: native read_source action forwards exact token to backend', async () => {
 let sent: any;
 const tool = new CatsLogKnowledgeRecallTool({ readKnowledgeSource: async query => { sent = query; return response as any; } });
 const result = await tool.execute({ action: 'read_source', anchor, cursor, after: 1, max_bytes: 256 }, { workingDirectory: process.cwd(), workspaceRoot: process.cwd(), conversationHistory: [] } as any);
 assert.equal(result.ok, true);
 assert.equal(sent.cursor, cursor, 'native tool must not drop a valid server-issued continuation token');
 assert.equal(JSON.parse(String(result.content)).after_cursor, cursor);
});
