import { describe, test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startMemorySidecarBranch } from '../src/core/sidecar-memory-branch';
import { fixtureBranch, fixtureRead, fixtureRef } from './helpers/catslog-projection-reference-fixture';
import * as assert from 'node:assert/strict';
import { AgentTurnController } from '../src/core/agent-turn-controller';
import { InMemorySyntheticObservationQueue, SyntheticObservation } from '../src/core/synthetic-observation';
import { TurnContextBuilder } from '../src/core/turn-context-builder';
import { Message } from '../src/types';
import type { CatsLogMemoryBackend } from '../src/utils/catslog-memory-provider';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

const POOL_REF = `ref_${'a'.repeat(64)}`;
const OTHER_POOL_REF = `ref_${'b'.repeat(64)}`;
const KB_REF = 'kb:KB-11111111-2222-4333-8444-555555555555';

function citedObservation(id: string, replyRefs: { pool: string[]; knowledge: string[] }): SyntheticObservation {
  return {
    id,
    source: 'memory',
    status: 'completed',
    relevance: 'medium',
    summary: 'Previous turn found the release checklist.',
    metadata: {
      branchId: `branch-${id}`,
      branchType: 'memory',
      refs: [...replyRefs.pool, ...replyRefs.knowledge],
      citation: {
        requestId: 'br-cite-1',
        refs: replyRefs.pool,
      },
    },
    formattedContent: JSON.stringify({
      source: 'memory',
      summary: 'Previous turn found the release checklist.',
      refs: [...replyRefs.pool, ...replyRefs.knowledge],
    }),
  };
}

class ScriptedAIService {
  requests: Message[][] = [];

  constructor(private readonly responses: string[]) {}

  isToolCallingSupported(): boolean {
    return true;
  }

  async chatStream(messages: Message[]): Promise<any> {
    this.requests.push(JSON.parse(JSON.stringify(messages)));
    return {
      content: this.responses[this.requests.length - 1] || 'done',
      toolCalls: [],
      usage,
    };
  }
}

interface RecordedCitationCall {
  requestId: string;
  refs: string[];
}

function createCitationController(options: {
  responses: string[];
  catslogMemory?: CatsLogMemoryBackend;
  citationCalls: RecordedCitationCall[];
}): { controller: AgentTurnController; queues: InMemorySyntheticObservationQueue[] } {
  const controller = new AgentTurnController({
    sessionKey: 'session:v2:catscompany:group:grp_test:agent:usr1',
    sessionType: 'catscompany',
    services: {
      memoryBranch: { enabled: true, modelSource: 'inherit' },
      aiService: new ScriptedAIService(options.responses) as any,
      catslogMemory: options.catslogMemory,
      toolManager: {
        getToolDefinitions: () => [],
        executeTool: async () => {
          throw new Error('not expected');
        },
      } as any,
      skillManager: {} as any,
    },
    skillRuntime: {
      reloadSkills: async () => undefined,
      buildSkillsListMessage: () => null,
    } as any,
    planRuntime: undefined as any,
    turnContextBuilder: new TurnContextBuilder(),
    turnLogRecorder: {
      recordTurn: () => undefined,
    } as any,
    workspaceRoot: process.cwd(),
    getCurrentDirectory: () => process.cwd(),
    updateCurrentDirectory: () => undefined,
  });

  const queues: InMemorySyntheticObservationQueue[] = [];
  (controller as any).startMemorySidecarIfEnabled = () => {
    const queue = new InMemorySyntheticObservationQueue();
    queues.push(queue);
    return {
      queue,
      originTurn: queues.length,
      done: false,
      handle: {
        cancel: () => undefined,
        done: new Promise<void>(() => undefined),
      },
    };
  };
  return { controller, queues };
}

function citationBackend(calls: RecordedCitationCall[], behavior?: 'throw'): CatsLogMemoryBackend {
  return {
    reportBranchCitations: async input => {
      calls.push({ requestId: input.requestId, refs: input.refs });
      if (behavior === 'throw') throw new Error('citations endpoint not shipped (404)');
    },
  } as CatsLogMemoryBackend;
}

async function settleMicrotasks(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 20));
}

