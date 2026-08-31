import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentSession, type AgentServices } from '../src/core/agent-session';
import { createCatsCoMessageEnvelope } from '../src/catscompany/message-envelope';
import { buildTargetRoutes } from '../src/catscompany/runtime-context';
import { createSessionRoute } from '../src/core/session-router';
import { ToolManager } from '../src/tools/tool-manager';
import type { MessageEnvelope, SessionRoute } from '../src/types/session-identity';
import type { Message } from '../src/types';

const ARTIFACT_REF = `acr_${'a'.repeat(43)}`;
const ARTIFACT_REF_PATTERN = /acr_[A-Za-z0-9_-]{43}/;
const ARTIFACT_TASK_REF = `atr_${'t'.repeat(43)}`;
const ARTIFACT_TASK_REF_PATTERN = /atr_[A-Za-z0-9_-]{43}/;

describe('Artifact refs AgentSession integration', { concurrency: false }, () => {
  test('scopes canonical context and task refs to the current local turn only', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-artifact-ref-session-'));
    const originalCwd = process.cwd();
    process.chdir(workspace);

    const firstEnvelope = envelopeForTurn(1, ARTIFACT_REF, ARTIFACT_TASK_REF);
    const firstRoute = routeForEnvelope(firstEnvelope);
    const providerRequests: Message[][] = [];
    const toolResults: string[] = [];
    const remoteRequests: unknown[] = [];
    let modelCall = 0;

    const localProbe = [
      'node -e "',
      "const c=process.env.CATSCO_ARTIFACT_CONTEXT_REF||'';",
      "const t=process.env.CATSCO_ARTIFACT_TASK_REF||'';",
      "process.stdout.write(c==='acr_'+'a'.repeat(43)&&t==='atr_'+'t'.repeat(43)?'active':c||t?'stale':'missing')",
      '"',
    ].join('');
    const missingProbe = [
      'node -e "',
      "const c=process.env.CATSCO_ARTIFACT_CONTEXT_REF||'';",
      "const t=process.env.CATSCO_ARTIFACT_TASK_REF||'';",
      "process.stdout.write(c||t?'unexpected':'missing')",
      '"',
    ].join('');

    const aiService = {
      getConfig: () => ({ provider: 'openai', model: 'integration-test', contextWindowTokens: 64_000 }),
      isToolCallingSupported: () => true,
      async chatStream(messages: Message[]) {
        providerRequests.push(messages.map(message => ({ ...message })));
        modelCall += 1;
        if (modelCall === 1) return toolResponse('local-current', localProbe);
        if (modelCall === 2) return finalResponse('local current done');
        if (modelCall === 3) return toolResponse('local-next', missingProbe);
        if (modelCall === 4) return finalResponse('local next done');
        return finalResponse('remote done');
      },
    };
    const toolManager = new ToolManager(workspace, {}, { enabledToolNames: ['execute_shell', 'read_file'] });
    const services: AgentServices = {
      aiService: aiService as any,
      toolManager,
      skillManager: skillManagerStub() as any,
    };
    const session = new AgentSession('artifact-context-cli', services, 'cli', firstRoute);
    session.setSystemPromptProvider(() => 'integration system prompt');

    try {
      await session.handleMessage(firstEnvelope.rawText, turnOptions(firstEnvelope, {
        callbacks: {
          onToolEnd: (_name, _toolUseId, result) => toolResults.push(result),
        },
      }));

      const secondEnvelope = envelopeForTurn(2);
      await session.handleMessage(secondEnvelope.rawText, turnOptions(secondEnvelope, {
        callbacks: {
          onToolEnd: (_name, _toolUseId, result) => toolResults.push(result),
        },
      }));

      const remoteResult = await toolManager.executeTool({
        id: 'remote-current',
        type: 'function',
        function: {
          name: 'read_file',
          arguments: JSON.stringify({ file_path: 'README.md', target: 'Alice' }),
        },
      }, [], {
        workingDirectory: workspace,
        conversationHistory: [],
        surface: 'catscompany',
        artifactContextRef: ARTIFACT_REF,
        artifactTaskRef: ARTIFACT_TASK_REF,
        targetRoutes: buildTargetRoutes([{
          userId: 'usr8',
          userName: 'Alice',
          ownerUserId: 'usr8',
          deviceId: 'alice-device',
          label: 'Alice device',
          os: 'windows',
          status: 'ready',
        }]),
        thinToolRpc: {
          executeTool: async request => {
            remoteRequests.push(request);
            assert.doesNotMatch(JSON.stringify(request), ARTIFACT_REF_PATTERN);
            assert.doesNotMatch(JSON.stringify(request), ARTIFACT_TASK_REF_PATTERN);
            assert.equal('artifactContextRef' in request.args, false);
            assert.equal('artifactTaskRef' in request.args, false);
            assert.equal('CATSCO_ARTIFACT_CONTEXT_REF' in request.args, false);
            assert.equal('CATSCO_ARTIFACT_TASK_REF' in request.args, false);
            return { ok: true, content: 'remote missing' };
          },
        },
      });

      assert.match(toolResults[0], /active/);
      assert.match(toolResults[1], /missing/);
      assert.equal(remoteResult.ok, true, JSON.stringify(remoteResult));
      assert.match(String(remoteResult.content), /remote missing/);
      assert.equal(remoteRequests.length, 1);
      assert.equal(providerRequests.length, 4);
      for (const request of providerRequests) {
        assert.doesNotMatch(JSON.stringify(request), ARTIFACT_REF_PATTERN);
        assert.doesNotMatch(JSON.stringify(request), ARTIFACT_TASK_REF_PATTERN);
      }
      assert.doesNotMatch(JSON.stringify((session as any).messages), ARTIFACT_REF_PATTERN);
      assert.doesNotMatch(JSON.stringify((session as any).messages), ARTIFACT_TASK_REF_PATTERN);
    } finally {
      await session.cleanup();
      process.chdir(originalCwd);
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

function envelopeForTurn(
  seq: number,
  artifactContextRef?: string,
  artifactTaskRef?: string,
): MessageEnvelope {
  return createCatsCoMessageEnvelope({
    topic: 'p2p_701_743',
    senderId: 'usr701',
    seq,
    text: `turn ${seq}`,
    botUid: 'usr743',
    metadata: {
      ...(artifactContextRef ? { artifact_context_ref: artifactContextRef } : {}),
      ...(artifactTaskRef ? { artifact_task_ref: artifactTaskRef } : {}),
      catsco_identity: {
        actor: { user_id: 'usr701' },
        agent: { agent_id: 'usr743', body_id: 'body-main' },
        topic: { topic_id: 'p2p_701_743', type: 'p2p', channel_seq: seq },
        permissions: { source: 'server_canonical_message' },
      },
    },
  });
}

function routeForEnvelope(envelope: MessageEnvelope): SessionRoute {
  return createSessionRoute({
    source: envelope.source,
    topicId: envelope.topicId,
    topicType: envelope.topicType,
    actorUserId: envelope.actorUserId,
    agentId: envelope.agentId,
    agentBodyId: envelope.agentBodyId,
    messageId: envelope.messageId,
    channelSeq: envelope.channelSeq,
    identityTrust: envelope.identityTrust,
    identitySource: envelope.identitySource,
    legacySessionKey: envelope.legacySessionKey,
    legacyRestoreKey: envelope.legacyRestoreKey,
    legacyCleanupKey: envelope.legacyCleanupKey,
  });
}

function turnOptions(envelope: MessageEnvelope, overrides: Record<string, unknown> = {}): any {
  const route = routeForEnvelope(envelope);
  return {
    sessionRoute: route,
    artifactContextRef: envelope.artifactContextRef,
    artifactTaskRef: envelope.artifactTaskRef,
    localDeviceGrant: {
      kind: 'catscompany_body',
      source: 'catscompany',
      bodyId: envelope.agentBodyId,
      capabilities: ['execute_shell'],
      createdAt: Date.now(),
    },
    ...overrides,
  };
}

function toolResponse(id: string, command: string, target?: string): any {
  return {
    content: null,
    toolCalls: [{
      id,
      type: 'function',
      function: {
        name: 'execute_shell',
        arguments: JSON.stringify({ command, ...(target ? { target } : {}) }),
      },
    }],
    usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
  };
}

function finalResponse(content: string): any {
  return {
    content,
    toolCalls: [],
    usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
  };
}

function skillManagerStub(): object {
  return {
    getSkill() { return undefined; },
    getUserInvocableSkills() { return []; },
    getAutoInvocableSkills() { return []; },
    findAutoInvocableSkillByText() { return undefined; },
    loadSkills: async () => {},
  };
}
