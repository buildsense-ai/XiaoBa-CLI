import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startMemorySidecarBranch } from '../src/core/sidecar-memory-branch';
import { buildSearchAny } from '../src/core/memory-search-branch-session';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import { ChatResponse, Message } from '../src/types';
import { ToolCall, ToolDefinition } from '../src/types/tool';
import type { CatscoBranchQuery, CatscoBranchResponse } from '../src/utils/catsco-log-agent-client';
import type { CatsLogMemoryBackend } from '../src/utils/catslog-memory-provider';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function call(id: string, name: string, args: unknown): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

class RemoteEvidenceMemory implements CatsLogMemoryBackend {
  branchQueries: CatscoBranchQuery[] = [];
  branchResponse: CatscoBranchResponse = {
    schema_version: 1,
    content_trust: 'untrusted_branch_evidence',
    request_id: 'req-v13-1',
    status: 'ok',
    branches: [
      {
        source: 'session_graph',
        status: 'ok',
        items: [{
          source: 'session',
          ref: 'stream-release#17',
          kind: 'session_turn',
          text: 'release decision: keep nginx read-only mount',
          score_hint: 0.9,
        }],
      },
      { source: 'skill', status: 'timeout' },
    ],
  };
  branchShouldFail = false;

  async branch(query: CatscoBranchQuery): Promise<CatscoBranchResponse> {
    this.branchQueries.push(query);
    if (this.branchShouldFail) throw new Error('branch endpoint down');
    return this.branchResponse;
  }
}

/**
 * v1.3 pipeline fake: turn 1 assesses, turn 2 finishes citing the remote ref
 * carried by the evidence pack. Any third chat call is a pipeline violation.
 */
class AssessThenFinishAI {
  calls: Array<{ toolNames: string[]; messages: Message[] }> = [];

  isToolCallingSupported(): boolean {
    return true;
  }

  evidencePackIn(messages: Message[]): any | undefined {
    const pack = [...messages].reverse().find(message => (
      message.role === 'user'
      && typeof message.content === 'string'
      && message.content.includes('evidence_pack')
    ));
    if (!pack || typeof pack.content !== 'string') return undefined;
    try {
      return JSON.parse(pack.content);
    } catch {
      return undefined;
    }
  }

  evidencePackRefs(messages: Message[]): string[] {
    const pack = this.evidencePackIn(messages);
    if (!pack) return [];
    return [
      ...(pack.evidence_pack?.remote_branch?.branches || [])
        .flatMap((branch: any) => (branch.items || []).map((item: any) => item.ref)),
      ...(pack.evidence_pack?.session_records?.records || []).map((record: any) => record.ref),
      ...(pack.evidence_pack?.local_knowledge?.entries || []).map((entry: any) => entry.ref),
    ].filter((ref: unknown) => typeof ref === 'string');
  }

  async chat(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.calls.push({
      toolNames: tools?.map(tool => tool.name) || [],
      messages: JSON.parse(JSON.stringify(messages)),
    });
    if (this.calls.length === 1) {
      return {
        content: null,
        toolCalls: [call('assess-1', 'assess_memory_need', {
          action: 'recall',
          query_text: 'release checklist decision',
          keywords: ['release', 'nginx', 'rollback'],
          sources: ['session_graph', 'skill'],
        })],
        usage,
      };
    }
    const refs = this.evidencePackRefs(messages);
    return {
      content: null,
      toolCalls: [call('finish-1', 'finish_memory_search', refs.length > 0 ? {
        summary: 'CatsLog returned a relevant release decision.',
        refs: [refs[0]],
        inject: true,
        delivery: 'context',
      } : {
        summary: 'No usable evidence arrived from either lane.',
        refs: [],
        inject: false,
        delivery: 'discard',
      })],
      usage,
    };
  }
}

