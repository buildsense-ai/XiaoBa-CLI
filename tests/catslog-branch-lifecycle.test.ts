import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startMemorySidecarBranch } from '../src/core/sidecar-memory-branch';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import { CatsLogSkillEvidenceTracker } from '../src/core/catslog-skill-evidence';
import { ChatResponse, Message } from '../src/types';
import { ToolCall, ToolDefinition } from '../src/types/tool';
import type {
  CatscoSkillGraphResponse,
  CatscoSkillMemoryQuery,
  CatscoSkillMemoryResponse,
  CatscoSkillsResponse,
} from '../src/utils/catsco-log-agent-client';
import type { CatsLogMemoryBackend } from '../src/utils/catslog-memory-provider';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function call(id: string, name: string, args: unknown): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

class AuditBranchAI {
  calls = 0;

  isToolCallingSupported(): boolean {
    return true;
  }

  async chat(messages: Message[], _tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.calls++;
    const lastTool = [...messages].reverse().find(message => message.role === 'tool');
    if (!lastTool) {
      return {
        content: null,
        toolCalls: [call('body-1', 'catslog_skill_memory', {
          handle: 'review-checklist',
          include_content: true,
        })],
        usage,
      };
    }
    const result = JSON.parse(String(lastTool.content));
    return {
      content: null,
      toolCalls: [call('finish-1', 'finish_memory_search', {
        summary: '保留这条审计证据，但不要打扰当前主 agent 上下文。',
        refs: [result.items[0].ref],
        inject: false,
        delivery: 'audit',
      })],
      usage,
    };
  }
}

class BudgetExhaustingAI {
  calls = 0;

  isToolCallingSupported(): boolean {
    return true;
  }

  async chat(_messages: Message[], _tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.calls++;
    return { content: '仍在检索，但还没有完成。', toolCalls: [], usage };
  }
}

class SensitiveEchoAI {
  isToolCallingSupported(): boolean {
    return true;
  }

  async chat(): Promise<ChatResponse> {
    return { content: 'Bearer super-secret-token retrieval_receipt=receipt-secret', toolCalls: [], usage };
  }
}

class StaleRevisionAI {
  calls = 0;

  isToolCallingSupported(): boolean {
    return true;
  }

  async chat(messages: Message[], _tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.calls++;
    const lastTool = [...messages].reverse().find(message => message.role === 'tool');
    if (!lastTool) {
      return {
        content: null,
        toolCalls: [call('graph-1', 'catslog_skill_graph', { handle: 'review-checklist' })],
        usage,
      };
    }
    return {
      content: null,
      toolCalls: [call('finish-1', 'finish_memory_search', {
        summary: 'This intentionally cites a stale revision.',
        refs: ['catslog:skill:review-checklist@1'],
      })],
      usage,
    };
  }
}

class NeedsActiveHeadAI {
  calls = 0;

  isToolCallingSupported(): boolean {
    return true;
  }

  async chat(_messages: Message[], _tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.calls++;
    if (this.calls === 1) {
      return {
        content: null,
        toolCalls: [call('body-1', 'catslog_skill_memory', {
          handle: 'review-checklist',
          include_content: true,
        })],
        usage,
      };
    }
    if (this.calls === 2) {
      return {
        content: null,
        toolCalls: [call('finish-1', 'finish_memory_search', {
          summary: 'Try to finish before checking the active head.',
          refs: ['catslog:skill:review-checklist@2'],
        })],
        usage,
      };
    }
    if (this.calls === 3) {
      return {
        content: null,
        toolCalls: [call('graph-1', 'catslog_skill_graph', { handle: 'review-checklist' })],
        usage,
      };
    }
    return {
      content: null,
      toolCalls: [call('finish-2', 'finish_memory_search', {
        summary: 'Active revision verified before delivery.',
        refs: ['catslog:skill:review-checklist@2'],
      })],
      usage,
    };
  }
}

class OutcomeRequiredAI {
  calls = 0;

  isToolCallingSupported(): boolean {
    return true;
  }

