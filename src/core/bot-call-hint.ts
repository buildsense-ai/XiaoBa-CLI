import { Message } from '../types';
import { renderRequiredDefaultPromptFile } from '../utils/prompt-template';

export const TRANSIENT_BOT_CALL_HINT_PREFIX = '[transient_bot_call_hint]';

/**
 * 平台把这个 bot 当工具调用时，本轮要附上的说明。
 *
 * 为什么需要它：bot 不知道自己是被另一个 Agent 在另一台机器上调的，于是很自然地
 * 把结果写成「报告已生成：/tmp/report.pdf」—— 在它自己的对话里看着合理，但调用方
 * 只能拿到这串字符，文件还留在这台机器上，两边都看不出发生过什么。
 *
 * 为什么是「本轮」而不是系统提示：普通聊天里这句话是错的（对面就是人，看得见文件）。
 * 所以它跟着 `metadata.catsco_bot_call` 走，每轮重建、不进历史 —— 与群成员名单同一
 * 种做法（会变的状态写进历史就会过期）。
 */
export function buildBotCallHintMessage(): Message {
  return {
    role: 'system',
    content: `${TRANSIENT_BOT_CALL_HINT_PREFIX}\n${renderRequiredDefaultPromptFile('transient/bot-call-hint.md', {})}`,
    __cacheScope: 'dynamic',
  };
}
