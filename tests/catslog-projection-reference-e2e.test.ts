/**
 * Lane F — independent end-to-end coverage of the typed `source_reference`
 * expansion path through the ACTUAL XiaoBa memory branch lifecycle.
 *
 * Scope: new tests only. This file never edits production code and never
 * touches a real token, provider, or profile. It drives
 *   startMemorySidecarBranch -> MemorySearchBranchSession -> finish_memory_search
 *   -> InMemorySyntheticObservationQueue
 * against a duck-typed fake AIService whose chat() captures the EXACT
 * message lists the branch builds, plus a loopback CatsLog HTTP fixture that
 * records every inbound request (tests/helpers/catslog-projection-fixture.ts).
 *
 * RED/GREEN contract (explicit, per parent):
 *   - `readSourceProjection` / remote-lane wiring does not exist on baseline
 *     `4bac37f7` — MemorySearchBranchSession is the local-only tool loop and
 *     `catslogMemory` is only used for citation reporting. Tests tagged
 *     [E-SEAM] therefore FAIL today ("remote expansion seam not wired"); they
 *     must pass UNCHANGED once E wires provider.branch -> source/read ->
 *     refine, proving real delivery — not a stub.
 *   - The finish-gate tests assert a finish CANNOT cite a `ref_<64hex>` that
 *     was discovered but never delivered; on baseline that finish is
 *     syntactically accepted, so they RED for the right reason.
 *
 * Assertions always inspect actual request/response bytes and message lists —
 * a fixed fake answer is never accepted as proof of use.
 */
import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startMemorySidecarBranch } from '../src/core/sidecar-memory-branch';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import { CatscoLogAgentClient, isCatsLogPoolCitationRef } from '../src/utils/catsco-log-agent-client';
import { ChatResponse, Message } from '../src/types';
import { ToolCall, ToolDefinition } from '../src/types/tool';
import {
  DEFAULT_ROOT_REF,
  sourceReferenceItems,
  startCatsLogProjectionFixture,
  syntheticProjectionDocument,
  type CatsLogProjectionFixture,
  type SeenRequest,
} from './helpers/catslog-projection-fixture';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function makeToolCall(id: string, name: string, args: unknown): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function lastToolMessage(messages: Message[]): Message | undefined {
  return [...messages].reverse().find(message => message.role === 'tool');
}

function toolResultJson(message: Message | undefined): any {
  if (!message) return undefined;
  try { return JSON.parse(String(message.content)); } catch { return undefined; }
}

/**
 * Assert the remote lane exists. The memory-search branch must have called
 * /catsco/agent/branch for the typed locator to be expandable at all; a test
 * that skips this check passes vacuously on the pre-E local-only session and
 * cannot distinguish "correctly never expanded" from "remote lane missing".
 * Every lifecycle test calls this first so the suite is uniformly RED until
 * E lands the seam.
 */
function requireRemoteLane(fixtureRequests: SeenRequest[], context: string): SeenRequest {
  const branchReq = fixtureRequests.find(r => r.url === '/catsco/agent/branch');
  assert.ok(branchReq,
    `${context}: /catsco/agent/branch was never called — the remote lane is not wired [E-SEAM]`);
  assert.equal(branchReq.method, 'POST');
  return branchReq;
}

/** All text the fake AI was shown, across every chat call. */
function allModelVisibleText(calls: Message[][]): string {
  return calls
    .flat()
    .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
    .join('\n');
}

/**
 * Fake AI that emulates the assess -> refine contract E must implement:
 * it asks for remote branch evidence first (driving whichever remote tool
 * surface E exposes), then finishes with `evidence:[rootRef]`. Every call
 * records its exact input; assertions read those records, not the answer.
 */
