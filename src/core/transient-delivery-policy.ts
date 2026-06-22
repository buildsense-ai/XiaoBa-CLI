import { ContentBlock, Message } from '../types';
import { ToolDefinition, ToolSurface } from '../types/tool';
import {
  readRequiredDefaultPromptFile,
  renderRequiredDefaultPromptFile,
} from '../utils/prompt-template';

export const TRANSIENT_DELIVERY_POLICY_PREFIX = '[transient_delivery_policy]';
export const IN_CONTEXT_DELIVERY_EXAMPLES_PREFIX = '[in_context_delivery_examples]';

export interface DeliveryPolicyDecision {
  inject: boolean;
  injectExamples: boolean;
  latestUserText: string;
  reason: string;
  surfaceLabel: string;
  visibleBudget: string;
  artifactChannels: string;
}

export interface TransientDeliveryPolicyOptions {
  messages: Message[];
  tools: ToolDefinition[];
  surface?: ToolSurface;
  turn: number;
  executedToolCalls: number;
}

const LONG_CONTENT_SIGNAL =
  /长篇|完整|详细|全文|大纲|报告|文档|讲义|练习题|试卷|教案|表格|PPT|幻灯片|总结|摘要|会议纪要|日报|周报|月报|复盘|方案|计划|清单|材料|教程|说明书|合同|简历|整理|生成|创建|写一份|写个|输出|导出|文件|markdown|\.md\b|docx|xlsx|pptx|pdf|html|网页/i;

const WORK_RESULT_SIGNAL =
  /代码|源码|仓库|项目|bug|报错|异常|日志|接口|组件|构建|编译|测试|修复|修改|实现|优化|重构|排查|检查|review|文档|表格|报告|总结|整理|生成|导出/i;

const ACK_ONLY_SIGNAL =
  /^(好|好的|收到|嗯|谢谢|谢了|ok|OK|行|可以|明白|了解)[。.!！\s]*$/;

export function buildTransientDeliveryHints(options: TransientDeliveryPolicyOptions): Message[] {
  const decision = resolveDeliveryPolicyDecision(options);
  if (!decision.inject) return [];

  const examples = decision.injectExamples ? buildDeliveryExamplesMessage() : null;
  const policy = buildDeliveryPolicyMessage(decision);
  return [examples, policy].filter((message): message is Message => Boolean(message));
}

export function resolveDeliveryPolicyDecision(options: TransientDeliveryPolicyOptions): DeliveryPolicyDecision {
  const latestUserText = findLatestRealUserText(options.messages);
  const toolNames = new Set(options.tools.map(tool => tool.name));
  const hasLongContentSignal = LONG_CONTENT_SIGNAL.test(latestUserText);
  const hasWorkSignal = WORK_RESULT_SIGNAL.test(latestUserText);
  const hasDeliveryTool = toolNames.has('write_file') || toolNames.has('send_file');
  const toolLoopActive = options.executedToolCalls > 0 || hasRecentToolExchange(options.messages);
  const messageSurface = isMessageSurface(options.surface);
  const ackOnly = ACK_ONLY_SIGNAL.test(latestUserText.trim());

  const inject = Boolean(
    latestUserText
    && !ackOnly
    && (
      hasLongContentSignal
      || (hasWorkSignal && (options.tools.length > 0 || toolLoopActive))
      || (toolLoopActive && messageSurface)
    )
  );

  const reasons: string[] = [];
  if (hasLongContentSignal) reasons.push('long-content-or-artifact-request');
  if (hasWorkSignal) reasons.push('work-result-likely');
  if (toolLoopActive) reasons.push('tool-loop-active');
  if (messageSurface) reasons.push('message-surface');

  return {
    inject,
    injectExamples: inject,
    latestUserText,
    reason: reasons.join(', ') || 'delivery-default',
    surfaceLabel: describeSurface(options.surface),
    visibleBudget: describeVisibleBudget(options.surface),
    artifactChannels: describeArtifactChannels(toolNames, hasDeliveryTool),
  };
}

function buildDeliveryExamplesMessage(): Message {
  return {
    role: 'user',
    content: [
      IN_CONTEXT_DELIVERY_EXAMPLES_PREFIX,
      'Style examples only. Not part of the current conversation. Do not answer these examples.',
      readRequiredDefaultPromptFile('transient/delivery-examples.md'),
    ].join('\n'),
    __injected: true,
  };
}

function buildDeliveryPolicyMessage(decision: DeliveryPolicyDecision): Message {
  return {
    role: 'user',
    content: [
      TRANSIENT_DELIVERY_POLICY_PREFIX,
      'Runtime context only. Not a user request. Do not answer this message directly.',
      renderRequiredDefaultPromptFile('transient/delivery-policy.md', {
        surfaceLabel: decision.surfaceLabel,
        visibleBudget: decision.visibleBudget,
        artifactChannels: decision.artifactChannels,
        reason: decision.reason,
      }),
    ].join('\n'),
    __injected: true,
  };
}

function findLatestRealUserText(messages: Message[]): string {
  for (let idx = messages.length - 1; idx >= 0; idx--) {
    const message = messages[idx];
    if (message.role !== 'user' || message.__injected) continue;
    const text = contentToString(message.content).trim();
    if (text) return text;
  }
  return '';
}

function hasRecentToolExchange(messages: Message[]): boolean {
  return messages.slice(-12).some(message => (
    message.role === 'tool'
    || Boolean(message.tool_calls?.length)
  ));
}

function contentToString(content: string | ContentBlock[] | null): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(block => block.type === 'text' ? block.text : '[image]')
    .join('\n');
}

function isMessageSurface(surface?: ToolSurface): boolean {
  return surface === 'catscompany' || surface === 'feishu' || surface === 'weixin';
}

function describeSurface(surface?: ToolSurface): string {
  switch (surface) {
    case 'weixin':
      return '微信短消息';
    case 'feishu':
      return '飞书聊天';
    case 'catscompany':
      return 'CatsCo 会话';
    case 'cli':
      return 'CLI/本地终端';
    case 'agent':
      return '子 agent';
    case 'research':
      return '研究任务';
    default:
      return '未知或通用会话';
  }
}

function describeVisibleBudget(surface?: ToolSurface): string {
  switch (surface) {
    case 'weixin':
      return '默认 1-3 句，约 120 个中文字符以内；只保留结论、交付物位置和必要下一步。';
    case 'feishu':
      return '默认 2-4 句，避免刷屏；群聊中只发关键结论和需要对方做的事。';
    case 'catscompany':
      return '默认短结论优先；长细节放文件、附件、网页详情或可展开内容。';
    case 'cli':
      return '默认先给短结论和验证结果；需要长内容时写入文件。';
    default:
      return '默认短回复优先；不要把长内容直接贴进聊天。';
  }
}

function describeArtifactChannels(toolNames: Set<string>, hasDeliveryTool: boolean): string {
  if (!hasDeliveryTool) {
    return '当前未看到 write_file/send_file 交付工具；如果确实需要长内容，先给短摘要并询问用户是否展开或提供可用交付方式。';
  }

  const channels: string[] = [];
  if (toolNames.has('write_file')) channels.push('write_file 写入完整材料');
  if (toolNames.has('send_file')) channels.push('send_file 发送已有文件');
  return channels.join('；');
}
