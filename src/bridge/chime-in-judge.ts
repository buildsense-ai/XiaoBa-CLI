import { AIService } from '../utils/ai-service';
import { Logger } from '../utils/logger';

const MAX_CONTEXT_MESSAGES = 10;
const JUDGE_MAX_TOKENS = 20;

const JUDGE_SYSTEM_PROMPT = `你是一个群聊参与判断器。你的任务是判断 bot 是否应该主动回应当前消息。
只回答 yes 或 no，不要解释。`;

function buildJudgeUserPrompt(
  botName: string,
  botExpertise: string,
  recentMessages: string[],
  latestMessage: string,
  teammates?: { name: string; expertise: string }[],
): string {
  const context = recentMessages.length > 0
    ? `最近的群聊记录:\n${recentMessages.join('\n')}\n\n`
    : '';
  const teammateInfo = teammates && teammates.length > 0
    ? `\n群里还有其他同事：${teammates.map(t => `${t.name}擅长${t.expertise}`).join('；')}。如果这事他们更合适回答，你就不要插嘴。`
    : '';
  return `${context}最新消息: <user_message>${latestMessage}</user_message>

你是 ${botName}，擅长${botExpertise}。${teammateInfo}
这条最新消息没有直接@你，但你觉得你应该主动回应吗？只回答 yes 或 no。`;
}

export interface ChimeInConfig {
  botName: string;
  botExpertise: string;
  teammates?: { name: string; expertise: string }[];
}

/**
 * 轻量级"该不该插嘴"判断器
 * 收到广播消息时，用一次低成本 LLM 调用判断是否需要触发完整推理
 */
export class ChimeInJudge {
  private judgeAI: AIService;
  private config: ChimeInConfig;
  /** 最近的广播消息记录，用于提供上下文 */
  private recentMessages: string[] = [];
  /** 最后一条广播消息的时间戳，用于延迟后判断是否有新消息 */
  private lastMessageTs = 0;

  constructor(config: ChimeInConfig) {
    this.judgeAI = new AIService({ maxTokens: JUDGE_MAX_TOKENS });
    this.config = config;
  }

  /** 记录一条广播消息到上下文 */
  recordMessage(text: string): void {
    this.recentMessages.push(text);
    if (this.recentMessages.length > MAX_CONTEXT_MESSAGES) {
      this.recentMessages = this.recentMessages.slice(-MAX_CONTEXT_MESSAGES);
    }
    this.lastMessageTs = Date.now();
  }

  /** 获取最近的广播消息记录（供插嘴 hint 拼接上下文） */
  getRecentMessages(): string[] {
    return this.recentMessages.slice(-5);
  }

  /** 延迟期间是否有新广播消息进来（说明别的 bot 已经回复了） */
  hasNewMessageSince(ts: number): boolean {
    return this.lastMessageTs > ts;
  }

  /** 判断是否应该主动回应 */
  async shouldChimeIn(latestMessage: string): Promise<boolean> {
    try {
      const response = await this.judgeAI.chat([
        { role: 'system', content: JUDGE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: buildJudgeUserPrompt(
            this.config.botName,
            this.config.botExpertise,
            this.recentMessages.slice(-MAX_CONTEXT_MESSAGES),
            latestMessage,
            this.config.teammates,
          ),
        },
      ]);

      const answer = (response.content || '').trim().toLowerCase();
      const shouldRespond = answer.startsWith('yes');
      Logger.info(`[ChimeIn] "${latestMessage.slice(0, 50)}..." → ${shouldRespond ? 'yes' : 'no'}`);
      return shouldRespond;
    } catch (err: any) {
      Logger.error(`[ChimeIn] 判断失败: ${err.message}`);
      return false;
    }
  }
}
