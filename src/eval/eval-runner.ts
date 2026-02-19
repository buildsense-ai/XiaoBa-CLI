import * as path from 'path';
import { EvalSpec, TurnLog, ToolCallLog, EvalResult } from './eval-types';
import { AIService } from '../utils/ai-service';
import { ToolManager } from '../tools/tool-manager';
import { SkillManager } from '../skills/skill-manager';
import { AgentSession } from '../core/agent-session';
import { SendMessageTool } from '../tools/send-message-tool';
import { runAssertions } from './eval-assertions';
import { runJudge } from './eval-judge';

export class EvalRunner {
  private projectRoot: string;

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot || path.resolve(__dirname, '../..');
  }

  async run(spec: EvalSpec, specName: string): Promise<EvalResult> {
    const testerAI = new AIService();
    const testerMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: spec.tester.system_prompt },
    ];

    // Init target agent
    const toolManager = new ToolManager(this.projectRoot);
    const skillManager = new SkillManager();
    await skillManager.loadSkills();

    const session = new AgentSession(spec.target.session_key, {
      aiService: new AIService(),
      toolManager,
      skillManager,
    });

    // Activate skill if specified
    if (spec.target.skill) {
      const ok = await session.activateSkill(spec.target.skill);
      if (!ok) console.log(`[warn] skill "${spec.target.skill}" activation failed, continuing`);
    }

    // Bind send_message capture
    const sendMessageTool = toolManager.getTool<SendMessageTool>('send_message');
    let capturedMessages: string[] = [];
    sendMessageTool?.bindSession(spec.target.session_key, 'eval-chat', async (_chatId, text) => {
      capturedMessages.push(text);
    });

    // Conversation loop
    const turns: TurnLog[] = [];
    const maxTurns = spec.target.max_turns || 15;

    for (let turn = 1; turn <= maxTurns; turn++) {
      let testerMessage: string;

      if (turn === 1) {
        testerMessage = spec.tester.first_message;
      } else {
        const lastLog = turns[turns.length - 1];
        const targetReply = lastLog.targetVisibleReply.length > 0
          ? lastLog.targetVisibleReply.join('\n')
          : lastLog.targetFinalAnswer;

        testerMessages.push({ role: 'user', content: `Target 回复：${targetReply}` });
        const resp = await testerAI.chat(testerMessages as any);
        testerMessage = resp.content || '继续';
        testerMessages.push({ role: 'assistant', content: testerMessage });

        if (testerMessage.includes(spec.tester.done_signal)) {
          console.log(`\n[Turn ${turn}] Tester: ${testerMessage}`);
          console.log('\n--- Tester ended conversation ---\n');
          break;
        }
      }

      console.log(`\n[Turn ${turn}] Tester: ${testerMessage}`);

      // Target processes message
      capturedMessages = [];
      const toolCalls: ToolCallLog[] = [];
      const seenToolCallIds = new Set<string>();

      const finalAnswer = await session.handleMessage(testerMessage, {
        onToolStart: (name) => console.log(`  [tool] ${name} ...`),
        onToolEnd: (name) => {
          const msgs = session.getMessages();
          for (let i = msgs.length - 1; i >= 0; i--) {
            const msg = msgs[i];
            if (msg.role !== 'assistant' || !msg.tool_calls) continue;
            for (const tc of msg.tool_calls) {
              if (tc.function.name === name && !seenToolCallIds.has(tc.id)) {
                seenToolCallIds.add(tc.id);
                try {
                  toolCalls.push({ name, arguments: JSON.parse(tc.function.arguments) });
                } catch {
                  toolCalls.push({ name, arguments: { raw: tc.function.arguments } });
                }
                return;
              }
            }
          }
        },
      });

      turns.push({
        turn,
        testerMessage,
        targetToolCalls: toolCalls,
        targetVisibleReply: [...capturedMessages],
        targetFinalAnswer: finalAnswer,
      });

      if (capturedMessages.length > 0) {
        console.log(`  [visible]: ${capturedMessages.join('\n  ')}`);
      }
      console.log(`  [final]: ${finalAnswer.slice(0, 200)}${finalAnswer.length > 200 ? '...' : ''}`);
    }

    // Cleanup
    sendMessageTool?.unbindSession(spec.target.session_key);

    // Run assertions
    const assertions = runAssertions(turns, spec.assertions || []);

    // Run judge
    let judgeScores = null;
    let weightedScore = null;
    if (spec.judge?.dimensions?.length) {
      const judgeResult = await runJudge(turns, spec.judge.dimensions, testerAI);
      judgeScores = judgeResult.scores;
      weightedScore = judgeResult.weightedScore;
    }

    return {
      timestamp: new Date().toISOString(),
      specName,
      turns,
      assertions,
      judgeScores,
      weightedScore,
    };
  }
}