  async chat(_messages: Message[], _tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.calls++;
    if (this.calls === 1) {
      return {
        content: null,
        toolCalls: [call('body-1', 'catslog_skill_memory', {
          handle: 'review-checklist',
          include_content: true,
        })],
        usage,
      };
    }
    if (this.calls === 2) {
      return {
        content: null,
        toolCalls: [call('graph-1', 'catslog_skill_graph', { handle: 'review-checklist' })],
        usage,
      };
    }
    if (this.calls === 3) {
      return {
        content: null,
        toolCalls: [call('finish-1', 'finish_memory_search', {
          summary: 'The body was read, but outcome is intentionally omitted once.',
          refs: ['catslog:skill:review-checklist@2'],
        })],
        usage,
      };
    }
    if (this.calls === 4) {
      return {
        content: null,
        toolCalls: [call('outcome-1', 'catslog_skill_outcome', {
          ref: 'catslog:skill:review-checklist@2',
          outcome: 'succeeded',
        })],
        usage,
      };
    }
    return {
      content: null,
      toolCalls: [call('finish-2', 'finish_memory_search', {
        summary: 'Outcome is now receipt-bound.',
        refs: ['catslog:skill:review-checklist@2'],
      })],
      usage,
    };
  }
}

class UnverifiedCitationAI {
  calls = 0;

  isToolCallingSupported(): boolean {
    return true;
  }

  async chat(messages: Message[], _tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.calls++;
    const lastTool = [...messages].reverse().find(message => message.role === 'tool');
    if (!lastTool) {
      return {
        content: null,
        toolCalls: [call('body-1', 'catslog_skill_memory', {
          handle: 'review-checklist',
          include_content: true,
        })],
        usage,
      };
    }
    return {
      content: null,
      toolCalls: [call('finish-1', 'finish_memory_search', {
        summary: 'This citation has no observed active head.',
        refs: ['catslog:skill:review-checklist@2'],
      })],
      usage,
    };
  }
}

class LifecycleMemory implements CatsLogMemoryBackend {
  async retrieveSkillMemory(_query: CatscoSkillMemoryQuery): Promise<CatscoSkillMemoryResponse> {
    return {
      catalog_revision: 12,
      items: [{ handle: 'review-checklist', revision: 2, content: 'untrusted skill body' }],
    };
  }

  async recallMemory(): Promise<any> {
    return { session_available: true, session: { records: [] }, notes: [] };
  }

  async readSkills(): Promise<CatscoSkillsResponse> {
    return {
      catalog_revision: 12,
      skills: [{ handle: 'review-checklist', revision: 2 }],
    };
  }

  async readSkillGraph(): Promise<CatscoSkillGraphResponse> {
    return {
      catalog_revision: 12,
      nodes: [
        { handle: 'review-checklist', revision: 2, active: true, status: 'published' },
        { handle: 'review-checklist', revision: 1, active: false, status: 'inactive' },
      ],
      edges: [{ type: 'derived_from', target_handle: 'review-checklist', target_revision: 1 }],
    };
  }
}

class OutcomeLifecycleMemory extends LifecycleMemory {
  outcomes: Array<{ handle: string; revision: number; outcome: string }> = [];

  supportsSkillOutcomes(): boolean {
    return true;
  }

  async reportSkillOutcome(input: any): Promise<void> {
    this.outcomes.push({ handle: input.handle, revision: input.revision, outcome: input.outcome });
  }
}

class NoGraphMemory implements CatsLogMemoryBackend {
  async retrieveSkillMemory(_query: CatscoSkillMemoryQuery): Promise<CatscoSkillMemoryResponse> {
    return {
      catalog_revision: 12,
      items: [{ handle: 'review-checklist', revision: 2, content: 'untrusted skill body' }],
    };
  }

  async recallMemory(): Promise<any> {
    return { session_available: true, session: { records: [] }, notes: [] };
  }
}

