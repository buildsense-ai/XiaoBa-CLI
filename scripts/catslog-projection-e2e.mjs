#!/usr/bin/env node
/**
 * Lane F — manifest-driven projection-reference E2E runner.
 *
 * Consumes the parent-owned Go PG/HTTP fixture manifest
 * (schema `catslog.xiaoba_projection_e2e.v1`) and drives the REAL
 * CatscoLogAgentClient + CatsLogMemoryProvider + memory-search branch
 * lifecycle against the httptest server the Go fixture exposes for the
 * duration of this child process.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/catslog-projection-e2e.mjs \
 *     --manifest /path/to/manifest.json
 *
 * Writes a body-free artifact JSON to <artifact_dir>/projection-e2e-<ts>.json
 * containing per-step wire proof (seen request method/path/auth-presence/
 * body-keys, ref sets, byte counts, degrade flags) — never the bearer token,
 * never the expanded source text.
 *
 * RED contract: on baseline 4bac37f7 the client/provider expose no
 * projection-expansion method and MemorySearchBranchSession has no remote
 * lane, so the runner exits non-zero with `red_reason` recorded. It goes
 * green only when E wires the actual seam.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function parseArgs(argv) {
  const args = { manifest: null, artifact: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--manifest') args.manifest = argv[++i];
    else if (argv[i] === '--artifact') args.artifact = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.manifest) {
    console.error('usage: catslog-projection-e2e.mjs --manifest <path> [--artifact <path>]');
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
  const startedAt = new Date().toISOString();
  const artifact = {
    schema: 'catslog.xiaoba_projection_e2e.artifact.v1',
    started_at: startedAt,
    manifest_schema: manifest.schema,
    root_ref_sha256_16: sha256Prefix(manifest.root_ref),
    steps: [],
    red_reason: null,
    ok: false,
  };
  const step = (name, data) => artifact.steps.push({ name, ...data });

  if (manifest.schema !== 'catslog.xiaoba_projection_e2e.v1') {
    artifact.red_reason = `unsupported manifest schema: ${manifest.schema}`;
    return finish(artifact, args);
  }

  // Importers must never see a real token: set only what the provider needs
  // to reach the fixture, in an isolated env the runner owns.
  const envRoot = fs.mkdtempSync(path.join('/tmp', 'xiaoba-projection-runner-'));
  process.env.XIAOBA_USER_DATA_DIR = envRoot;
  process.env.DOTENV_CONFIG_PATH = path.join(envRoot, 'missing.env');
  process.env.CATSCO_LOG_API_BASE_URL = manifest.base_url;
  // The fixture issues the device skill token from bootstrap using this
  // caller token; the runner never persists or prints it.
  process.env.CATSCO_USER_TOKEN = manifest.device_skill_token;

  const imp = rel => import(pathToFileURL(path.join(REPO_ROOT, rel)).href);
  const { CatscoLogAgentClient } = await imp('src/utils/catsco-log-agent-client.ts');
  const { CatsLogMemoryProvider } = await imp('src/utils/catslog-memory-provider.ts');
  const { startMemorySidecarBranch } = await imp('src/core/sidecar-memory-branch.ts');
  const { InMemorySyntheticObservationQueue } = await imp('src/core/synthetic-observation.ts');
  const { sourceReferenceItems } = await imp('tests/helpers/catslog-projection-fixture.ts');

  // --- Step 1: remote-lane seam must exist on the client ----------------
  const client = new CatscoLogAgentClient(manifest.base_url);
  const expansionMethod = ['readSourceProjection', 'sourceRead', 'readSource', 'expandProjection']
    .find(name => typeof client[name] === 'function');
  step('client_expansion_seam', { method: expansionMethod ?? null });
  if (!expansionMethod) {
    artifact.red_reason = 'CatscoLogAgentClient has no projection expansion method [E-SEAM]';
    return finish(artifact, args, envRoot);
  }

  // --- Step 2: real branch call over real HTTP --------------------------
  const provider = new CatsLogMemoryProvider(envRoot, { env: process.env });
  let branchResponse;
  try {
    branchResponse = await provider.branch({ queryText: manifest.query_text });
  } catch (error) {
    artifact.red_reason = `provider.branch failed: ${error?.message || error}`;
    return finish(artifact, args, envRoot);
  }
  const locators = sourceReferenceItems(branchResponse);
  step('branch_typed_locators', { count: locators.length });
  if (locators.length === 0) {
    artifact.red_reason = 'agent_memory branch emitted no kind=source_reference item';
    return finish(artifact, args, envRoot);
  }

  // --- Step 3: expansion over the device read capability ----------------
  let expansion;
  try {
    expansion = await provider[expansionMethod]
      ? provider[expansionMethod]({ projectionRef: locators[0].ref })
      : await client[expansionMethod]({
        projectionRef: locators[0].ref,
        token: manifest.device_skill_token,
        sourceReadUrl: manifest.source_read_path || '/catsco/agent/knowledge/source/read',
      });
  } catch (error) {
    artifact.red_reason = `projection expansion failed: ${error?.message || error}`;
    return finish(artifact, args, envRoot);
  }
  const document = expansion?.projection?.document ?? expansion?.document ?? expansion;
  step('expansion_shape', {
    has_document: Boolean(document),
    node_count: Array.isArray(document?.nodes) ? document.nodes.length : 0,
    edge_count: Array.isArray(document?.edges) ? document.edges.length : 0,
    condition_count: Array.isArray(document?.conditions) ? document.conditions.length : 0,
    omission_count: Array.isArray(document?.omissions) ? document.omissions.length : 0,
    overall_coverage: document?.overall_coverage ?? null,
    source_count: Array.isArray(expansion?.sources) ? expansion.sources.length : 0,
  });

  // --- Step 4: oracle check (semantic counts only; no answer text) ------
  const oracle = manifest.oracle || {};
  const mismatches = [];
  for (const key of ['node_count', 'edge_count', 'condition_count', 'omission_count']) {
    if (oracle[key] !== undefined && oracle[key] !== artifact.steps.at(-1)[key]) {
      mismatches.push(`${key}: expected ${oracle[key]}, got ${artifact.steps.at(-1)[key]}`);
    }
  }
  step('oracle_match', { mismatches });
  if (mismatches.length > 0) {
    artifact.red_reason = `expanded document mismatched oracle: ${mismatches.join('; ')}`;
    return finish(artifact, args, envRoot);
  }

  // --- Step 4b: same-principal sibling-scope ref must fail envelope-wide -
  // The SERVER owns this fence (trusted shared + own-subjects, post-read
  // revalidation). The client deliberately performs NO local scope check —
  // it sends the sibling ref verbatim and the artifact records the raw
  // server verdict. A client-side filter would be pretending authorization.
  if (typeof manifest.sibling_ref === 'string' && manifest.sibling_ref) {
    let siblingOutcome;
    try {
      const read = provider[expansionMethod]
        ? provider[expansionMethod].bind(provider)
        : client[expansionMethod].bind(client);
      const result = await read({
        projectionRef: manifest.sibling_ref,
        token: manifest.device_skill_token,
        sourceReadUrl: manifest.source_read_path || '/catsco/agent/knowledge/source/read',
      });
      siblingOutcome = { http_ok: true, rejected: false };
      void result;
    } catch (error) {
      siblingOutcome = {
        http_ok: false,
        rejected: true,
        status: Number(error?.status) || null,
        error_class: error?.name ?? null,
      };
    }
    step('sibling_scope_fence', siblingOutcome);
    if (!siblingOutcome.rejected) {
      artifact.red_reason = 'same-principal sibling-scope projection_ref was accepted — server fence missing';
      return finish(artifact, args, envRoot);
    }
  }

  // --- Step 5: full memory-branch lifecycle with a fake inspectable AI --
  const queue = new InMemorySyntheticObservationQueue();
  const aiCalls = [];
  const fakeAi = {
    isToolCallingSupported: () => true,
    async chat(messages) {
      aiCalls.push(JSON.parse(JSON.stringify(messages)));
      // Finish immediately citing the delivered ref — the finish gate must
      // accept ONLY because the ref was actually delivered, not because the
      // string is well-formed.
      return {
        content: null,
        toolCalls: [{
          id: 'finish_1', type: 'function',
          function: { name: 'finish_memory_search', arguments: JSON.stringify({
            summary: 'Expanded projection evidence delivered.',
            evidence: [manifest.root_ref],
            inject: true,
          }) },
        }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  };
  const handle = startMemorySidecarBranch({
    sessionKey: 'projection-e2e-runner',
    input: manifest.query_text,
    recentMessages: [],
    workingDirectory: envRoot,
    aiService: fakeAi,
    queue,
    // E must accept and use this seam; on baseline it is ignored.
    catslogMemory: provider,
  });
  await handle.done;
  const observations = queue.drain();
  step('memory_branch_lifecycle', {
    ai_calls: aiCalls.length,
    observations_published: observations.length,
    injected_refs: observations.map(o => {
      try { return JSON.parse(o.formattedContent || '{}').refs ?? []; } catch { return []; }
    }),
  });

  artifact.ok = artifact.red_reason === null;
  return finish(artifact, args, envRoot);
}

function sha256Prefix(value) {
  if (typeof value !== 'string' || !value) return null;
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

async function finish(artifact, args, envRoot) {
  artifact.finished_at = new Date().toISOString();
  const outDir = args.artifact
    ? path.dirname(args.artifact)
    : '/tmp';
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = args.artifact
    ?? path.join(outDir, `projection-e2e-${artifact.started_at.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log(`artifact: ${outPath}`);
  console.log(`ok=${artifact.ok} red_reason=${artifact.red_reason ?? 'none'}`);
  if (envRoot) fs.rmSync(envRoot, { recursive: true, force: true });
  process.exit(artifact.ok ? 0 : 1);
}

main().catch(error => {
  console.error(`runner crashed: ${error?.stack || error}`);
  process.exit(2);
});