/** Cites every ref in the evidence pack (pool + session + KB forms). */
class CiteEveryPackRefAI extends AssessThenFinishAI {
  async chat(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.calls.push({
      toolNames: tools?.map(tool => tool.name) || [],
      messages: JSON.parse(JSON.stringify(messages)),
    });
    if (this.calls.length === 1) {
      return {
        content: null,
        toolCalls: [call('assess-1', 'assess_memory_need', {
          action: 'recall',
          query_text: 'release checklist decision',
          keywords: ['release'],
        })],
        usage,
      };
    }
    const refs = this.evidencePackRefs(messages);
    return {
      content: null,
      toolCalls: [call('finish-1', 'finish_memory_search', {
        summary: 'Cited every observed ref form for the citation pipeline.',
        refs,
        inject: true,
        delivery: 'context',
      })],
      usage,
    };
  }
}

class SkipAssessAI {
  calls: Array<{ toolNames: string[] }> = [];

  isToolCallingSupported(): boolean {
    return true;
  }

  async chat(_messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.calls.push({ toolNames: tools?.map(tool => tool.name) || [] });
    return {
      content: null,
      toolCalls: [call('assess-skip', 'assess_memory_need', {
        action: 'skip',
        reason: '闲聊，主 agent 凭上下文即可回答。',
      })],
      usage,
    };
  }
}

/** Defensive: if pass 2 ever ran, this fake records it loudly. */
class SingleCallProbeAI {
  calls: Array<{ toolNames: string[] }> = [];

  isToolCallingSupported(): boolean {
    return true;
  }

  async chat(_messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.calls.push({ toolNames: tools?.map(tool => tool.name) || [] });
    return {
      content: null,
      toolCalls: [call('assess-1', 'assess_memory_need', {
        action: 'recall',
        query_text: 'release checklist decision',
        keywords: ['release'],
      })],
      usage,
    };
  }
}

class ToggleRemoteMemory extends RemoteEvidenceMemory {
  available = false;

  isAvailable(): boolean {
    return this.available;
  }
}

/** Adds the device-bound session query lane to the branch fake. */
class SessionQueryMemory extends RemoteEvidenceMemory {
  sessionQueries: Array<Record<string, unknown>> = [];
  sessionResponse: unknown = { records: [] };
  sessionError: Error | null = null;

  async querySessions(query: { searchAny?: string[]; latest?: boolean; limit?: number }): Promise<unknown> {
    this.sessionQueries.push({ ...query });
    if (this.sessionError) throw this.sessionError;
    return this.sessionResponse;
  }
}

class ThrowingAvailabilityMemory extends RemoteEvidenceMemory {
  isAvailable(): boolean {
    throw new Error('corrupt capability state');
  }
}

