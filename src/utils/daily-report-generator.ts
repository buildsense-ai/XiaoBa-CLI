import * as fs from 'fs';
import * as path from 'path';
import { AIService } from './ai-service';

const SESSION_LOG_DIR = path.resolve('logs/sessions');
const REPORT_DIR = path.resolve('logs/reports');

interface TurnLog {
  turn: number;
  timestamp: string;
  session_id: string;
  session_type: string;
  user: { text: string; images?: string[] };
  assistant: { text: string; tool_calls: any[] };
  tokens: { prompt: number; completion: number };
}

interface SessionSummary {
  session_id: string;
  session_type: string;
  turn_count: number;
  start_time: string;
  end_time: string;
  topics: string[];
  tool_calls: string[];
  total_tokens: number;
}

/**
 * DailyReportGenerator - 生成每日工作报告
 */
export class DailyReportGenerator {
  constructor(private aiService: AIService) {}

  /**
   * 生成指定日期的日报
   */
  async generateReport(date: string): Promise<string> {
    const sessions = this.scanLogs(date);

    if (sessions.length === 0) {
      return `# XiaoBa 工作日报 - ${date}\n\n今天没有记录到任何会话。`;
    }

    const grouped = this.groupByType(sessions);
    const summary = await this.generateSummary(date, grouped);

    this.saveReport(date, summary);
    return summary;
  }

  /**
   * 扫描指定日期的所有 session logs
   */
  private scanLogs(date: string): SessionSummary[] {
    const sessions: SessionSummary[] = [];

    for (const sessionType of ['chat', 'catscompany', 'feishu']) {
      const dir = path.join(SESSION_LOG_DIR, sessionType, date);

      if (!fs.existsSync(dir)) continue;

      const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));

