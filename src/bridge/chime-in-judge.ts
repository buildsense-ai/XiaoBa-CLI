import { AIService } from '../utils/ai-service';
import { Logger } from '../utils/logger';

const MAX_CONTEXT_MESSAGES = 10;
const JUDGE_MAX_TOKENS = 20;

const JUDGE_SYSTEM_PROMPT = `你是一个群聊参与判断器。你的任务是判断 bot 是否应该主动回应当前消息。
只回答 yes 或 no，不要解释。`;

function buildJudgeUserPrompt(botName: string, botExpertise: string, recentMessages: string[], latestMessage: string): string {
  const context = recentMessages.length > 0
    ? `最近的群聊记录:\n${recentMessages.join('\n')}\n\n`
    : '';
  return `${context}最新消息: ${latestMessage}

你是 ${botName}，擅长${botExpertise}。
这条最新消息没有直接@你，但你觉得你应该主动回应吗？只回答 yes 或 no。`;
}

export interface ChimeInConfig {
  botName: string;
  botExpertise: string;
}

/**
 * 轻量级"该不该插嘴"判断器
 * 收到广播消息时，用一次低成本 LLM 调用判断是否需要触发完整推理
 */
export class ChimeInJudge {
  private aiService: AIService;
  private config: ChimeInConfig;
  /** 最近的广播消息记录，用于提供上下文 */
  private recentMessages: string[] = [];

  constructor(aiService: AIService, config: ChimeInConfig) {
    this.aiService = aiService;
    this.config = config;
  }

  /** 记录一条广播消息到上下文 */
  recordMessage(text: string): void {
    this.recentMessages.push(text);
    if (this.recentMessages.length > MAX_CONTEXT_MESSAGES) {
      this.recentMessages = this.recentMessages.slice(-MAX_CONTEXT_MESSAGES);
    }
  }

  /** 判断是否应该主动回应 */
  async shouldChimeIn(latestMessage: string): Promise<boolean> {
    try {
      const response = await this.aiService.chat([
        { role: 'system', content: JUDGE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: buildJudgeUserPrompt(
            this.config.botName,
            this.config.botExpertise,
            this.recentMessages.slice(-MAX_CONTEXT_MESSAGES),
            latestMessage,
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