describe('CatsLog memory branch pipeline (v1.3)', () => {
  let testRoot: string;
  let previousUserDataDir: string | undefined;

  beforeEach(() => {
    previousUserDataDir = process.env.XIAOBA_USER_DATA_DIR;
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-catslog-pipeline-'));
    process.env.XIAOBA_USER_DATA_DIR = testRoot;
  });

  afterEach(() => {
    if (previousUserDataDir === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('runs exactly two inferences: assess recall then finish with observed remote evidence', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new AssessThenFinishAI();
    const backend = new RemoteEvidenceMemory();
    const handle = startMemorySidecarBranch({
      sessionKey: 'remote-memory-pipeline',
      input: 'what is our release checklist?',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      catslogMemory: backend,
      logEnabled: false,
    });

    await handle.done;

    // Pipeline shape: exactly two model calls, one tool on the surface each.
    assert.equal(ai.calls.length, 2);
    assert.deepEqual(ai.calls[0].toolNames, ['assess_memory_need']);
    assert.deepEqual(ai.calls[1].toolNames, ['finish_memory_search']);

    // Mechanical stage composed the provider query from the assess decision.
    assert.equal(backend.branchQueries.length, 1);
    assert.equal(backend.branchQueries[0].queryText, 'release checklist decision');
    assert.deepEqual(backend.branchQueries[0].sources, ['session_graph', 'skill']);

    // The evidence pack reached pass 2 with the remote evidence embedded.
    const pack = ai.evidencePackIn(ai.calls[1].messages);
    assert.ok(pack, 'pass 2 must carry the evidence pack');
    assert.equal(pack.evidence_pack.content_trust, 'untrusted_branch_evidence');
    assert.equal(pack.evidence_pack.remote_branch.branches[0].items[0].ref, 'stream-release#17');

    const observations = queue.drain();
    assert.equal(observations.length, 1);
    const injected = JSON.parse(observations[0].formattedContent || '');
    assert.deepEqual(injected.refs, ['stream-release#17']);
    assert.equal(injected.summary.includes('release decision'), true);

    // Pass-1 prompt states the pipeline contract.
    const systemPrompt = ai.calls[0].messages.find(message => message.role === 'system')?.content as string;
    assert.match(systemPrompt, /assess_memory_need/);
    assert.match(systemPrompt, /至多两次模型调用/);
    assert.match(systemPrompt, /delivery:discard/);
    assert.match(systemPrompt, /不可信 evidence/);
  });

  test('verdict absent still runs pass 2 (unknown verdict never skips refine)', async () => {
    // RemoteEvidenceMemory.branchResponse has no evidence_verdict field — the
    // happy-path test above already proves refine ran; assert the surface
    // explicitly here via the recorded finish payload.
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new AssessThenFinishAI();
    const backend = new RemoteEvidenceMemory();
    assert.equal('evidence_verdict' in (backend.branchResponse.branches?.[0] || {}), false);
    const handle = startMemorySidecarBranch({
      sessionKey: 'verdict-absent',
      input: 'what is our release checklist?',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      catslogMemory: backend,
      logEnabled: false,
    });

    await handle.done;
    assert.equal(ai.calls.length, 2);
    assert.equal(queue.drain().length, 1);
  });

  test('skip path finishes with delivery:discard after exactly one inference', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new SkipAssessAI();
    const backend = new RemoteEvidenceMemory();
    const handle = startMemorySidecarBranch({
      sessionKey: 'skip-pipeline',
      input: '今天天气不错',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      catslogMemory: backend,
      logEnabled: true,
    });

    await handle.done;

    assert.equal(ai.calls.length, 1);
    assert.equal(backend.branchQueries.length, 0);
    assert.equal(queue.drain().length, 0);
    const logs = readBranchLogs(testRoot);
    assert.match(logs, /assess_decision/);
    assert.match(logs, /suppressed_observation/);
    assert.doesNotMatch(logs, /published_observation/);
  });

  test('session_graph verdict none with no evidence anywhere skips pass 2', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new SingleCallProbeAI();
    const backend = new RemoteEvidenceMemory();
    backend.branchResponse = {
      content_trust: 'untrusted_branch_evidence',
      branches: [
        { source: 'session_graph', status: 'ok', evidence_verdict: 'none', items: [] },
        { source: 'agent_memory', status: 'ok', items: [] },
        { source: 'skill', status: 'timeout' },
      ],
    };
    const handle = startMemorySidecarBranch({
      sessionKey: 'verdict-none',
      input: 'find prior release notes',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      catslogMemory: backend,
      logEnabled: true,
    });

    await handle.done;

    // Exactly one inference: the verdict gate ended the run mechanically.
    assert.equal(ai.calls.length, 1);
    assert.equal(backend.branchQueries.length, 1);
    assert.equal(queue.drain().length, 0);
    const logs = readBranchLogs(testRoot);
    assert.match(logs, /verdict_gate/);
    assert.match(logs, /suppressed_observation/);
    assert.doesNotMatch(logs, /published_observation|audited_observation/);
  });

  test('session_graph verdict none still refines when another branch returned evidence', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new AssessThenFinishAI();
    const backend = new RemoteEvidenceMemory();
    backend.branchResponse = {
      content_trust: 'untrusted_branch_evidence',
      branches: [
        { source: 'session_graph', status: 'ok', evidence_verdict: 'none', items: [] },
        {
          source: 'skill',
          status: 'ok',
          items: [{
            source: 'skill',
            ref: 'catslog:skill:release-playbook@3',
            kind: 'skill',
            score_hint: 0.9,
          }],
        },
      ],
    };
    const handle = startMemorySidecarBranch({
      sessionKey: 'verdict-none-with-evidence',
      input: 'find prior release notes',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      catslogMemory: backend,
      logEnabled: false,
    });

    await handle.done;

    assert.equal(ai.calls.length, 2);
    const pack = ai.evidencePackIn(ai.calls[1].messages);
    assert.equal(
      pack.evidence_pack.remote_branch.branches.some((branch: any) => branch.source === 'skill'),
      true,
    );
    assert.equal(queue.drain().length, 1);
  });

  test('session failure keeps branch evidence with a typed unavailable status and never scans local logs', async () => {
    // Plant a local "hit" that matches the query: if any local lane existed,
    // this file would be scanned and its ref would appear. It must not.
    const foreignDir = path.join(testRoot, 'logs', 'sessions', 'chat', '2026-06-09');
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.writeFileSync(
      path.join(foreignDir, 'demo.jsonl'),
      JSON.stringify({
        entry_type: 'turn', turn: 1, timestamp: '2026-06-09T10:00:00.000Z',
        session_id: 'chat:demo', session_type: 'chat',
        user: { text: 'release checklist nginx mount rollback decision' },
        assistant: { text: 'Decision: keep the read-only mount.', tool_calls: [] },
      }) + '\n',
      'utf-8',
    );

    const queue = new InMemorySyntheticObservationQueue();
    const ai = new AssessThenFinishAI();
    const backend = new SessionQueryMemory();
    backend.branchShouldFail = true;
    backend.sessionError = Object.assign(new Error('analysis_unavailable'), { status: 503 });
    backend.sessionResponse = undefined as unknown as { records: [] };
    const handle = startMemorySidecarBranch({
      sessionKey: 'session-failure',
      input: 'find prior release notes',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      catslogMemory: backend,
      logEnabled: true,
    });

    await handle.done;

    assert.equal(ai.calls.length, 2);
    const pack = ai.evidencePackIn(ai.calls[1].messages);
    assert.match(String(pack.evidence_pack.session_records.note), /analysis_unavailable/);
    assert.equal(pack.evidence_pack.session_records.status, 'unavailable');
    // Scope isolation by construction: no local scan, no local evidence keys,
    // and the planted foreign file never leaks into any message or log.
    assert.equal('local_matches' in pack.evidence_pack, false);
    assert.equal('local_turns' in pack.evidence_pack, false);
    const allMessages = JSON.stringify(ai.calls);
    assert.equal(allMessages.includes('demo.jsonl'), false);
    assert.equal(allMessages.includes('keep the read-only mount'), false);
    assert.doesNotMatch(readBranchLogs(testRoot), /demo\.jsonl/);
    // Both lanes failed: the finish still ran (verdict fallback), found no
    // evidence, and discarded.
    assert.match(readBranchLogs(testRoot), /mechanical_retrieval/);
    assert.equal(queue.drain().length, 0);
  });

  test('session_graph verdict none still refines when the session query returned records', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new AssessThenFinishAI();
    const backend = new SessionQueryMemory();
    backend.branchResponse = {
      content_trust: 'untrusted_branch_evidence',
      branches: [
        { source: 'session_graph', status: 'ok', evidence_verdict: 'none', items: [] },
        { source: 'agent_memory', status: 'ok', items: [] },
      ],
    };
    backend.sessionResponse = {
      content_trust: 'untrusted_log_data',
      records: [{
        ref: 'stream-release#17',
        session_type: 'chat',
        user: { text: 'release checklist decision: read-only mount' },
      }],
    };
    const handle = startMemorySidecarBranch({
      sessionKey: 'verdict-none-session-hits',
      input: 'find prior release notes',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      catslogMemory: backend,
      logEnabled: false,
    });

    await handle.done;

    // Session records count as usable evidence: pass 2 must run even though
    // the session_graph branch verdict was `none`.
    assert.equal(ai.calls.length, 2);
    const pack = ai.evidencePackIn(ai.calls[1].messages);
    assert.equal(pack.evidence_pack.session_records.records[0].ref, 'stream-release#17');
    assert.equal(pack.evidence_pack.session_records.content_trust, 'untrusted_log_data');
    const observations = queue.drain();
    assert.equal(observations.length, 1);
    const injected = JSON.parse(observations[0].formattedContent || '');
    assert.deepEqual(injected.refs, ['stream-release#17']);
  });

  test('keyword truncation beyond the 8-keyword wire cap is visible', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const backend = new SessionQueryMemory();
    const oversizedAI = {
      calls: [] as Array<{ toolNames: string[]; messages: Message[] }>,
      isToolCallingSupported: () => true,
      async chat(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
        this.calls.push({ toolNames: tools?.map(tool => tool.name) || [], messages: JSON.parse(JSON.stringify(messages)) });
        if (this.calls.length === 1) {
          return {
            content: null,
            toolCalls: [call('assess-1', 'assess_memory_need', {
              action: 'recall',
              query_text: 'release checklist decision',
              keywords: Array.from({ length: 11 }, (_, index) => `kw_${index + 1}`),
            })],
            usage,
          };
        }
        const pack = JSON.parse(
          [...messages].reverse().find(message => (
            message.role === 'user' && String(message.content).includes('evidence_pack')
          ))?.content as string,
        );
        return {
          content: null,
          toolCalls: [call('finish-1', 'finish_memory_search', {
            summary: 'keywords were truncated; nothing useful arrived.',
            refs: [],
            inject: false,
            delivery: 'discard',
          })],
          usage,
        };
      },
    };
    const handle = startMemorySidecarBranch({
      sessionKey: 'keyword-truncation',
      input: 'find prior release notes',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: oversizedAI as any,
      queue,
      catslogMemory: backend,
      logEnabled: true,
    });

    await handle.done;

    // Only the first 8 distinct keywords reached the server.
    assert.equal(backend.sessionQueries.length, 1);
    assert.deepEqual(backend.sessionQueries[0].searchAny,
      ['kw_1', 'kw_2', 'kw_3', 'kw_4', 'kw_5', 'kw_6', 'kw_7', 'kw_8']);
    assert.equal(backend.sessionQueries[0].latest, true);
    assert.equal(backend.sessionQueries[0].limit, 20);
    // Truncation is visible to the model in the evidence pack.
    const pack = JSON.parse(
      [...oversizedAI.calls[1].messages].reverse().find(message => (
        message.role === 'user' && String(message.content).includes('evidence_pack')
      ))?.content as string,
    );
    assert.equal(pack.evidence_pack.keywords_truncated, true);
    assert.match(pack.evidence_pack.keyword_note, /8/);
  });

  test('current conversational context stays in the assess prompt without disk I/O', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new AssessThenFinishAI();
    const backend = new SessionQueryMemory();
    const handle = startMemorySidecarBranch({
      sessionKey: 'current-context',
      input: 'what is our release checklist?',
      recentMessages: [
        { role: 'user', content: 'recent context question about the deploy window' },
        { role: 'assistant', content: 'recent context answer: deploy window is Friday.' },
      ],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      catslogMemory: backend,
      logEnabled: false,
    });

    await handle.done;

    const firstUser = ai.calls[0].messages.find(message => message.role === 'user')?.content as string;
    const payload = JSON.parse(firstUser);
    assert.equal(payload.current_user_input, 'what is our release checklist?');
    assert.equal(payload.recent_completed_turns.length, 1);
    assert.match(payload.recent_completed_turns[0].user, /deploy window/);
    assert.match(payload.recent_completed_turns[0].assistant_final, /Friday/);
    assert.equal(payload.catslog_memory_source_available, true);
    assert.equal('memory_source_available' in payload, false);
  });

  test('local distilled-knowledge hits keep refine alive and kb refs pass the observed-refs guard', async () => {
    // Curated KB doc under the runtime knowledge root; remote lanes return
    // verdict=none with no items, so only the KB lane can keep refine alive.
    const knowledgeRoot = path.join(testRoot, 'knowledge');
    const kbId = 'KB-0f1e2d3c-4b5a-4677-8899-aabbccddeeff';
    writeKnowledgeDocument(knowledgeRoot, kbId, 'Release checklist', 'release checklist: nginx read-only mount, rollback via flag');

    const queue = new InMemorySyntheticObservationQueue();
    const ai = new AssessThenFinishAI();
    const backend = new RemoteEvidenceMemory();
    backend.branchResponse = {
      content_trust: 'untrusted_branch_evidence',
      branches: [
        { source: 'session_graph', status: 'ok', evidence_verdict: 'none', items: [] },
        { source: 'agent_memory', status: 'ok', items: [] },
      ],
    };
    const handle = startMemorySidecarBranch({
      sessionKey: 'knowledge-lane',
      input: 'what is our release checklist?',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      catslogMemory: backend,
      logEnabled: true,
    });

    await handle.done;

    // The KB hit alone kept pass 2 alive despite the `none` verdict.
    assert.equal(ai.calls.length, 2);
    const pack = ai.evidencePackIn(ai.calls[1].messages);
    assert.equal(pack.evidence_pack.local_knowledge.provenance, 'local_knowledge');
    assert.equal(pack.evidence_pack.local_knowledge.scope, 'per_host_agent_owned');
    assert.equal(pack.evidence_pack.local_knowledge.content_trust, 'local_distilled_knowledge');
    assert.equal(pack.evidence_pack.local_knowledge.entries[0].ref, `kb:${kbId}`);
    assert.match(String(pack.evidence_pack.local_knowledge.entries[0].summary), /rollback/);

    // The finish cites the KB ref; the tracker observed it, so delivery stays context.
    const observations = queue.drain();
    assert.equal(observations.length, 1);
    const injected = JSON.parse(observations[0].formattedContent || '');
    assert.deepEqual(injected.refs, [`kb:${kbId}`]);
    const logs = readBranchLogs(testRoot);
    assert.match(logs, /published_observation/);
    assert.doesNotMatch(logs, /unobserved_refs_audit_only/);
  });

  test('knowledge lane failure degrades to a typed unavailable status and never blocks the pipeline', async () => {
    // No knowledge root: every lane fails, refine still runs and discards.
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new AssessThenFinishAI();
    const backend = new SessionQueryMemory();
    backend.branchShouldFail = true;
    backend.sessionError = Object.assign(new Error('analysis_unavailable'), { status: 503 });
    backend.sessionResponse = undefined as unknown as { records: [] };
    const handle = startMemorySidecarBranch({
      sessionKey: 'knowledge-lane-degraded',
      input: 'find prior release notes',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      catslogMemory: backend,
      logEnabled: true,
    });

    await handle.done;

    assert.equal(ai.calls.length, 2);
    const pack = ai.evidencePackIn(ai.calls[1].messages);
    assert.equal(pack.evidence_pack.local_knowledge.status, 'unavailable');
    assert.match(String(pack.evidence_pack.local_knowledge.note), /knowledge_root_missing/);
    assert.equal(queue.drain().length, 0);
  });

  test('context injection carries the /branch request_id with the reportable pool-ref subset', async () => {
    const knowledgeRoot = path.join(testRoot, 'knowledge');
    const kbId = 'KB-9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d';
    writeKnowledgeDocument(knowledgeRoot, kbId, 'Release checklist', 'release checklist: nginx read-only mount, rollback via flag');
    const poolRef = `ref_${'e'.repeat(64)}`;

    const queue = new InMemorySyntheticObservationQueue();
    const ai = new CiteEveryPackRefAI();
    const backend = new RemoteEvidenceMemory();
    backend.branchResponse = {
      schema_version: 1,
      content_trust: 'untrusted_branch_evidence',
      request_id: 'br-cite-1',
      status: 'ok',
      branches: [{
        source: 'session_graph',
        status: 'ok',
        items: [{ source: 'session', ref: poolRef, kind: 'session_turn', score_hint: 0.9 }],
      }],
    };
    const handle = startMemorySidecarBranch({
      sessionKey: 'citation-metadata',
      input: 'what is our release checklist?',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      catslogMemory: backend,
      logEnabled: false,
    });

    await handle.done;

    assert.equal(ai.calls.length, 2);
    // Both ref forms are finishable and observed (the pack carried them).
    const observations = queue.drain();
    assert.equal(observations.length, 1);
    const injected = JSON.parse(observations[0].formattedContent || '');
    assert.deepEqual([...injected.refs].sort(), [poolRef, `kb:${kbId}`].sort());
    // Citation telemetry: request_id + pool refs only; the kb ref stays local.
    assert.deepEqual(observations[0].metadata?.citation, {
      requestId: 'br-cite-1',
      refs: [poolRef],
    });
    assert.deepEqual([...(observations[0].metadata?.refs ?? [])].sort(), [poolRef, `kb:${kbId}`].sort());
  });

  test('old-history records stay usable and the newest-window request shape is preserved', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new AssessThenFinishAI();
    const backend = new SessionQueryMemory();
    backend.branchResponse = {
      content_trust: 'untrusted_branch_evidence',
      branches: [{ source: 'session_graph', status: 'ok', items: [] }],
    };
    backend.sessionResponse = {
      content_trust: 'untrusted_log_data',
      records: [{
        ref: 'stream-archive#2',
        session_type: 'cli',
        // Deliberately ancient: the client must not apply its own recency
        // filter on top of the server's newest-window semantics.
        timestamp: '2019-03-04T08:00:00.000Z',
        user: { text: 'release checklist decision from the archive' },
        agent: { text: 'Decision recorded years ago: read-only mount.' },
      }],
    };
    const handle = startMemorySidecarBranch({
      sessionKey: 'old-history',
      input: 'find prior release notes',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      catslogMemory: backend,
      logEnabled: false,
    });

    await handle.done;

    // The request keeps the server newest-window contract: latest=true with
    // the bounded limit — globally newest matching records across streams,
    // not one per stream, and no cursor follow in v1.
    assert.equal(backend.sessionQueries.length, 1);
    assert.equal(backend.sessionQueries[0].latest, true);
    assert.equal(backend.sessionQueries[0].limit, 20);

    // Old records that the server did return are projected and citable.
    const pack = ai.evidencePackIn(ai.calls[1].messages);
    assert.equal(pack.evidence_pack.session_records.records[0].timestamp, '2019-03-04T08:00:00.000Z');
    assert.equal(pack.evidence_pack.session_records.records[0].ref, 'stream-archive#2');
    const observations = queue.drain();
    assert.equal(observations.length, 1);
    const injected = JSON.parse(observations[0].formattedContent || '');
    assert.deepEqual(injected.refs, ['stream-archive#2']);
  });

  test('unavailable remote capability degrades to typed statuses without local retrieval', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new AssessThenFinishAI();
    const backend = new ToggleRemoteMemory();
    const handle = startMemorySidecarBranch({
      sessionKey: 'remote-unavailable',
      input: 'find prior release notes',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      catslogMemory: backend,
      logEnabled: false,
    });

    await handle.done;

    assert.equal(backend.branchQueries.length, 0);
    assert.equal(ai.calls.length, 2);
    const pack = ai.evidencePackIn(ai.calls[1].messages);
    assert.match(String(pack.evidence_pack.remote_branch.note), /unavailable/);
    assert.equal(pack.evidence_pack.session_records.status, 'unavailable');
    // The remote citation was never observed; fail-closed audit keeps it out
    // of parent context.
    assert.equal(queue.drain().length, 0);
  });

  test('fails closed when remote capability discovery throws', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new SkipAssessAI();
    const handle = startMemorySidecarBranch({
      sessionKey: 'remote-memory-discovery-error',
      input: 'find prior release notes',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      catslogMemory: new ThrowingAvailabilityMemory(),
      logEnabled: false,
    });

    await handle.done;
    assert.deepEqual(ai.calls[0].toolNames, ['assess_memory_need']);
    assert.equal(queue.drain().length, 0);
  });
});