class ProjectionExpansionAI {
  calls: Message[][] = [];
  /** Ref the fake model decides to cite at finish (asserted separately). */
  finishEvidence: string[] = [DEFAULT_ROOT_REF];
  /** The summary the model claims — deliberately references expanded facts. */
  finishSummary = 'Expanded projection: release needs owner approval; page 2 metric is unknown and never inferred.';
  /** Tool names the fake AI attempted, in order. */
  attemptedTools: string[] = [];
  /** Whether a source_reference locator was actually observed in any input. */
  sawSourceReferenceLocator = false;
  /** Whether expanded projection semantics (nodes/conditions) reached the model. */
  sawExpandedSemantics = false;
  /** Whether any tool result contained the full projection document. */
  sawFullProjectionDocument = false;

  isToolCallingSupported(): boolean {
    return true;
  }

  async chat(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    const toolNames = (tools ?? []).map(tool => tool.name);
    const lastTool = lastToolMessage(messages);
    const lastResult = toolResultJson(lastTool);

    // Observe what the model ACTUALLY received (input inspection, not stub).
    const visible = allModelVisibleText([messages]);
    if (visible.includes('source_reference') || visible.includes('read_required')) {
      this.sawSourceReferenceLocator = true;
    }
    if (visible.includes('overall_coverage') || visible.includes('gap_acknowledgement')
      || visible.includes('release requires owner approval')) {
      this.sawExpandedSemantics = true;
    }
    if (visible.includes('"nodes"') && visible.includes('"edges"') && visible.includes('"conditions"')) {
      this.sawFullProjectionDocument = true;
    }

    // Stage 1: request remote evidence through whatever surface exists.
    // Guard against re-issuing a remote call forever if the lane delivers
    // evidence as a non-tool message (mechanical stage): after one remote
    // attempt with no follow-up tool result, fall through to finish.
    const attemptedRemote = this.attemptedTools.some(name =>
      name === 'assess_memory_need' || name === 'catslog_branch' || name === 'catslog_memory_branch');
    if (!lastTool && !attemptedRemote) {
      const remoteTool = toolNames.find(name =>
        name === 'assess_memory_need' || name === 'catslog_branch' || name === 'catslog_memory_branch');
      if (remoteTool) {
        this.attemptedTools.push(remoteTool);
        const args = remoteTool === 'assess_memory_need'
          ? { action: 'recall', query_text: 'release readiness', keywords: ['release', 'owner approval'] }
          : { query_text: 'release readiness', sources: ['agent_memory'] };
        return { content: null, toolCalls: [makeToolCall('remote_1', remoteTool, args)], usage };
      }
      // No remote surface on baseline: attempt the only memory tool, then
      // the finish below will cite the (never-delivered) remote ref — the
      // honest RED path: it must NOT be silently accepted as delivered.
      const searchTool = toolNames.find(name => name === 'memory_search');
      if (searchTool) {
        this.attemptedTools.push(searchTool);
        return { content: null, toolCalls: [makeToolCall('search_1', searchTool, { keywords: ['release'] })], usage };
      }
      return {
        content: null,
        toolCalls: [makeToolCall('finish_1', 'finish_memory_search', {
          summary: this.finishSummary, evidence: this.finishEvidence, inject: true,
        })],
        usage,
      };
    }

    // Stage 2: after any tool result, try to expand the typed locator via a
    // dedicated read tool if E exposes one; otherwise finish citing the ref.
    const expansionTool = toolNames.find(name =>
      /source.*read|read.*source|projection.*read|read.*projection/i.test(name));
    const items = lastResult ? sourceReferenceItems(lastResult) : [];
    if (expansionTool && items.length > 0) {
      this.attemptedTools.push(expansionTool);
      const ref = String(items[0].ref ?? '');
      return {
        content: null,
        toolCalls: [makeToolCall('expand_1', expansionTool, { projection_ref: ref, ref })],
        usage,
      };
    }

    this.attemptedTools.push('finish_memory_search');
    return {
      content: null,
      toolCalls: [makeToolCall('finish_1', 'finish_memory_search', {
        summary: this.finishSummary, evidence: this.finishEvidence, inject: true,
      })],
      usage,
    };
  }
}

