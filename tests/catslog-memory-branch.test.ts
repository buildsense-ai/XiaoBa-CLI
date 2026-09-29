import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startMemorySidecarBranch } from '../src/core/sidecar-memory-branch';
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
      ...(pack.evidence_pack?.local_matches || []).map((match: any) => match.ref),
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

  test('remote failure degrades to local-only evidence instead of failing the run', async () => {
    const sessionDir = path.join(testRoot, 'logs', 'sessions', 'chat', '2026-06-09');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'demo.jsonl'),
      JSON.stringify({
        entry_type: 'turn',
        turn: 1,
        timestamp: '2026-06-09T10:00:00.000Z',
        session_id: 'chat:demo',
        session_type: 'chat',
        user: { text: 'release checklist: nginx mount rollback decision' },
        assistant: { text: 'Decision: keep the read-only mount.', tool_calls: [] },
        tokens: { prompt: 1, completion: 1 },
      }) + '\n',
      'utf-8',
    );

    const queue = new InMemorySyntheticObservationQueue();
    const ai = new AssessThenFinishAI();
    const backend = new RemoteEvidenceMemory();
    backend.branchShouldFail = true;
    const handle = startMemorySidecarBranch({
      sessionKey: 'remote-failure',
      input: 'find prior release notes',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      catslogMemory: backend,
      logEnabled: true,
    });

    await handle.done;

    // The pipeline still ran both inferences; the failed remote lane just
    // contributed nothing.
    assert.equal(ai.calls.length, 2);
    const logs = readBranchLogs(testRoot);
    assert.match(logs, /mechanical_retrieval/);
    assert.match(logs, /branch endpoint down/);
    const pack = ai.evidencePackIn(ai.calls[1].messages);
    assert.match(String(pack.evidence_pack.remote_branch.note), /branch endpoint down/);
    // The local lane carried the run: the cited local ref was observed and
    // published to parent context.
    const observations = queue.drain();
    assert.equal(observations.length, 1);
    const injected = JSON.parse(observations[0].formattedContent || '');
    assert.deepEqual(injected.refs, ['chat/2026-06-09/demo.jsonl#1']);
    assert.doesNotMatch(logs, /unobserved_refs_audit_only/);
    assert.match(logs, /published_observation/);
  });

  test('unavailable remote capability degrades to local-only retrieval', async () => {
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