      for (const file of files) {
        const filePath = path.join(dir, file);
        const summary = this.parseSessionLog(filePath, sessionType);
        if (summary) sessions.push(summary);
      }
    }

    return sessions;
  }

  /**
   * 解析单个 session log 文件
   */
  private parseSessionLog(filePath: string, sessionType: string): SessionSummary | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.trim());

      if (lines.length === 0) return null;

      const turns: TurnLog[] = lines.map(line => JSON.parse(line));
      const toolCalls = new Set<string>();
      let totalTokens = 0;

      for (const turn of turns) {
        totalTokens += turn.tokens.prompt + turn.tokens.completion;
        turn.assistant.tool_calls.forEach(tc => toolCalls.add(tc.name));
      }

      return {
        session_id: turns[0].session_id,
        session_type: sessionType,
        turn_count: turns.length,
        start_time: turns[0].timestamp,
        end_time: turns[turns.length - 1].timestamp,
        topics: this.extractTopics(turns),
        tool_calls: Array.from(toolCalls),
        total_tokens: totalTokens,
      };
    } catch (error) {
      console.error(`Failed to parse ${filePath}:`, error);
      return null;
    }
  }

  /**
   * 提取会话主题（从用户输入中）
   */
  private extractTopics(turns: TurnLog[]): string[] {
    return turns.slice(0, 3).map(t => t.user.text.slice(0, 50));
  }

  /**
   * 按 session_type 分组
   */
  private groupByType(sessions: SessionSummary[]): Record<string, SessionSummary[]> {
    const grouped: Record<string, SessionSummary[]> = {
      chat: [],
      catscompany: [],
      feishu: [],
    };

    for (const session of sessions) {
      grouped[session.session_type].push(session);
    }

    return grouped;
  }

  /**
   * 调用 LLM 生成人性化总结
   */
  private async generateSummary(
    date: string,
    grouped: Record<string, SessionSummary[]>
  ): Promise<string> {
    const stats = {
      total_sessions: Object.values(grouped).flat().length,
      total_turns: Object.values(grouped).flat().reduce((sum, s) => sum + s.turn_count, 0),
      total_tokens: Object.values(grouped).flat().reduce((sum, s) => sum + s.total_tokens, 0),
      chat_sessions: grouped.chat.length,
      team_sessions: grouped.catscompany.length + grouped.feishu.length,
    };

    const prompt = this.buildPrompt(date, grouped, stats);

    try {
      const response = await this.aiService.chat([
        { role: 'system', content: '你是一个工作日报生成助手。根据会话记录生成简洁、人性化的日报。' },
        { role: 'user', content: prompt },
      ]);

      return response.content || '生成失败';
    } catch (error) {
      console.error('LLM 生成失败，使用模板:', error);
      return this.fallbackTemplate(date, grouped, stats);
    }
  }

  /**
   * 构建 LLM prompt
   */
  private buildPrompt(
    date: string,
    grouped: Record<string, SessionSummary[]>,
    stats: any
  ): string {
    let prompt = `请根据以下会话记录生成 ${date} 的工作日报：\n\n`;
    prompt += `## 统计\n`;
    prompt += `- 总会话数：${stats.total_sessions}（个人 ${stats.chat_sessions}，团队 ${stats.team_sessions}）\n`;
    prompt += `- 总交互轮次：${stats.total_turns}\n`;
    prompt += `- 总 tokens：${stats.total_tokens}\n\n`;

    if (grouped.chat.length > 0) {
      prompt += `## 个人工作（Chat）\n`;
      for (const session of grouped.chat) {
        prompt += `- 会话 ${session.session_id.slice(0, 8)}（${session.turn_count} 轮）\n`;
        prompt += `  主题：${session.topics.join(', ')}\n`;
        prompt += `  工具：${session.tool_calls.join(', ') || '无'}\n`;
      }
      prompt += '\n';
    }

    if (grouped.catscompany.length > 0) {
      prompt += `## 团队工作（CatsCompany）\n`;
      for (const session of grouped.catscompany) {
        prompt += `- 会话 ${session.session_id.slice(0, 8)}（${session.turn_count} 轮）\n`;
        prompt += `  主题：${session.topics.join(', ')}\n`;
      }
      prompt += '\n';
    }

    prompt += `\n请生成一份简洁、人性化的日报（markdown 格式），包含：\n`;
    prompt += `1. 统计概览\n`;
    prompt += `2. 个人工作总结（如果有）\n`;
    prompt += `3. 团队工作总结（如果有）\n`;
    prompt += `4. 主要使用的工具\n`;

    return prompt;
  }

  /**
   * 降级模板（LLM 不可用时）
   */
  private fallbackTemplate(
    date: string,
    grouped: Record<string, SessionSummary[]>,
    stats: any
  ): string {
    let report = `# XiaoBa 工作日报 - ${date}\n\n`;
    report += `## 📊 统计概览\n`;
    report += `- 总会话数：${stats.total_sessions}（个人 ${stats.chat_sessions}，团队 ${stats.team_sessions}）\n`;
    report += `- 总交互轮次：${stats.total_turns}\n`;
    report += `- 总 tokens：${stats.total_tokens}\n\n`;

    if (grouped.chat.length > 0) {
      report += `## 💼 个人工作（Chat）\n`;
      for (const session of grouped.chat) {
        report += `### 会话 ${session.session_id.slice(0, 8)}\n`;
        report += `- 轮次：${session.turn_count}\n`;
        report += `- 主题：${session.topics.join(', ')}\n`;
        report += `- 工具：${session.tool_calls.join(', ') || '无'}\n\n`;
      }
    }

    if (grouped.catscompany.length > 0 || grouped.feishu.length > 0) {
      report += `## 👥 团队工作\n`;
      [...grouped.catscompany, ...grouped.feishu].forEach(session => {
        report += `### 会话 ${session.session_id.slice(0, 8)}\n`;
        report += `- 轮次：${session.turn_count}\n`;
        report += `- 主题：${session.topics.join(', ')}\n\n`;
      });
    }

    return report;
  }

  /**
   * 保存报告到文件
   */
  private saveReport(date: string, content: string): void {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const filePath = path.join(REPORT_DIR, `${date}.md`);
    fs.writeFileSync(filePath, content);
    console.log(`日报已保存到: ${filePath}`);
  }
}