describe('branch CatsLog lifecycle', () => {
  let testRoot: string;
  let previousUserDataDir: string | undefined;

  beforeEach(() => {
    previousUserDataDir = process.env.XIAOBA_USER_DATA_DIR;
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-branch-lifecycle-'));
    process.env.XIAOBA_USER_DATA_DIR = testRoot;
  });

  afterEach(() => {
    if (previousUserDataDir === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('retains an audit observation without injecting it into the parent queue', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new AuditBranchAI();
    const handle = startMemorySidecarBranch({
      sessionKey: 'audit-lifecycle',
      input: '审计 review checklist',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      catslogMemory: new LifecycleMemory(),
      logEnabled: true,
    });

    await handle.done;

    assert.equal(queue.drain().length, 0);
    const logs = readBranchLogs(testRoot);
    assert.match(logs, /audited_observation/);
    assert.doesNotMatch(logs, /retrieval_receipt/);
    assert.match(logs, /catslog:skill:review-checklist@2/);
  });

  test('stops a non-finishing branch at its pass budget', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new BudgetExhaustingAI();
    const handle = startMemorySidecarBranch({
      sessionKey: 'budget-lifecycle',
      input: 'budget test',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      logEnabled: true,
      maxTurnsPerPass: 1,
      maxPasses: 2,
    });

    await handle.done;

    assert.equal(queue.drain().length, 0);
    assert.equal(ai.calls, 2);
    assert.match(readBranchLogs(testRoot), /budget_exhausted/);
  });

  test('redacts capability material from every branch log event', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const handle = startMemorySidecarBranch({
      sessionKey: 'log-redaction',
      input: 'log redaction test',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: new SensitiveEchoAI() as any,
      queue,
      logEnabled: true,
      maxPasses: 1,
    });

    await handle.done;

    const logs = readBranchLogs(testRoot);
    assert.doesNotMatch(logs, /super-secret-token/);
    assert.doesNotMatch(logs, /receipt-secret/);
    assert.match(logs, /\[redacted\]/);
  });

  test('builds bounded provenance from actual tool results and detects stale revisions', () => {
    const tracker = new CatsLogSkillEvidenceTracker();
    tracker.recordToolStart('catslog_skill_graph', 'graph-1', {});
    tracker.recordToolEnd('catslog_skill_graph', 'graph-1', JSON.stringify({
      catalog_revision: 12,
      nodes: [
        { handle: 'review-checklist', revision: 2, active: true, status: 'published' },
        { handle: 'review-checklist', revision: 1, active: false, status: 'inactive' },
      ],
      edges: [{ type: 'derived_from', target_handle: 'review-checklist', target_revision: 1 }],
    }));
    tracker.recordToolStart('catslog_skill_memory', 'memory-1', {
      handle: 'review-checklist',
      include_content: true,
      route_id: 'route-review-1',
      hop: 1,
      edge_key: 'edge-derived',
    });
    tracker.recordToolEnd('catslog_skill_memory', 'memory-1', JSON.stringify({
      catalog_revision: 12,
      items: [{ ref: 'catslog:skill:review-checklist@2', handle: 'review-checklist', revision: 2, content: 'body' }],
    }));
    tracker.recordToolStart('catslog_skill_outcome', 'outcome-1', {
      ref: 'catslog:skill:review-checklist@2',
    });
    tracker.recordToolEnd('catslog_skill_outcome', 'outcome-1', JSON.stringify({ status: 'accepted' }));

    const verified = tracker.snapshot(['catslog:skill:review-checklist@2']);
    assert.equal(verified.versionStatus, 'verified');
    assert.deepEqual(verified.activeRefs, ['catslog:skill:review-checklist@2']);
    assert.deepEqual(verified.bodyReadRefs, ['catslog:skill:review-checklist@2']);
    assert.equal(verified.receiptState, 'inferred_from_body_read');
    assert.equal(verified.outcomeStatus, 'accepted');
    assert.deepEqual(verified.routes, [{
      routeId: 'route-review-1',
      hop: 1,
      edgeKey: 'edge-derived',
    }]);
    assert.equal(JSON.stringify(verified).includes('retrieval_receipt'), false);

    tracker.recordToolStart('catslog_skill_outcome', 'outcome-2', {
      ref: 'catslog:skill:review-checklist@2',
    });
    tracker.recordToolEnd('catslog_skill_outcome', 'outcome-2', JSON.stringify({ error: 'receipt expired' }));
    tracker.recordToolStart('catslog_skill_outcome', 'outcome-3', {
      ref: 'catslog:skill:review-checklist@2',
    });
    tracker.recordToolEnd('catslog_skill_outcome', 'outcome-3', JSON.stringify({ status: 'accepted' }));
    const retried = tracker.snapshot(['catslog:skill:review-checklist@2']);
    assert.equal(retried.outcomeStatus, 'accepted');
    assert.equal(retried.outcomeAttempts, 3);
    assert.equal(retried.outcomeRejected, 1);

    const stale = tracker.snapshot(['catslog:skill:review-checklist@1']);
    assert.equal(stale.versionStatus, 'mismatch');

    const unrelatedOutcome = new CatsLogSkillEvidenceTracker();
    unrelatedOutcome.recordToolStart('catslog_skill_memory', 'memory-a', {
      handle: 'review-checklist',
      include_content: true,
    });
    unrelatedOutcome.recordToolEnd('catslog_skill_memory', 'memory-a', JSON.stringify({
      items: [{ handle: 'review-checklist', revision: 2, content: 'body' }],
    }));
    unrelatedOutcome.recordToolStart('catslog_skill_outcome', 'outcome-other', {
      ref: 'catslog:skill:other-playbook@1',
    });
    unrelatedOutcome.recordToolEnd('catslog_skill_outcome', 'outcome-other', JSON.stringify({ status: 'accepted' }));
    assert.equal(
      unrelatedOutcome.snapshot(['catslog:skill:review-checklist@2']).outcomeStatus,
      'not_attempted',
    );
    assert.equal(
      unrelatedOutcome.snapshot(['catslog:skill:other-playbook@1']).receiptState,
      'not_observed',
    );

    const multiRef = new CatsLogSkillEvidenceTracker();
    multiRef.recordToolStart('catslog_skill_graph', 'graph-multi', {});
    multiRef.recordToolEnd('catslog_skill_graph', 'graph-multi', JSON.stringify({
      nodes: [{ handle: 'review-checklist', revision: 2, active: true, status: 'published' }],
    }));
    assert.equal(
      multiRef.snapshot([
        'catslog:skill:review-checklist@2',
        'catslog:skill:other-playbook@1',
      ]).versionStatus,
      'unknown',
    );

    const catalogOnly = new CatsLogSkillEvidenceTracker();
    catalogOnly.recordToolStart('catslog_skill_catalog', 'catalog-1', {});
    catalogOnly.recordToolEnd('catslog_skill_catalog', 'catalog-1', JSON.stringify({
      catalog_revision: 12,
      skills: [{ handle: 'review-checklist', revision: 2, active: true, status: 'published' }],
    }));
    assert.equal(
      catalogOnly.snapshot(['catslog:skill:review-checklist@2']).versionStatus,
      'unknown',
      'catalog metadata must not substitute for an active graph head',
    );
  });

  test('fails closed to audit when a branch cites an observed stale Skill head', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new StaleRevisionAI();
    const handle = startMemorySidecarBranch({
      sessionKey: 'stale-head-lifecycle',
      input: 'check the review checklist',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      catslogMemory: new LifecycleMemory(),
      logEnabled: true,
    });

    await handle.done;

    assert.equal(queue.drain().length, 0);
    const logs = readBranchLogs(testRoot);
    assert.match(logs, /stale_revision_audit_only/);
    assert.match(logs, /audited_observation/);
  });

  test('fails closed to audit when the adapter cannot verify an active Skill head', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const handle = startMemorySidecarBranch({
      sessionKey: 'unverified-head-lifecycle',
      input: 'check the review checklist',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: new UnverifiedCitationAI() as any,
      queue,
      catslogMemory: new NoGraphMemory(),
      logEnabled: true,
      maxPasses: 2,
    });

    await handle.done;

    assert.equal(queue.drain().length, 0);
    const logs = readBranchLogs(testRoot);
    assert.match(logs, /active_head_unverified/);
    assert.match(logs, /budget_exhausted/);
    assert.match(logs, /budget_exhausted_deferred_evidence/);
    assert.match(logs, /audited_observation/);
  });

  test('defers context delivery until the active Skill head is observed', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new NeedsActiveHeadAI();
    const handle = startMemorySidecarBranch({
      sessionKey: 'active-head-lifecycle',
      input: 'check the review checklist',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      catslogMemory: new LifecycleMemory(),
      logEnabled: true,
    });

    await handle.done;

    const observations = queue.drain();
    assert.equal(observations.length, 1);
    const injected = JSON.parse(observations[0].formattedContent || '');
    assert.equal(injected.lifecycle.active_head, 'verified');
    assert.match(readBranchLogs(testRoot), /finish_deferred/);
    assert.equal(ai.calls, 4);
  });

  test('requires a receipt-bound outcome before publishing Skill context', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const ai = new OutcomeRequiredAI();
    const backend = new OutcomeLifecycleMemory();
    const handle = startMemorySidecarBranch({
      sessionKey: 'outcome-required-lifecycle',
      input: 'check the review checklist',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: ai as any,
      queue,
      catslogMemory: backend,
      logEnabled: true,
    });

    await handle.done;

    const observations = queue.drain();
    assert.equal(observations.length, 1);
    const injected = JSON.parse(observations[0].formattedContent || '');
    assert.equal(injected.lifecycle.outcome, 'accepted');
    assert.deepEqual(backend.outcomes, [{
      handle: 'review-checklist',
      revision: 2,
      outcome: 'succeeded',
    }]);
    assert.match(readBranchLogs(testRoot), /skill_outcome_required/);
    assert.equal(ai.calls, 5);
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
