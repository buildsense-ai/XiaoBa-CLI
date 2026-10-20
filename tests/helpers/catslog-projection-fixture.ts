/**
 * Shared loopback CatsLog fixture for the projection-reference E2E lane.
 *
 * It serves ONLY the three routes the typed source_reference flow needs and
 * records every inbound request (method/url/authorization/body) so tests can
 * assert on the actual wire — never on a canned return value. The fixture is
 * self-contained (http.createServer, random loopback port, minted fake
 * device tokens) and writes nothing outside a mkdtemp root.
 *
 * The response shapes mirror deployed server commit 339ba0e:
 *   POST /catsco/agent/bootstrap                -> mints skill_token + urls
 *   POST /catsco/agent/branch                   -> fused agent_memory branch
 *   POST /catsco/agent/knowledge/source/read    -> {"projection": ..., "sources": ...}
 */
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as http from 'node:http';

export interface SeenRequest {
  url: string;
  method: string;
  authorization?: string;
  body?: unknown;
}

export interface ProjectionDocument {
  schema_version: number;
  goal: string;
  summary: string;
  nodes: Array<{ id: string; kind: string; text: string }>;
  edges: Array<{ from: string; to: string; kind: string }>;
  mappings: Array<{ node_id: string; source_ref?: string }>;
  conditions: string[];
  omissions: string[];
  provenance: string;
  model_steps: string;
  causality: string;
  overall_coverage: 'complete' | 'partial';
  gap_acknowledgement: string;
  aggregate?: {
    contract: string;
    disclosure: string;
    coverage_digest: string;
    source_basis: string;
    gaps: Array<{ first_page: number; last_page: number; status: string }>;
  };
}

export interface FixtureOptions {
  /** The ref_<64hex> the typed locator advertises. */
  rootRef: string;
  /** Whether the branch emits a typed source_reference (default true). */
  emitSourceReference?: boolean;
  /** Override the item kind (kind-spoof probes). */
  itemKind?: string;
  /** Override the advertised ref value (ref-spoof probes). */
  advertisedRef?: string;
  /** Token the read route accepts; default the minted skill token. */
  acceptedReadToken?: string;
  /** Make source/read fail with this HTTP status + body (stale/403/404 probes). */
  sourceReadFailure?: { status: number; body: unknown };
  /** Extra agent_memory items appended alongside the locator. */
  extraItems?: Array<Record<string, unknown>>;
  /** Custom projection document (defaults to the synthetic 10/7/3/2 case). */
  projectionDocument?: ProjectionDocument;
  /** Authorized source texts (default 4 pages, page 2 withheld marker). */
  sourceTexts?: string[];
}

export interface CatsLogProjectionFixture {
  baseUrl: string;
  skillToken: string;
  requests: SeenRequest[];
  close(): Promise<void>;
}

export const DEFAULT_ROOT_REF = `ref_${crypto.createHash('sha256').update('catslog-projection-e2e-root', 'utf8').digest('hex')}`;

/** Deterministic synthetic reference document (10 nodes / 7 edges / 3 conditions / 2 omissions / page-2 gap). */
export function syntheticProjectionDocument(): ProjectionDocument {
  return {
    schema_version: 1,
    goal: 'synthesize release-readiness evidence for the synthetic long-root fixture',
    summary: 'Four supplied pages prove the release decision; page two of five is withheld.',
    nodes: Array.from({ length: 10 }, (_, i) => ({
      id: `node-${i + 1}`,
      kind: i === 9 ? 'omission' : i === 0 ? 'root' : 'step',
      text: `synthetic node ${i + 1} semantic text`,
    })),
    edges: Array.from({ length: 7 }, (_, i) => ({
      from: `node-${i + 1}`,
      to: `node-${i + 2}`,
      kind: 'supports',
    })),
    mappings: Array.from({ length: 10 }, (_, i) => ({ node_id: `node-${i + 1}` })),
    conditions: [
      'release requires owner approval',
      'staging deploys only',
      'page 2 metric value is unknown and must not be inferred',
    ],
    omissions: [
      'page 2 of 5 was withheld from the source set',
      'operator identity was redacted',
    ],
    provenance: 'derived',
    model_steps: 'unknown',
    causality: 'unknown',
    overall_coverage: 'partial',
    gap_acknowledgement: 'page 2 is absent; no value is claimed for it',
    aggregate: {
      contract: 'source_result_synthesis',
      disclosure: 'partial',
      coverage_digest: crypto.createHash('sha256').update('coverage', 'utf8').digest('hex'),
      source_basis: 'synthetic-basis',
      gaps: [{ first_page: 2, last_page: 2, status: 'withheld' }],
    },
  };
}

const DEFAULT_SOURCE_TEXTS = [
  'page 1: release checklist opened, owner assigned',
  'page 3: staging deploy completed, smoke checks green',
  'page 4: owner approved the release window',
  'page 5: post-release watch scheduled',
];

