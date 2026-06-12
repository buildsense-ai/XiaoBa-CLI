import { parseSessionKeyV2 } from './session-router';

export type SessionSurface = 'cli' | 'feishu' | 'catscompany' | 'weixin';

const AUTO_SEND_MODE_INSTRUCTION = `【消息模式】你的每次文本输出都会立即自动发送给用户。

工作流程：
1. 简单问答：直接输出文本回答
2. 需要工具：调用工具（read/write/grep 等）后再回答

重要规则：
- 如果还需要调用工具，不要输出任何文本
- 只在最终准备回答用户时才输出文本`;

const CATSCO_REPLY_STYLE_INSTRUCTION = [
  '【CatsCo 回复呈现】优先让聊天气泡轻、短、好扫读。',
  '',
  '默认回复：',
  '- 先给结论；普通问答用 1-3 句或最多 3 个要点。',
  '- 不把完整报告、长表格、长代码、长步骤直接堆进聊天气泡。',
  '- 用户明确要详细解释时，也先给摘要，再按需要展开。',
  '',
  '富媒体/产物化：',
  '- 当内容更像报告、讲义、对比表、页面效果、数据明细、可视化说明或可交付文档时，优先用 write_file 生成文件，再用 send_file 发给用户。',
  '- HTML 适合可视化报告、流程图、卡片式讲解、网页效果和图文排版；Markdown 适合可复制摘要、说明文档和清单；CSV 适合结构化数据。',
  '- 发送文件后，聊天里只留一句短说明，例如“我做成了 HTML 报告，点预览看。”',
  '- 如果还没有生成文件，不要假装已有预览或附件。',
].join('\n');

const CATSCO_FILE_SELECTION_INSTRUCTION = [
  '[CatsCo file selection rules]',
  '- tmp/downloads/... is the local cache for files/images received from chat. It is not the user\'s general local file library.',
  '- If the user asks for a new/local file or says they have not sent it before, do not reuse files from tmp/downloads/... or old conversation paths.',
  '- If the user did not provide an exact path, first ask for the location or search likely local folders such as Desktop, Downloads, Documents, Pictures, or an explicit path the user mentioned.',
  '- Use current catsco_attachment:<id> references for received attachments; local tmp/downloads paths are backend-only and should not be guessed or reused.',
].join('\n');

export function resolveSessionSurface(sessionKey: string, sessionType?: string): SessionSurface {
  const parsedV2 = parseSessionKeyV2(sessionKey);
  if (parsedV2) {
    if (parsedV2.source === 'catscompany') return 'catscompany';
    if (parsedV2.source === 'feishu') return 'feishu';
    if (parsedV2.source === 'weixin') return 'weixin';
    return 'cli';
  }

  const normalizedSessionType = (sessionType || '').toLowerCase();
  if (normalizedSessionType === 'weixin') return 'weixin';
  if (normalizedSessionType === 'feishu') return 'feishu';
  if (normalizedSessionType === 'catscompany') return 'catscompany';

  if (sessionKey.startsWith('cc_user:') || sessionKey.startsWith('cc_group:')) {
    return 'catscompany';
  }
  if (sessionKey.startsWith('user:') || sessionKey.startsWith('group:')) {
    return 'feishu';
  }
  return 'cli';
}

export function composeSurfacePrompt(sessionKey: string, sessionType?: string): string | undefined {
  const surface = resolveSessionSurface(sessionKey, sessionType);
  const parsedV2 = parseSessionKeyV2(sessionKey);

  if (surface === 'feishu') {
    const isGroup = parsedV2 ? parsedV2.topicType === 'group' : sessionKey.startsWith('group:');
    const chatType = isGroup ? '群聊' : '私聊';
    return `[surface:feishu:${isGroup ? 'group' : 'private'}]\n当前是飞书${chatType}会话。\n${AUTO_SEND_MODE_INSTRUCTION}`;
  }

  if (surface === 'catscompany') {
    return `[surface:catscompany]\n当前是 CatsCo 聊天会话。\n${AUTO_SEND_MODE_INSTRUCTION}\n\n${CATSCO_REPLY_STYLE_INSTRUCTION}\n\n${CATSCO_FILE_SELECTION_INSTRUCTION}`;
  }

  if (surface === 'weixin') {
    return `[surface:weixin]\n当前是微信聊天会话。\n${AUTO_SEND_MODE_INSTRUCTION}`;
  }

  return undefined;
}