describe('buildSearchAny keyword contract', () => {
  test('an all-invalid keyword list yields an empty term set with a visible bounded flag', () => {
    // This is the premise of the fetchServerSessions structural guard: when
    // every term is dropped (control chars / unpaired surrogates), the
    // pipeline must see an empty list and skip the query — never issue an
    // unfiltered latest-20 request.
    assert.deepEqual(buildSearchAny(['nel\u0085term', 'k\uDE00']), {
      searchAny: [],
      truncated: false,
      bounded: true,
    });
  });

  test('bounds oversized terms to 64 code points and keeps astral characters intact', () => {
    const bounded = buildSearchAny(['😀'.repeat(70)]);
    assert.equal(bounded.searchAny.length, 1);
    assert.equal(Array.from(bounded.searchAny[0]).length, 64);
    assert.equal(bounded.searchAny[0], '😀'.repeat(64));
    assert.equal(bounded.bounded, true);
    assert.equal(bounded.truncated, false);
  });

  test('dedupes case-insensitively and reports >8-term truncation', () => {
    const keywords = ['k1', 'K1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9'];
    const result = buildSearchAny(keywords);
    assert.deepEqual(result.searchAny, ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8']);
    assert.equal(result.truncated, true);
    assert.equal(result.bounded, false);
  });
});

function readBranchLogs(root: string): string {
  const branchRoot = path.join(root, 'logs', 'branches', 'memory');
  if (!fs.existsSync(branchRoot)) return '';
  const chunks: string[] = [];
  for (const dateDir of fs.readdirSync(branchRoot)) {
    const fullDateDir = path.join(branchRoot, dateDir);
    for (const fileName of fs.readdirSync(fullDateDir)) {
      chunks.push(fs.readFileSync(path.join(fullDateDir, fileName), 'utf-8'));
    }
  }
  return chunks.join('\n');
}

function writeKnowledgeDocument(root: string, id: string, title: string, summary: string): void {
  const metadata = {
    id,
    title,
    summary,
    category: 'deploy',
    updatedAt: '2026-09-10T00:00:00.000Z',
    change: 'initial write',
    sources: ['stream-release#17'],
  };
  const documents = path.join(root, 'documents');
  fs.mkdirSync(documents, { recursive: true });
  fs.writeFileSync(
    path.join(documents, `${id}.md`),
    `---\n${JSON.stringify(metadata)}\n---\n\n# ${title}\n\nnginx read-only mount stays; rollback via the feature flag.\n`,
    'utf-8',
  );
}

describe('delta-mode remote scoping', () => {
  let testRoot: string;
  let previousUserDataDir: string | undefined;

  beforeEach(() => {
    previousUserDataDir = process.env.XIAOBA_USER_DATA_DIR;
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-catslog-delta-'));
    process.env.XIAOBA_USER_DATA_DIR = testRoot;
  });

  afterEach(() => {
    if (previousUserDataDir === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('a managed KB hit narrows the session query to post-KB turns and tightens the branch budget', async () => {
    const knowledgeRoot = path.join(testRoot, 'knowledge');
    const kbId = 'KB-0f1e2d3c-4b5a-4677-8899-aabbccddeeff';
    writeKnowledgeDocument(knowledgeRoot, kbId, 'Release checklist', 'release checklist: nginx read-only mount, rollback via flag');

    const queue = new InMemorySyntheticObservationQueue();
    const ai = new AssessThenFinishAI();
    const backend = new SessionQueryMemory();
    const handle = startMemorySidecarBranch({
      sessionKey: 'delta-mode',
      input: 'what is our release checklist?',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      catslogMemory: backend,
      logEnabled: false,
    });
    await handle.done;

    // Delta boundary comes from the doc's updatedAt; the branch fan-out runs
    // under the tightened delta budget, never the default breadth.
    assert.equal(backend.sessionQueries[0]?.from, '2026-09-10T00:00:00.000Z');
    assert.deepEqual(backend.branchQueries[0]?.budgets, {
      perBranchTimeoutMs: 2_000,
      perBranchMaxItems: 6,
      totalDeadlineMs: 4_000,
    });
    // The pack marks the delta window so refine treats remote silence as
    // composed coverage, not an empty result.
    const pack = ai.evidencePackIn(ai.calls[1].messages);
    assert.equal(pack.evidence_pack.remote_delta_from, '2026-09-10T00:00:00.000Z');
    assert.match(String(pack.evidence_pack.remote_delta_note), /增量/);
  });

  test('no KB coverage leaves remote lanes at full breadth', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new AssessThenFinishAI();
    const backend = new SessionQueryMemory();
    const handle = startMemorySidecarBranch({
      sessionKey: 'no-delta',
      input: 'what is our release checklist?',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      catslogMemory: backend,
      logEnabled: false,
    });
    await handle.done;

    assert.equal(backend.sessionQueries[0]?.from, undefined);
    assert.equal(backend.branchQueries[0]?.budgets, undefined);
    const pack = ai.evidencePackIn(ai.calls[1].messages);
    assert.equal('remote_delta_from' in pack.evidence_pack, false);
  });
});
