import * as http from 'node:http';
import * as crypto from 'node:crypto';

export const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export const ROOT_REVISION = digest('independent-fixture-revision');
export const ROOT_STREAM = 'independent-fixture-stream';
export function opaqueRef(revision: string, stream: string): string {
  return `ref_${digest(`smp_${revision}\0source-memory:${stream}:${revision}`)}`;
}
export const DEFAULT_ROOT_REF = opaqueRef(ROOT_REVISION, ROOT_STREAM);
export function syntheticProjectionDocument(): any {
  return {
    schema_version: 1, goal: 'Meridian release readiness', summary: 'Meridian supplied pages support a bounded partial release decision.',
    nodes: Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, kind: i === 9 ? 'omission' : 'assertion', text: `Independent synthetic fact ${i}.` })),
    edges: Array.from({ length: 7 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}`, kind: 'supports' })),
    mappings: Array.from({ length: 10 }, (_, i) => ({ node_id: `n${i}`, source_ref: `ref_${digest('source-page-1')}` })),
    conditions: ['Only staging deployments.', 'Owner approval required.', 'The inclusive date boundary must be preserved.'],
    omissions: ['Page 2 is withheld; no metric value can be inferred.', 'Operator identity omitted.'],
    provenance: 'derived', model_steps: 'unknown', causality: 'unknown', overall_coverage: 'partial',
    gap_acknowledgement: 'Page 2 remains unknown; absence is not evidence of a zero metric.',
    aggregate: { contract: 'result_synthesis/v2', version: 2, disclosure: 'derived_memory_projection', coverage_digest: digest('coverage'), source_basis: 'fixture-basis',
      root_proof: { page: 0, pages: 5 }, ranges: [{ first_page: 0, last_page: 1 }, { first_page: 3, last_page: 4 }],
      leaves: [], pages: [0, 1, 3, 4].map(page => ({ page, pages: 5 })), gaps: [{ first_page: 2, last_page: 2, status: 'unknown' }] },
  };
}
export interface FixtureOptions {
  itemKind?: string;
  itemSource?: string;
  branchSource?: string;
  advertisedRef?: string;
  failureStatus?: number;
  stale?: boolean;
  malformed?: boolean;
  networkFailure?: boolean;
  document?: any;
  count?: number;
  hideRecency?: boolean;
  delayRead?: boolean;
  rotateOnRead?: boolean;
  unsafeSourcePath?: boolean;
}
export async function startCatsLogProjectionFixture(options: FixtureOptions = {}) {
  const requests: any[] = [];
  let reads = 0;
  let bootstraps = 0;
  const token = 'synthetic-device-skill-A';
  const rotatedToken = 'synthetic-device-skill-B';
  const document = options.document ?? syntheticProjectionDocument();
  let readStartedResolve!: () => void;
  const readStarted = new Promise<void>(resolve => { readStartedResolve = resolve; });
  const identities = Array.from({ length: options.count ?? 1 }, (_, i) => {
    const revision = i === 0 ? ROOT_REVISION : digest(`revision-${i}`);
    const stream = i === 0 ? ROOT_STREAM : `stream-${i}`;
    return { revision, stream, ref: opaqueRef(revision, stream) };
  });
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    requests.push({ method: req.method, path: req.url, body, tokenMatched: req.headers.authorization === `Bearer ${token}`, rotatedMatched: req.headers.authorization === `Bearer ${rotatedToken}` });
    const json = (status: number, value: any) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/catsco/agent/bootstrap') {
      bootstraps++;
      return json(200, { skill_token: rotatedToken, skill_token_expires_at: new Date(Date.now() + 86_400_000).toISOString(), device_id: 'isolated-device', branch_url: '/catsco/agent/branch' });
    }
    if (![token, rotatedToken].some(t => req.headers.authorization === `Bearer ${t}`)) return json(401, { error: 'unauthorized' });
    if (req.url === '/catsco/agent/branch') {
      // Actual store: whitespace terms ANDed as literal ILIKE substrings of
      // goal/summary. Empty query is bounded recency; the query must be IN
      // the indexed text, never the reverse ("question contains Meridian").
      const terms = String(body.query_text ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
      const haystack = `${document.goal} ${document.summary}`.toLowerCase();
      const matches = terms.every(term => haystack.includes(term)) && !(options.hideRecency && terms.length === 0);
      return json(200, { schema_version: 1, request_id: `req-${requests.length}`, status: 'partial', branches: [{
        source: options.branchSource ?? 'agent_memory', status: 'error', truncated: true,
        items: matches ? identities.map(identity => ({ source: options.itemSource ?? 'agent_memory', kind: options.itemKind ?? 'source_reference',
          ref: options.advertisedRef ?? identity.ref, text: `Metadata only; read_required; locator ${identity.ref}`, score_hint: 0.5 })) : [],
      }] });
    }
    if (req.url === '/catsco/agent/knowledge/source/read') {
      reads++;
      readStartedResolve();
      if (options.delayRead) return; // held until client abort / fixture close
      if (options.networkFailure) { req.socket.destroy(); return; }
      if (options.rotateOnRead && reads === 1) return json(401, { error: 'expired' });
      if (options.failureStatus) return json(options.failureStatus, { error: 'source_unavailable', detail: 'synthetic untrusted server error' });
      if (Object.keys(body).join(',') !== 'projection_ref') return json(400, { error: 'invalid_request' });
      const identity = identities.find(i => i.ref === body.projection_ref);
      if (!identity) return json(404, { error: 'unknown_ref' });
      return json(200, {
        schema_version: 1, content_trust: 'derived_memory_projection',
        projection: { PrincipalID: 'private-principal-sentinel', MemoryScopeID: 'private-scope-sentinel',
          Revision: options.stale ? digest('stale') : identity.revision, StreamID: identity.stream,
          Document: options.malformed ? { ...document, nodes: [] } : document },
        sources: [{ text: 'RAW_SOURCE_PAGE_REPROOF_ONLY_SENTINEL', status: 'read', coverage: 'full' }],
      });
    }
    return json(404, { error: 'not_found' });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as any;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`, token, rotatedToken, requests, identities, document, readStarted,
    get reads() { return reads; }, get bootstraps() { return bootstraps; },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
