import { Message } from '../types';
import { estimateMessagesTokens } from './token-estimator';
import { Logger } from '../utils/logger';

/**
 * 压缩后的消息组
 * 记录被压缩的消息范围和生成的摘要
 */
interface CompactionUnit {
  /** 这组消息的语义标签（如 "第1章精读"、"维度1评估"） */
  label: string;
  /** 原始消息数量 */
  originalCount: number;
  /** 原始 token 估算 */
  originalTokens: number;
  /** 压缩后的摘要文本 */
  summary: string;
}

/**
 * ContextCompressor - 上下文压缩器
 *
 * 核心设计：零 API 调用的确定性压缩
 *
 * XiaoBa 的学术 skill 有天然的"压缩单元"：
 * - paper-analysis: 每章精读完会写 analysis.md（含章节小结）
 * - critical-reading: 每个维度评估完会写报告（含维度小结）
 * - sci-paper-writing: 每章写完会更新 blueprint.md
 *
 * 这些摘要已经存在于磁盘上，不需要 AI 重新生成。
 * 压缩操作 = 砍掉旧工具调用链 + 插入已有摘要 = 纯字符串操作 ≈ 0ms
 */
export class ContextCompressor {
  /** 上下文窗口大小（tokens） */
  private maxContextTokens: number;
  /** 触发压缩的阈值比例 */
  private compactionThreshold: number;
  /** 压缩历史（用于调试和日志） */
  private compactionHistory: CompactionUnit[] = [];

  constructor(options?: {
    maxContextTokens?: number;
    compactionThreshold?: number;
  }) {
    this.maxContextTokens = options?.maxContextTokens ?? 128000;
    // 70%触发，比 Claude Code 的 95% 保守
    // 留 30% 给当前活跃的工具调用链
    this.compactionThreshold = options?.compactionThreshold ?? 0.7;
  }

  /**
   * 检查是否需要压缩
   */
  needsCompaction(messages: Message[]): boolean {
    const used = estimateMessagesTokens(messages);
    const threshold = this.maxContextTokens * this.compactionThreshold;
    return used > threshold;
  }

  /**
   * 获取当前 token 使用情况（用于日志/调试）
   */
  getUsageInfo(messages: Message[]): {
    usedTokens: number;
    maxTokens: number;
    usagePercent: number;
    compactionCount: number;
  } {
    const used = estimateMessagesTokens(messages);
    return {
      usedTokens: used,
      maxTokens: this.maxContextTokens,
      usagePercent: Math.round((used / this.maxContextTokens) * 100),
      compactionCount: this.compactionHistory.length,
    };
  }

  /**
   * 执行压缩 — 核心方法（零 API 调用）
   *
   * 策略：
   * 1. 找到所有"已完成的工具调用链"（通过 write_file 写入 progress/analysis 标记边界）
   * 2. 把已完成的链替换为确定性摘要（从工具调用中提取关键信息）
   * 3. 保留 system prompt + 用户原始请求 + 最近的活跃链
   *
   * @returns 压缩后的新消息数组
   */
  compact(messages: Message[]): Message[] {
    const before = estimateMessagesTokens(messages);

    // 检测模式：有 skill 边界标记 → 语义压缩，否则 → 通用压缩
    const hasSkillBoundaries = messages.some(m => this.isUnitBoundary(m));

    if (hasSkillBoundaries) {
      return this.compactSkillMode(messages, before);
    } else {
      return this.compactGenericMode(messages, before);
    }
  }

  /**
   * Skill 模式压缩：按语义单元（章节/维度）压缩
   * 适用于 paper-analysis、critical-reading、sci-paper-writing 等长任务
   */
  private compactSkillMode(messages: Message[], beforeTokens: number): Message[] {
    const { preserved, compressible, recent } = this.partition(messages);

    if (compressible.length === 0) {
      Logger.info('上下文压缩（Skill模式）：没有可压缩的内容');
      return messages;
    }

    const units = this.splitIntoUnits(compressible);
    const summaryMessage = this.buildSummaryMessage(units);

    const result = [...preserved, summaryMessage, ...recent];

    const after = estimateMessagesTokens(result);
    Logger.info(
      `上下文压缩（Skill模式）：${messages.length} 条 → ${result.length} 条，` +
      `${beforeTokens} tokens → ${after} tokens（节省 ${Math.round((1 - after / beforeTokens) * 100)}%）`
    );

    return result;
  }