describe('AgentTurnController branch citation reporting', () => {
  test('reports the cited pool refs for the request that produced the injection', async () => {
    const citationCalls: RecordedCitationCall[] = [];
    const { controller, queues } = createCitationController({
      responses: ['turn one done', `根据 ${POOL_REF} 的决策，另见 ${KB_REF}。`],
      catslogMemory: citationBackend(citationCalls),
      citationCalls,
    });

    let messages: Message[] = [];
    const runTurn = async (input: string) => {
      const result = await controller.run({ input, messages, runtimeFeedback: [], shouldContinue: () => true });
      messages = result.messages;
      return result;
    };

    // Turn 1 produces the branch injection (queued but not yet consumed).
    await runTurn('turn one');
    queues[0].push(citedObservation('obs-1', { pool: [POOL_REF, OTHER_POOL_REF], knowledge: [KB_REF] }));

    // Turn 2 consumes the injection; its reply cites one pool ref + the KB doc.
    const result = await runTurn('turn two continues the topic');
    await settleMicrotasks();

    assert.equal(result.text.includes(POOL_REF), true);
    assert.deepEqual(citationCalls, [{
      requestId: 'br-cite-1',
      refs: [POOL_REF],
    }]);
  });

  test('citation failures degrade silently and the turn completes', async () => {
    const citationCalls: RecordedCitationCall[] = [];
    const { controller, queues } = createCitationController({
      responses: ['turn one done', `cited ${POOL_REF}`],
      catslogMemory: citationBackend(citationCalls, 'throw'),
      citationCalls,
    });

    let messages: Message[] = [];
    const runTurn = async (input: string) => {
      const result = await controller.run({ input, messages, runtimeFeedback: [], shouldContinue: () => true });
      messages = result.messages;
      return result;
    };

    await runTurn('turn one');
    queues[0].push(citedObservation('obs-1', { pool: [POOL_REF], knowledge: [] }));
    const result = await runTurn('turn two');
    await settleMicrotasks();

    assert.equal(result.text, `cited ${POOL_REF}`);
    assert.deepEqual(citationCalls, [{ requestId: 'br-cite-1', refs: [POOL_REF] }]);
  });

  test('missing citation backend leaves the turn untouched', async () => {
    const { controller, queues } = createCitationController({
      responses: ['turn one done', 'cited nothing reportable'],
    });

    let messages: Message[] = [];
    const runTurn = async (input: string) => {
      const result = await controller.run({ input, messages, runtimeFeedback: [], shouldContinue: () => true });
      messages = result.messages;
      return result;
    };

    await runTurn('turn one');
    queues[0].push(citedObservation('obs-1', { pool: [POOL_REF], knowledge: [KB_REF] }));
    const result = await runTurn('turn two');
    assert.equal(result.text, 'cited nothing reportable');
  });

  test('uncited injections produce no reports', async () => {
    const citationCalls: RecordedCitationCall[] = [];
    const { controller, queues } = createCitationController({
      responses: ['turn one done', 'the reply mentions nothing citable'],
      catslogMemory: citationBackend(citationCalls),
      citationCalls,
    });

    let messages: Message[] = [];
    const runTurn = async (input: string) => {
      const result = await controller.run({ input, messages, runtimeFeedback: [], shouldContinue: () => true });
      messages = result.messages;
      return result;
    };

    await runTurn('turn one');
    queues[0].push(citedObservation('obs-1', { pool: [POOL_REF], knowledge: [KB_REF] }));
    await runTurn('turn two');
    await settleMicrotasks();

    assert.deepEqual(citationCalls, []);
  });

  test('real sidecar two-pool evidence is consumed and both citations dispatched by controller', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citation-pools-'));
    const refs = [fixtureRef(), fixtureRef('b'.repeat(64))];
    const queue = new InMemorySyntheticObservationQueue();
    let step = 0;
    const branchAI = { isToolCallingSupported: () => true, async chat() {
      const actions = [
        ['memory_source_read', { ref: refs[0] }],
        ['memory_remote_search', { keywords: ['other'] }],
        ['memory_source_read', { ref: refs[1] }],
        ['finish_memory_search', { summary: 'Both source decisions.', evidence: refs, inject: true }],
      ] as const;
      const [name, args] = actions[step++];
      return { content: null, toolCalls: [{ id: `step-${step}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }], usage };
    } };
    const citationCalls: RecordedCitationCall[] = [];
    const backend: CatsLogMemoryBackend = {
      isAvailable: () => true,
      branch: async q => fixtureBranch(q.queryText ? refs[1] : refs[0], q.queryText ? 'pool-search' : 'pool-prefetch'),
      readSourceMemoryProjection: async ({ projectionRef }) => fixtureRead(projectionRef === refs[0] ? 'a'.repeat(64) : 'b'.repeat(64)),
      reportBranchCitations: async input => { citationCalls.push(input); },
    };
    try {
      await startMemorySidecarBranch({ sessionKey: 'citation-review', input: 'Compare both decisions', recentMessages: [], workingDirectory: root, catslogMemory: backend, aiService: branchAI as any, queue, logEnabled: false }).done;
      const observations = queue.drain();
      assert.equal(observations.length, 1);
      assert.equal(JSON.parse(observations[0].formattedContent!).retained_remote_evidence.length, 2);
      const { controller, queues } = createCitationController({ responses: ['first', refs.join(' ')], catslogMemory: backend, citationCalls });
      const first = await controller.run({ input: 'first turn', messages: [], runtimeFeedback: [], shouldContinue: () => true });
      queues[0].push(observations[0]);
      const result = await controller.run({ input: 'continue', messages: first.messages, runtimeFeedback: [], shouldContinue: () => true });
      await settleMicrotasks();
      assert.ok(refs.every(ref => result.text.includes(ref)));
      assert.deepEqual(citationCalls, [{ requestId: 'pool-prefetch', refs: [refs[0]] }, { requestId: 'pool-search', refs: [refs[1]] }]);
      fs.writeFileSync('/tmp/xiaoba-review-citation-pools-artifact.json', JSON.stringify({ schema: 'xiaoba.review.citation_pools.v1', retained_refs: refs, actual_controller_reports: citationCalls, external_provider_calls: 0 }), { mode: 0o600 });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
