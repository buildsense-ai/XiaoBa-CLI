/**
 * Grep 输出边界控制（纯函数：无文件系统访问、无日志副作用、不读取工具参数）。
 *
 * 背景（2026-09 实例 .34 诊断）：一次真实 turn 花费 533s，其中 grep 工具窗口
 * 约 507s，单个 content 模式结果达 71,355 字符（仅来自 11 行 JSONL 长行）。
 * 超大工具结果会直接污染模型上下文。grep-tool 的 `--max-columns` 只影响 rg
 * 展示层；system grep / Node.js fallback 以及 minified 长行仍可产生超长输出，
 * 因此在结果返回前用本模块统一收口。该函数将由协调方接入 GrepTool。
 *
 * 契约：
 * - 逐行限制：超过 MAX_GREP_LINE_CHARS 的匹配行在保留 filename:line 前提下
 *   截断正文，并追加显式行级截断标记（不静默丢字）。
 * - 总量限制：整体输出（含标记）不超过 MAX_GREP_OUTPUT_CHARS；超出时丢弃
 *   尾部行并追加中文总截断标记，明确"结果并非穷尽"。
 * - 诚实性：空输入原样返回；绝不把"输出过大"伪装成"未找到匹配项"。
 * - Unicode 安全：按 UTF-16 码点边界截断，不切断代理对（emoji 等
 *   增补平面字符保持完整）。
 * - 幂等：对已收口的输出再次收口，结果逐字节不变。
 */

/** 单次 grep 工具结果允许的最大字符数（UTF-16 code units，含截断标记）。 */
export const MAX_GREP_OUTPUT_CHARS = 16_000;

/** 单个匹配行正文（不含 filename:line 前缀与行截断标记）允许的最大字符数。 */
export const MAX_GREP_LINE_CHARS = 2_000;

/** 行级截断标记：明确本行被截断，而非静默丢字。 */
const LINE_TRUNCATION_MARKER = '……[本行过长，已截断]';

/**
 * 总截断标记（中文）：说明输出已截断、建议收窄 path/glob 或使用
 * limit/offset 分页与 read_file，并强调结果并非穷尽。
 */
const OUTPUT_TRUNCATION_MARKER =
  '[输出已截断] 匹配结果过长，仅保留部分内容；请用更精确的 path 或 glob 收窄搜索范围，'
  + '或使用 limit/offset 分页以及 read_file 查看完整文件。以上并非全部匹配结果。';

/** content 模式匹配行的 filename:line 前缀（路径可含冒号，取首个 `:数字:` 段）。 */
const GREP_LINE_PREFIX_PATTERN = /^(.+?:\d+:)/;

/**
 * 按码点安全截断到 maxChars 个 UTF-16 code unit：
 * 若边界恰好落在代理对中间则回退一个 code unit，保证输出不含孤立代理项。
 */
export function sliceCodePointSafe(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  let end = maxChars;
  const boundary = text.charCodeAt(end - 1);
  if (boundary >= 0xd800 && boundary <= 0xdbff) {
    const follower = text.charCodeAt(end);
    if (follower >= 0xdc00 && follower <= 0xdfff) end -= 1;
  }
  return text.slice(0, end);
}

/**
 * 收口单个输出行：
 * - 已带行级标记的行先摘除旧标记再重新评估（截断点落在前缀内部，重算结果
 *   与原行一致），保证幂等；
 * - 超长行保留 filename:line 前缀，仅对正文截断并追加显式标记。
 */
function boundGrepLine(line: string): string {
  const hasMarker = line.endsWith(LINE_TRUNCATION_MARKER);
  const effective = hasMarker ? line.slice(0, line.length - LINE_TRUNCATION_MARKER.length) : line;
  if (!hasMarker && effective.length <= MAX_GREP_LINE_CHARS) return line;

  const prefixMatch = GREP_LINE_PREFIX_PATTERN.exec(effective);
  const prefix = prefixMatch ? prefixMatch[1] : '';
  const body = effective.slice(prefix.length);
  const bodyBudget = Math.max(1, MAX_GREP_LINE_CHARS - prefix.length);
  return prefix + sliceCodePointSafe(body, bodyBudget) + LINE_TRUNCATION_MARKER;
}

/**
 * 对 grep 工具文本输出做总量与单行收口。
 *
 * - 空输入原样返回（不会生成伪造的"未找到匹配项"）；
 * - 已在预算内的合法输出逐字节原样返回；
 * - 超限输出保留尽量多的完整行（极端情况下也至少保留一行有意义的内容），
 *   丢弃的尾部以中文总截断标记说明，且最终长度（含标记）不超过
 *   MAX_GREP_OUTPUT_CHARS。
 */
export function boundGrepOutput(content: string): string {
  if (!content) return content;

  const rawLines = content.split('\n');
  const markerSeparator = 1; // 行间 '\n'
  const lineBudget = Math.max(0, MAX_GREP_OUTPUT_CHARS - OUTPUT_TRUNCATION_MARKER.length - markerSeparator);

  const parts: string[] = [];
  let used = 0;
  let droppedTail = false;

  for (const rawLine of rawLines) {
    const boundedLine = boundGrepLine(rawLine);
    const addition = boundedLine.length + (parts.length > 0 ? markerSeparator : 0);
    if (used + addition > lineBudget) {
      if (parts.length === 0) {
        // 至少保留一行有意义的内容（极端配置下的防御分支）。
        const first = sliceCodePointSafe(boundedLine, lineBudget);
        if (first) {
          parts.push(first);
          used = first.length;
        }
      }
      droppedTail = true;
      break;
    }
    parts.push(boundedLine);
    used += addition;
  }

  const bounded = parts.join('\n');
  if (!droppedTail) return bounded;

  const withMarker = `${bounded}\n${OUTPUT_TRUNCATION_MARKER}`;
  if (withMarker.length <= MAX_GREP_OUTPUT_CHARS) return withMarker;
  // 防御分支：常量被配置成极端值时仍保证硬上限（按码点安全截断）。
  const keep = sliceCodePointSafe(bounded, Math.max(0, MAX_GREP_OUTPUT_CHARS - OUTPUT_TRUNCATION_MARKER.length - markerSeparator));
  return keep ? `${keep}\n${OUTPUT_TRUNCATION_MARKER}` : OUTPUT_TRUNCATION_MARKER;
}