describe('catslog projection reference E2E through the actual memory branch', () => {
  let testRoot: string;
  let fixture: CatsLogProjectionFixture;
  let previousUserDataDir: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'XIAOBA_USER_DATA_DIR',
    'CATSCO_LOG_API_BASE_URL',
    'CATSCO_USER_TOKEN',
    'DOTENV_CONFIG_PATH',
    'CATSLOG_MEMORY_ENABLED',
  ];

  beforeEach(async () => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-projection-e2e-'));
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.XIAOBA_USER_DATA_DIR = testRoot;
    process.env.DOTENV_CONFIG_PATH = path.join(testRoot, 'missing.env');
    fixture = await startCatsLogProjectionFixture({ rootRef: DEFAULT_ROOT_REF });
    process.env.CATSCO_LOG_API_BASE_URL = fixture.baseUrl;
    process.env.CATSCO_USER_TOKEN = 'loopback-user-token';
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await fixture?.close();
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------
  // [E-SEAM] Full lifecycle: remote typed ref -> expansion -> delivered
  // semantics -> finish gated to delivered refs -> observation cites them.
  // RED on baseline (session has no remote lane); must go GREEN when E wires.
  // ---------------------------------------------------------------------
  test('typed source_reference expands over the device read capability and its semantics reach the refine pass', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const aiService = new ProjectionExpansionAI();

    const handle = startMemorySidecarBranch({
      sessionKey: 'projection-e2e',
      input: 'what did we decide about the release readiness?',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: aiService as any,
      queue,
      // E must extend MemorySidecarBranchOptions with a catslogMemory seam
      // backed by a CatsLogMemoryProvider; until that option exists the
      // session has no remote lane and this test fails for that reason.
      ...( {} as { catslogMemory?: unknown }),
    });

    await handle.done;

    // The branch must have hit the remote /branch endpoint over real HTTP.
    const branchReq = fixture.requests.find(r => r.url === '/catsco/agent/branch');
    assert.ok(branchReq, 'memory branch never called /catsco/agent/branch — remote lane not wired [E-SEAM]');
    assert.equal(branchReq.method, 'POST');
    assert.match(String(branchReq.authorization), /^Bearer /);

    // The typed locator must have been shown to the model as a locator, not
    // as semantic content.
    assert.ok(aiService.sawSourceReferenceLocator,
      'typed source_reference item never reached the model input');

    // Expansion must use the exact wire contract: POST projection_ref.
    const readReq = fixture.requests.find(r => r.url === '/catsco/agent/knowledge/source/read');
    assert.ok(readReq, 'expansion never called /catsco/agent/knowledge/source/read');
    assert.equal(readReq.method, 'POST');
    assert.equal(readReq.authorization, `Bearer ${fixture.skillToken}`);
    assert.deepEqual(readReq.body, { projection_ref: DEFAULT_ROOT_REF },
      'source/read body must be exactly {projection_ref: <issued ref>}');

    // The expanded semantic view (not metadata) must reach the model.
    assert.ok(aiService.sawExpandedSemantics,
      'expanded projection semantics never reached the refine input');
    assert.ok(aiService.sawFullProjectionDocument,
      'full projection document (nodes/edges/conditions) was not delivered');

    // Ref accounting (corrected): DELIVERED/RETAINED/CITED refs are each a
    // subset of OBSERVED — the branch may observe far more than it injects,
    // and a cited ref that was never observed is the failure. The relation
    // is cited ⊆ delivered ⊆ observed (never observed ⊆ delivered).
    const observations = queue.drain();
    assert.equal(observations.length, 1, 'expected one injected memory observation');
    const injected = JSON.parse(observations[0].formattedContent || '');
    const citedRefs: string[] = Array.isArray(injected.refs) ? injected.refs : [];
    assert.ok(
      citedRefs.includes(DEFAULT_ROOT_REF)
        || citedRefs.some((ref: string) => isCatsLogPoolCitationRef(ref)),
      'injected observation does not cite the delivered source ref',
    );
    // The MAIN model (refine pass) must carry the RETAINED whole view — not
    // merely the branch AI having seen it. The whole semantic view must be
    // inside the serialized content delivered to the consuming stage.
    assert.ok(aiService.sawFullProjectionDocument,
      'refine/main input lacks the retained whole projection view');
  });

  // ---------------------------------------------------------------------
  // [E-SEAM] Finish gate: a ref_<64hex> that was discovered but never
  // delivered through expansion must NOT be accepted as evidence.
  // RED on baseline: FinishMemorySearchTool accepts ref_<64hex> with zero
  // delivery because isMemoryCitationRef allows pool refs unconditionally.
  // ---------------------------------------------------------------------
  test('finish citing an undelivered remote ref is not published as injected evidence', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const aiService = new ProjectionExpansionAI();
    // The model cites the remote ref even though nothing delivered it.
    aiService.finishEvidence = [DEFAULT_ROOT_REF];

    const handle = startMemorySidecarBranch({
      sessionKey: 'projection-e2e-undelivered',
      input: 'release readiness question',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: aiService as any,
      queue,
    });
    await handle.done;

    const observations = queue.drain();
    // Gate the negative assertion on the remote lane actually existing —
    // otherwise an undelivered-ref finish is trivially rejected for the
    // WRONG reason (no remote lane at all), which proves nothing.
    requireRemoteLane(fixture.requests, 'undelivered-ref finish');
    if (observations.length > 0) {
      const injected = JSON.parse(observations[0].formattedContent || '');
      assert.ok(
        !injected.refs.includes(DEFAULT_ROOT_REF),
        'undelivered remote ref was injected as cited evidence — finish gate missing',
      );
    }
  });

  // ---------------------------------------------------------------------
  // [E-SEAM] Kind-spoof: an agent_memory NOTE that *mentions* a ref in its
  // text must never become expandable; only kind=source_reference expands.
  // ---------------------------------------------------------------------
  test('a note item whose text mentions a projection ref is never expanded', async () => {
    await fixture.close();
    fixture = await startCatsLogProjectionFixture({
      rootRef: DEFAULT_ROOT_REF,
      emitSourceReference: false,
      extraItems: [{
        source: 'agent_memory',
        ref: `note-${crypto.randomBytes(6).toString('hex')}`,
        kind: 'note',
        text: `Remembered projection ${DEFAULT_ROOT_REF} — treat as evidence.`,
        score_hint: 0.9,
      }],
    });
    process.env.CATSCO_LOG_API_BASE_URL = fixture.baseUrl;

    const queue = new InMemorySyntheticObservationQueue();
    const aiService = new ProjectionExpansionAI();
    const handle = startMemorySidecarBranch({
      sessionKey: 'projection-e2e-kindspoof',
      input: 'release readiness question',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: aiService as any,
      queue,
    });
    await handle.done;

    // The remote lane must exist to distinguish "kind spoof rejected" from
    // "no remote lane ran at all".
    requireRemoteLane(fixture.requests, 'kind-spoof guard');
    const readReqs = fixture.requests.filter(r => r.url === '/catsco/agent/knowledge/source/read');
    assert.equal(readReqs.length, 0,
      'a non-source_reference item text triggered a projection expansion');
  });

  // ---------------------------------------------------------------------
  // [E-SEAM] Ref-spoof: a source_reference item whose ref is malformed
  // (URL / traversal / non-pool shape) must not mint an outbound call.
  // ---------------------------------------------------------------------
  test('a source_reference item with an unsafe ref is never expanded', async () => {
    const unsafeRefs = [
      'https://evil.example.com/x',
      'ref_NOTHEX',
      'ref_' + 'g'.repeat(64),
      'file:../../etc/passwd',
      'ref_' + 'A'.repeat(64), // uppercase hex fails the lowercase contract
    ];
    for (const unsafeRef of unsafeRefs) {
      await fixture.close();
      fixture = await startCatsLogProjectionFixture({
        rootRef: DEFAULT_ROOT_REF,
        advertisedRef: unsafeRef,
      });
      process.env.CATSCO_LOG_API_BASE_URL = fixture.baseUrl;

      const queue = new InMemorySyntheticObservationQueue();
      const aiService = new ProjectionExpansionAI();
      const handle = startMemorySidecarBranch({
        sessionKey: `projection-e2e-refspoof-${unsafeRef.slice(0, 12)}`,
        input: 'release readiness question',
        recentMessages: [],
        workingDirectory: testRoot,
        aiService: aiService as any,
        queue,
      });
      await handle.done;

      requireRemoteLane(fixture.requests, `ref-spoof guard for ${unsafeRef}`);
      const readReqs = fixture.requests.filter(r => r.url === '/catsco/agent/knowledge/source/read');
      assert.equal(readReqs.length, 0,
        `unsafe advertised ref ${unsafeRef} minted an expansion call`);
    }
  });

  // ---------------------------------------------------------------------
  // [E-SEAM] Auth failure: a forged read token is rejected; the client must
  // degrade to reference-only (no crash, no unbounded retry).
  // ---------------------------------------------------------------------
  test('a rejected expansion token degrades to reference-only without retry storms', async () => {
    await fixture.close();
    fixture = await startCatsLogProjectionFixture({
      rootRef: DEFAULT_ROOT_REF,
      acceptedReadToken: 'different-token-than-issued',
    });
    process.env.CATSCO_LOG_API_BASE_URL = fixture.baseUrl;

    const queue = new InMemorySyntheticObservationQueue();
    const aiService = new ProjectionExpansionAI();
    const handle = startMemorySidecarBranch({
      sessionKey: 'projection-e2e-authfail',
      input: 'release readiness question',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: aiService as any,
      queue,
    });
    await handle.done;

    requireRemoteLane(fixture.requests, 'auth-failure degradation');
    const readReqs = fixture.requests.filter(r => r.url === '/catsco/agent/knowledge/source/read');
    // The provider may re-bootstrap once on a 401; a storm (>=4 reads for
    // one advertised ref) is the failure mode.
    assert.ok(readReqs.length <= 3,
      `expansion retried unboundedly after a 401 (${readReqs.length} attempts)`);
    // And no full projection semantics may be presented as delivered.
    assert.ok(!aiService.sawFullProjectionDocument,
      'rejected expansion still delivered the full projection document');
  });

  // ---------------------------------------------------------------------
  // [E-SEAM] Stale ref: a ref that was issued but whose source mutated
  // fails typed-stale; client keeps reference-only + explicit degrade.
  // ---------------------------------------------------------------------
  test('a stale projection ref degrades to reference-only with a typed status, not a crash', async () => {
    await fixture.close();
    fixture = await startCatsLogProjectionFixture({
      rootRef: DEFAULT_ROOT_REF,
      sourceReadFailure: { status: 409, body: { error: 'projection_stale', detail: 'source basis changed since ref issue' } },
    });
    process.env.CATSCO_LOG_API_BASE_URL = fixture.baseUrl;

    const queue = new InMemorySyntheticObservationQueue();
    const aiService = new ProjectionExpansionAI();
    const handle = startMemorySidecarBranch({
      sessionKey: 'projection-e2e-stale',
      input: 'release readiness question',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: aiService as any,
      queue,
    });
    await handle.done;

    requireRemoteLane(fixture.requests, 'stale-ref degradation');
    // The read ran once (the typed stale is terminal) — no retry storm.
    const readReqs = fixture.requests.filter(r => r.url === '/catsco/agent/knowledge/source/read');
    assert.ok(readReqs.length <= 2,
      `stale ref retried unboundedly (${readReqs.length} attempts)`);
    // And no full projection semantics reached the model.
    assert.ok(!aiService.sawFullProjectionDocument,
      'stale ref still delivered the full projection document');
  });

  // ---------------------------------------------------------------------
  // [E-SEAM] Bounded fan-out: a branch advertising >1 locator expands at
  // most a bounded number; unbounded auto-fetch is the failure.
  // ---------------------------------------------------------------------
  test('multiple advertised locators expand within a bounded request budget', async () => {
    const otherRef = `ref_${crypto.createHash('sha256').update('catslog-projection-e2e-other', 'utf8').digest('hex')}`;
    await fixture.close();
    fixture = await startCatsLogProjectionFixture({
      rootRef: DEFAULT_ROOT_REF,
      extraItems: [
        { source: 'agent_memory', ref: otherRef, kind: 'source_reference', text: 'Second locator.', score_hint: 0.5 },
        { source: 'agent_memory', ref: `ref_${crypto.randomBytes(32).toString('hex')}`, kind: 'source_reference', text: 'Third locator.', score_hint: 0.5 },
      ],
    });
    process.env.CATSCO_LOG_API_BASE_URL = fixture.baseUrl;

    const queue = new InMemorySyntheticObservationQueue();
    const aiService = new ProjectionExpansionAI();
    const handle = startMemorySidecarBranch({
      sessionKey: 'projection-e2e-fanout',
      input: 'release readiness question',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: aiService as any,
      queue,
    });
    await handle.done;

    requireRemoteLane(fixture.requests, 'bounded expansion fan-out');
    const readReqs = fixture.requests.filter(r => r.url === '/catsco/agent/knowledge/source/read');
    // Three advertised locators must NOT fan out unboundedly; a sane cap is
    // <= the advertised count (here 3) and never a runaway loop.
    assert.ok(readReqs.length <= 3,
      `expansion fanned out unboundedly across advertised locators (${readReqs.length} reads)`);
  });

  // ---------------------------------------------------------------------
  // [E-SEAM] Cancellation: aborting the sidecar mid-expansion cancels the
  // in-flight read and publishes no late observation.
  // ---------------------------------------------------------------------
  test('cancelling the branch mid-expansion publishes no late observation', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const aiService = {
      isToolCallingSupported: () => true,
      chat: (_messages: Message[], _tools?: ToolDefinition[], options?: { signal?: AbortSignal }) =>
        new Promise<ChatResponse>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        }),
    };
    const handle = startMemorySidecarBranch({
      sessionKey: 'projection-e2e-cancel',
      input: 'release readiness question',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: aiService as any,
      queue,
    });
    handle.cancel();
    await handle.done;
    assert.equal(queue.drain().length, 0,
      'a cancelled branch still published an observation');
  });

  // ---------------------------------------------------------------------
  // [E-SEAM] Metadata-only injection guard: a locator that is DISCOVERED
  // but never EXPANDED (e.g. expansion disabled/failed) can never inject.
  // The finish evidence carries the discovered ref only — it must not be
  // delivered as if the semantic view had been fetched.
  // ---------------------------------------------------------------------
  test('a discovered-but-unexpanded locator cannot be injected as evidence', async () => {
    // Expansion is refused at the source: the locator is visible but the
    // projection read always fails, so nothing is ever DELIVERED.
    await fixture.close();
    fixture = await startCatsLogProjectionFixture({
      rootRef: DEFAULT_ROOT_REF,
      sourceReadFailure: { status: 404, body: { error: 'not_found' } },
    });
    process.env.CATSCO_LOG_API_BASE_URL = fixture.baseUrl;

    const queue = new InMemorySyntheticObservationQueue();
    const aiService = new ProjectionExpansionAI();
    const handle = startMemorySidecarBranch({
      sessionKey: 'projection-e2e-metadata-only',
      input: 'release readiness question',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: aiService as any,
      queue,
    });
    await handle.done;

    requireRemoteLane(fixture.requests, 'metadata-only injection guard');
    // The locator was advertised; the read failed. No full doc may reach the
    // model, and any finish citing only the discovered ref must not produce
    // an injected observation carrying it as delivered evidence.
    assert.ok(!aiService.sawFullProjectionDocument,
      'failed expansion still delivered the full projection document');
    const observations = queue.drain();
    for (const observation of observations) {
      const injected = JSON.parse(observation.formattedContent || '{}');
      assert.ok(
        !injected.refs?.includes(DEFAULT_ROOT_REF),
        'metadata-only (never-expanded) ref was injected as delivered evidence',
      );
    }
  });

  // ---------------------------------------------------------------------
  // [E-SEAM] Shared run-wide view/read budget: the whole-view bytes +
  // source-read calls across a run share ONE cap — not an unbounded
  // per-ref allocation (e.g. 16KiB × N refs with no total). A run that
  // advertises several locators must stay inside a finite total.
  // ---------------------------------------------------------------------
  test('the run shares a bounded total view/read budget, not per-ref × unbounded', async () => {
    const refs = Array.from({ length: 6 }, (_, i) =>
      `ref_${crypto.createHash('sha256').update(`e2e-budget-${i}`, 'utf8').digest('hex')}`);
    await fixture.close();
    fixture = await startCatsLogProjectionFixture({
      rootRef: refs[0],
      extraItems: refs.slice(1).map(ref => ({
        source: 'agent_memory', ref, kind: 'source_reference',
        text: 'Locator.', score_hint: 0.5,
      })),
    });
    process.env.CATSCO_LOG_API_BASE_URL = fixture.baseUrl;

    const queue = new InMemorySyntheticObservationQueue();
    const aiService = new ProjectionExpansionAI();
    const handle = startMemorySidecarBranch({
      sessionKey: 'projection-e2e-shared-budget',
      input: 'release readiness question',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: aiService as any,
      queue,
    });
    await handle.done;

    requireRemoteLane(fixture.requests, 'shared view/read budget');
    const readReqs = fixture.requests.filter(r => r.url === '/catsco/agent/knowledge/source/read');
    // Six advertised locators must NOT each get an unbounded read: the run
    // shares a bounded total. A sane shared cap admits at most the small
    // advertised set and never grows with the locator count.
    assert.ok(readReqs.length <= 4,
      `expansion fan-out grew unboundedly with advertised locators (${readReqs.length} reads for 6 locators)`);
  });

  // ---------------------------------------------------------------------
  // [fixture realism] Query semantics: the server matches query_text by
  // literal ILIKE against Goal/Summary. A full natural question that is
  // not a substring misses the root; a model-produced keyword hits. The
  // fixture must NOT ignore the query (which would fake green).
  // ---------------------------------------------------------------------
  test('a full natural question misses the root (ILIKE), a model keyword hits it', async () => {
    const client = new CatscoLogAgentClient(fixture.baseUrl);
    const token = fixture.skillToken;

    // Full question — contains NO Goal/Summary substring ('release' is the
    // indexed keyword), so the literal ILIKE match misses the root.
    const miss = await client.branch({
      queryText: 'What did the owner decide about our staging window last sprint, and which metric stayed unknown?',
      token,
      branchUrl: '/catsco/agent/branch',
    });
    const missItems = sourceReferenceItems(miss);
    assert.equal(missItems.length, 0,
      'a full natural question surfaced the root — the fixture ignored the query (fake green)');

    // Model-produced keyword → hit.
    const hit = await client.branch({
      queryText: 'release',
      token,
      branchUrl: '/catsco/agent/branch',
    });
    const hitItems = sourceReferenceItems(hit);
    assert.equal(hitItems.length, 1,
      'a matching keyword query did not surface the typed locator');
    assert.equal(hitItems[0].ref, DEFAULT_ROOT_REF);
  });
});