export async function startCatsLogProjectionFixture(
  options: FixtureOptions,
): Promise<CatsLogProjectionFixture> {
  const requests: SeenRequest[] = [];
  const skillToken = `loopback-skill-${crypto.randomBytes(12).toString('hex')}`;
  const document = options.projectionDocument ?? syntheticProjectionDocument();
  const sourceTexts = options.sourceTexts ?? DEFAULT_SOURCE_TEXTS;
  const sources = sourceTexts.map((text, index) => ({
    anchor: { kind: 'session_result', id: `source-${index + 1}`, revision: crypto.createHash('sha256').update(`r${index}`, 'utf8').digest('hex') },
    status: 'read',
    role: 'source',
    speaker: 'source',
    text,
    content_hash: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    coverage: 'full',
    truncated: false,
    redacted: false,
    missing: false,
    revoked: false,
  }));

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body: unknown;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw) {
        try { body = JSON.parse(raw); } catch { body = { __unparsed: raw.slice(0, 256) }; }
      }
      requests.push({
        url: String(req.url),
        method: String(req.method),
        authorization: req.headers.authorization,
        body,
      });
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.url === '/catsco/agent/bootstrap') {
        return json(200, {
          user_id: 'u-e2e', external_provider: 'catsco', external_user_id: '1',
          device_id: 'dev-e2e', token_id: 'tid-e2e', token: 'upload-token',
          upload_url: '/catsco/logs/upload', issued_at: '2026-10-20T00:00:00.000Z',
          skill_token: skillToken,
          skill_token_expires_at: '2999-01-01T00:00:00.000Z',
          branch_url: '/catsco/agent/branch',
          sessions_url: '/catsco/agent/query/v1/sessions',
          memory_url: '/catsco/agent/memory/retrieve',
          memory_recall_url: '/catsco/agent/memory/recall',
        });
      }

      if (req.url === '/catsco/agent/branch') {
        const agentItems: Record<string, unknown>[] = [];
        if (options.emitSourceReference !== false) {
          agentItems.push({
            source: 'agent_memory',
            ref: options.advertisedRef ?? options.rootRef,
            kind: options.itemKind ?? 'source_reference',
            text: 'Source projection reference (metadata only; read_required). 4 source pages supplied; page 2 withheld.',
            score_hint: 0.5,
          });
        }
        for (const extra of options.extraItems ?? []) agentItems.push(extra);
        return json(200, {
          schema_version: 1,
          request_id: 'req-e2e-1',
          status: 'partial',
          branches: [
            {
              source: 'agent_memory',
              status: 'partial',
              items: agentItems,
              truncated: true,
            },
            { source: 'session_graph', status: 'empty', items: [] },
            { source: 'skill', status: 'empty', items: [] },
          ],
        });
      }

      if (req.url === '/catsco/agent/knowledge/source/read') {
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (token !== (options.acceptedReadToken ?? skillToken)) {
          return json(401, { error: 'unauthorized' });
        }
        const query = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        const projectionRef = typeof query.projection_ref === 'string' ? query.projection_ref : '';
        // Strict envelope: the only accepted expansion key is projection_ref.
        const unknownKeys = Object.keys(query).filter(key => key !== 'projection_ref');
        if (unknownKeys.length > 0 || !projectionRef) {
          return json(400, { error: 'invalid_request', detail: 'projection_ref is the only accepted expansion key' });
        }
        if (options.sourceReadFailure) {
          return json(options.sourceReadFailure.status, options.sourceReadFailure.body);
        }
        if (projectionRef !== options.rootRef) {
          return json(404, { error: 'not_found', detail: 'projection ref was never issued' });
        }
        return json(200, {
          schema_version: 1,
          content_trust: 'derived_memory_projection',
          projection: { document },
          sources,
        });
      }

      return json(404, { error: 'not_found' });
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    skillToken,
    requests,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

/** Extract the typed source_reference items a projected branch lane surfaced. */
export function sourceReferenceItems(branchEnvelope: unknown): Array<Record<string, unknown>> {
  const record = branchEnvelope as Record<string, unknown>;
  const branches = Array.isArray(record?.branches) ? record.branches : [];
  const items: Array<Record<string, unknown>> = [];
  for (const branch of branches) {
    if (!branch || typeof branch !== 'object') continue;
    if ((branch as Record<string, unknown>).source !== 'agent_memory') continue;
    const branchItems = (branch as Record<string, unknown>).items;
    if (!Array.isArray(branchItems)) continue;
    for (const item of branchItems) {
      if (item && typeof item === 'object' && (item as Record<string, unknown>).kind === 'source_reference') {
        items.push(item as Record<string, unknown>);
      }
    }
  }
  return items;
}