  /**
   * 通用模式压缩：砍掉旧的大体积工具返回值
   * 适用于普通对话（没有 skill 标记）
   *
   * 策略（和 Claude Code 一致）：
   * 1. system prompt 不动
   * 2. 最近 N 条消息保持原样
   * 3. 旧消息中：user/assistant 文本保留，tool 返回值截断到 200 字
   */
  private compactGenericMode(messages: Message[], beforeTokens: number): Message[] {
    const preserved = messages.filter(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');

    // 保留最近 10 条消息不动
    const recentCount = Math.min(10, nonSystem.length);
    const old = nonSystem.slice(0, -recentCount);
    const recent = nonSystem.slice(-recentCount);

    // 对旧消息：保留 user/assistant，截断 tool 返回值
    const trimmed: Message[] = [];
    for (const msg of old) {
      if (msg.role === 'tool') {
        // 工具返回值是最大的 token 消耗源，截断它
        const content = msg.content || '';
        trimmed.push({
          ...msg,
          content: content.length > 200
            ? content.substring(0, 200) + `\n...[已截断，原始 ${content.length} 字符]`
            : content,
        });
      } else if (msg.role === 'assistant' && msg.content) {
        // assistant 文本保留，但截断过长的（超过 500 字）
        const content = msg.content;
        trimmed.push({
          ...msg,
          content: content.length > 500
            ? content.substring(0, 500) + '...'
            : content,
        });
      } else {
        // user 消息保持原样
        trimmed.push(msg);
      }
    }

    const result = [...preserved, ...trimmed, ...recent];

    const after = estimateMessagesTokens(result);
    Logger.info(
      `上下文压缩（通用模式）：${messages.length} 条 → ${result.length} 条，` +
      `${beforeTokens} tokens → ${after} tokens（节省 ${Math.round((1 - after / beforeTokens) * 100)}%）`
    );

    return result;
  }

  /**
   * 分区：把消息分成三组
   *
   * preserved: system prompt（永不压缩）
   * compressible: 已完成的旧工具调用链（可以压缩）
   * recent: 最近的活跃消息（保持原样）
   */
  private partition(messages: Message[]): {
    preserved: Message[];
    compressible: Message[];
    recent: Message[];
  } {
    // preserved: 所有 system 消息
    const preserved = messages.filter(m => m.role === 'system');

    // 非 system 消息
    const nonSystem = messages.filter(m => m.role !== 'system');

    if (nonSystem.length <= 6) {
      // 消息太少，不值得压缩
      return { preserved, compressible: [], recent: nonSystem };
    }

    // 从后往前找"最近一个完成单元的边界"
    const boundary = this.findCompactionBoundary(nonSystem);

    const compressible = nonSystem.slice(0, boundary);
    const recent = nonSystem.slice(boundary);

    return { preserved, compressible, recent };
  }

  /**
   * 找到压缩边界：从后往前扫描，定位最后一个"单元完成标记"
   *
   * 单元完成标记的识别方式：
   * - write_file 写入了 progress.json（paper-analysis / critical-reading）
   * - write_file 写入了 blueprint.md（sci-paper-writing）
   * - write_file 写入了 analysis.md 或维度报告
   *
   * 边界之前的消息 = 已完成，可压缩
   * 边界之后的消息 = 进行中，保留原样
   */
  private findCompactionBoundary(messages: Message[]): number {
    const minKeep = 8; // 至少保留最后 8 条消息

    // 从后往前找，跳过最后 minKeep 条
    for (let i = messages.length - minKeep; i >= 0; i--) {
      if (this.isUnitBoundary(messages[i])) {
        // 边界消息本身属于"已完成"，所以 +1
        return i + 1;
      }
    }

    // 没找到明确边界，压缩前 1/2 的消息
    return Math.floor(messages.length / 2);
  }

  /**
   * 判断一条消息是否是"单元完成标记"
   */
  private isUnitBoundary(message: Message): boolean {
    // 只看 tool result 消息
    if (message.role !== 'tool') return false;
    const content = message.content || '';

    // write_file 写入 progress.json = 一个单元结束
    if (content.includes('progress.json') && content.includes('成功')) return true;

    // write_file 写入 analysis.md = 章节分析完成
    if (content.includes('analysis.md') && content.includes('成功')) return true;

    // write_file 写入 blueprint.md = 蓝图更新
    if (content.includes('blueprint.md') && content.includes('成功')) return true;

    // write_file 写入 critique 维度报告
    if (content.includes('critique/') && content.includes('成功')) return true;

    return false;
  }

  /**
   * 将可压缩消息切分为"完成单元"
   *
   * 每个单元 = 从上一个边界到下一个边界之间的所有消息
   * 例如：[用户请求, 第1章工具链..., 边界, 第2章工具链..., 边界]
   *       → 单元1: [用户请求, 第1章工具链..., 边界]
   *       → 单元2: [第2章工具链..., 边界]
   */
  private splitIntoUnits(messages: Message[]): CompactionUnit[] {
    const units: CompactionUnit[] = [];
    let unitStart = 0;

    for (let i = 0; i < messages.length; i++) {
      if (this.isUnitBoundary(messages[i]) || i === messages.length - 1) {
        const unitMessages = messages.slice(unitStart, i + 1);
        const unit = this.extractUnitSummary(unitMessages);
        units.push(unit);
        unitStart = i + 1;
      }
    }

    // 如果没有找到任何边界，把所有消息作为一个单元
    if (units.length === 0 && messages.length > 0) {
      units.push(this.extractUnitSummary(messages));
    }

    this.compactionHistory.push(...units);
    return units;
  }

  /**
   * 从一组消息中提取确定性摘要（不调用 AI）
   *
   * 提取策略：
   * 1. 从 assistant 消息中提取它的文字回复（通常包含"本章核心发现"等总结）
   * 2. 从 tool_call 中提取调用了哪些工具、写入了哪些文件
   * 3. 忽略工具返回的大段原始内容（这是最大的 token 消耗源）
   */
  private extractUnitSummary(messages: Message[]): CompactionUnit {
    const originalTokens = estimateMessagesTokens(messages);

    // 提取标签：从 write_file 调用中找到写入的文件名
    let label = '对话片段';
    const writtenFiles: string[] = [];
    const assistantSummaries: string[] = [];

    for (const msg of messages) {
      // 从 assistant 消息提取文字总结
      if (msg.role === 'assistant' && msg.content) {
        // 取 assistant 回复的前 200 字作为摘要
        const text = msg.content.trim();
        if (text.length > 0) {
          assistantSummaries.push(
            text.length > 200 ? text.substring(0, 200) + '...' : text
          );
        }
      }

      // 从 tool_calls 中提取写入的文件路径
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function.name === 'write_file') {
            try {
              const args = JSON.parse(tc.function.arguments);
              if (args.path || args.file_path) {
                writtenFiles.push(args.path || args.file_path);
              }
            } catch { /* ignore parse errors */ }
          }
        }
      }
    }

    // 生成标签
    if (writtenFiles.length > 0) {
      const lastFile = writtenFiles[writtenFiles.length - 1];
      // 从路径中提取有意义的部分
      const parts = lastFile.replace(/\\/g, '/').split('/');
      label = parts.slice(-2).join('/');
    }

    // 组装摘要
    const summaryParts: string[] = [];
    if (assistantSummaries.length > 0) {
      // 只保留最后一条 assistant 总结（通常是章节完成时的汇报）
      summaryParts.push(assistantSummaries[assistantSummaries.length - 1]);
    }
    if (writtenFiles.length > 0) {
      summaryParts.push(`[已写入: ${writtenFiles.join(', ')}]`);
    }

    return {
      label,
      originalCount: messages.length,
      originalTokens,
      summary: summaryParts.join('\n') || `[已完成 ${messages.length} 条消息的处理]`,
    };
  }

  /**
   * 将多个压缩单元合并为一条摘要消息
   *
   * 这条消息替代所有被压缩的旧消息，插入到 system prompt 之后、
   * 最近活跃消息之前。role 设为 'user' 以确保 API 兼容性。
   */
  private buildSummaryMessage(units: CompactionUnit[]): Message {
    const lines: string[] = [
      '[以下是之前对话的压缩摘要，详细内容已写入对应文件]',
      '',
    ];

    for (const unit of units) {
      lines.push(`### ${unit.label}（原 ${unit.originalCount} 条消息）`);
      lines.push(unit.summary);
      lines.push('');
    }

    return {
      role: 'user',
      content: lines.join('\n'),
    };
  }
}