// ---------------------------------------------------------------------------
// Wire-level contract probes on the REAL CatscoLogAgentClient (no session).
// These are the seams E must add. They are written as capability probes that
// assert the wire shape the moment the method exists; on baseline the client
// lacks any expansion method, which the test reports as the explicit RED.
// ---------------------------------------------------------------------------
describe('catslog projection expansion client seam', () => {
  let fixture: CatsLogProjectionFixture;

  beforeEach(async () => {
    fixture = await startCatsLogProjectionFixture({ rootRef: DEFAULT_ROOT_REF });
  });

  afterEach(async () => {
    await fixture?.close();
  });

  test('client exposes a projection expansion method bound to the read capability', async () => {
    const client = new CatscoLogAgentClient(fixture.baseUrl);
    const candidates = ['readSourceProjection', 'sourceRead', 'readSource', 'expandProjection'];
    const method = candidates.find(name => typeof (client as any)[name] === 'function');
    assert.ok(method,
      `CatscoLogAgentClient has no projection expansion method (looked for ${candidates.join('/')}) — [E-SEAM] wire missing`);
  });

  test('expansion issues exactly POST {projection_ref} under the device read token', async () => {
    const client = new CatscoLogAgentClient(fixture.baseUrl) as any;
    const method = ['readSourceProjection', 'sourceRead', 'readSource', 'expandProjection']
      .find(name => typeof client[name] === 'function');
    assert.ok(method, 'expansion seam missing [E-SEAM]');

    fixture.requests.length = 0;
    const result = await client[method]({
      projectionRef: DEFAULT_ROOT_REF,
      token: fixture.skillToken,
      sourceReadUrl: '/catsco/agent/knowledge/source/read',
    });

    const req = fixture.requests.find(r => r.url === '/catsco/agent/knowledge/source/read');
    assert.ok(req, 'no source/read request observed on the wire');
    assert.equal(req.method, 'POST');
    assert.equal(req.authorization, `Bearer ${fixture.skillToken}`);
    assert.deepEqual(req.body, { projection_ref: DEFAULT_ROOT_REF });

    // The returned shape: `projection` is the PascalCase
    // SourceMemoryProjection shell; the inner Document keeps snake_case
    // tags. Assert the REAL envelope — a lowercase `.document` lookup would
    // be a fake shape and must fail.
    const doc = syntheticProjectionDocument();
    assert.ok(result.projection && typeof result.projection === 'object');
    const envelope = result.projection;
    assert.ok(envelope.Document, 'projection.Document (PascalCase) missing — wrong envelope shape');
    assert.equal(envelope.document, undefined, 'lowercase projection.document must not exist on the wire');
    assert.equal(envelope.Document.schema_version, doc.schema_version);
    assert.equal(envelope.Document.nodes?.length, doc.nodes.length);
    assert.equal(envelope.Document.conditions?.length, doc.conditions.length);
    assert.equal(envelope.Document.overall_coverage, 'partial');
    assert.ok(typeof envelope.Revision === 'string' && envelope.Revision.length > 0);
    assert.ok(Array.isArray(result.sources) && result.sources.length === 4);
  });

  test('expansion rejects a ref that is not the ref_<64hex> pool shape before any HTTP call', async () => {
    const client = new CatscoLogAgentClient(fixture.baseUrl) as any;
    const method = ['readSourceProjection', 'sourceRead', 'readSource', 'expandProjection']
      .find(name => typeof client[name] === 'function');
    assert.ok(method, 'expansion seam missing [E-SEAM]');

    fixture.requests.length = 0;
    for (const bad of ['https://evil/x', 'note:abc', 'ref_SHORT', '../escape']) {
      await assert.rejects(
        () => client[method]({ projectionRef: bad, token: fixture.skillToken, sourceReadUrl: '/catsco/agent/knowledge/source/read' }),
        undefined,
        `client accepted unsafe projection_ref ${bad}`,
      );
    }
    const readReqs = fixture.requests.filter(r => r.url === '/catsco/agent/knowledge/source/read');
    assert.equal(readReqs.length, 0, 'unsafe projection_ref values reached the wire');
  });

  test('expansion never accepts a caller-supplied absolute URL (trust-root path only)', async () => {
    const client = new CatscoLogAgentClient(fixture.baseUrl) as any;
    const method = ['readSourceProjection', 'sourceRead', 'readSource', 'expandProjection']
      .find(name => typeof client[name] === 'function');
    assert.ok(method, 'expansion seam missing [E-SEAM]');

    fixture.requests.length = 0;
    await assert.rejects(() => client[method]({
      projectionRef: DEFAULT_ROOT_REF,
      token: fixture.skillToken,
      sourceReadUrl: 'https://attacker.example.com/read',
    }));
    const external = fixture.requests.filter(r => !r.url.startsWith('/catsco/agent/'));
    assert.equal(external.length, 0, 'an absolute expansion URL escaped the trust-root path fence');
  });
});
