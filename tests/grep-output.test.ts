import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  MAX_GREP_LINE_CHARS,
  MAX_GREP_OUTPUT_CHARS,
  boundGrepOutput,
  sliceCodePointSafe,
} from '../src/tools/grep-output';

/** 输出必须不含孤立代理项（UTF-16 码点完整）。 */
function assertNoLoneSurrogates(text: string): void {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const follower = text.charCodeAt(i + 1);
      assert.ok(
        follower >= 0xdc00 && follower <= 0xdfff,
        `lone high surrogate at index ${i}`,
      );
      i++; // 成对跳过低位代理项
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      assert.fail(`lone low surrogate at index ${i}`);
    }
  }
}

/** 构造一行 filename:line:content 形式的 grep content 输出。 */
function grepLine(path: string, lineNo: number, text: string): string {
  return `${path}:${lineNo}:${text}`;
}

describe('grep-output boundGrepOutput', () => {
  test('exposes the diagnosed budgets', () => {
    assert.equal(MAX_GREP_OUTPUT_CHARS, 16_000);
    assert.equal(MAX_GREP_LINE_CHARS, 2_000);
  });

  test('returns empty and short legitimate output byte-identical', () => {
    assert.equal(boundGrepOutput(''), '');

    const noMatch = '未找到匹配项。\n模式: token\n路径: .\n';
    assert.equal(boundGrepOutput(noMatch), noMatch);

    const legitimate = [
      '找到 3 行匹配:',
      '模式: token',
      '路径: .',
      '',
      grepLine('src/a.ts', 12, 'export const token = 1;'),
      grepLine('src/b.ts', 40, '  token.parse(input);'),
      grepLine('docs/notes.md', 7, 'token 说明'),
    ].join('\n');
    assert.equal(boundGrepOutput(legitimate), legitimate);
  });

  test('bounds the diagnosed 71KB 11-line JSONL output under budget with honest markers', () => {
    // 复现诊断场景：71,355 字符结果来自 11 行 JSONL minified 长行。
    const hugeJsonLines = Array.from({ length: 11 }, (_, i) => JSON.stringify({
      conversation_id: `c-${i}`,
      items: Array.from({ length: 40 }, (_, j) => ({
        index: j,
        payload: 'x'.repeat(170),
        unicode: '字段值含中文与emoji😀',
      })),
    }));
    const content = [
      '找到 11 行匹配:',
      '模式: conversation_id',
      '路径: logs',
      '',
      ...hugeJsonLines.map((line, i) => grepLine('logs/trace.jsonl', i + 1, line)),
    ].join('\n');
    assert.ok(content.length > 70_000);
    assert.ok(content.length > MAX_GREP_OUTPUT_CHARS);

    const bounded = boundGrepOutput(content);

    assert.ok(bounded.length <= MAX_GREP_OUTPUT_CHARS, `bounded length ${bounded.length}`);
    assert.ok(bounded.length > 0);
    // 有用的 filename:line 前缀保留
    assert.ok(bounded.includes('logs/trace.jsonl:2:'), 'keeps filename:line prefix of the long line');
    // 行级显式截断标记（不静默丢字）
    assert.ok(bounded.includes('……[本行过长，已截断]'));
    // 11 行长行收口后总量仍超预算 → 尾部行被丢弃并给出总标记
    assert.ok(bounded.split('\n').length < 15);
    // 中文总截断标记：已截断 + 收窄 path/glob + 分页/read_file + 非穷尽
    assert.ok(bounded.includes('[输出已截断]'));
    assert.ok(bounded.includes('glob'));
    assert.ok(bounded.includes('read_file'));
    assert.ok(bounded.includes('并非全部匹配结果'));
    // 不会把溢出伪装成零匹配
    assert.ok(!bounded.startsWith('未找到匹配项'));
    assert.ok(bounded.includes('找到 11 行匹配'));
    assertNoLoneSurrogates(bounded);
  });

  test('keeps whole lines when many short lines exceed neither budget', () => {
    const lines = Array.from({ length: 900 }, (_, i) => grepLine('src/mod.ts', i + 1, `const v${i} = ${i};`));
    const content = `找到 900 行匹配:\n${lines.join('\n')}`;
    assert.ok(content.length > MAX_GREP_OUTPUT_CHARS);

    const bounded = boundGrepOutput(content);
    assert.ok(bounded.length <= MAX_GREP_OUTPUT_CHARS);
    // 总量超限时：尾部行被丢弃且给出总标记，且没有任何行级截断
    assert.ok(bounded.includes('[输出已截断]'));
    assert.ok(!bounded.includes('……[本行过长，已截断]'));
    // 至少首行完整保留
    assert.ok(bounded.includes(lines[0]));
    assertNoLoneSurrogates(bounded);
  });

  test('drops tail lines with the final marker but keeps leading lines intact', () => {
    const lines = Array.from({ length: 20 }, (_, i) => grepLine('src/big.ts', i + 1, 'y'.repeat(1_500)));
    const content = lines.join('\n');
    assert.ok(content.length > MAX_GREP_OUTPUT_CHARS);

    const bounded = boundGrepOutput(content);
    assert.ok(bounded.length <= MAX_GREP_OUTPUT_CHARS);
    assert.ok(bounded.endsWith('以上并非全部匹配结果。'));
    assert.ok(bounded.includes('[输出已截断]'));
    // 前面的行原样保留（未被行级截断）
    assert.ok(bounded.includes(lines[0]));
    assert.ok(bounded.includes(lines[1]));
    // 行级标记不应出现：这些行本身未超单行预算
    assert.ok(!bounded.includes('……[本行过长，已截断]'));
    assertNoLoneSurrogates(bounded);
  });

  test('bounds a single long line preserving filename:line prefix and astral Unicode', () => {
    const astral = '字段😀'.repeat(700); // 每个单元 5 个 code units，含增补平面字符
    const line = grepLine('src/数据.ts', 88, astral);
    assert.ok(line.length > MAX_GREP_LINE_CHARS);

    const bounded = boundGrepOutput(line);
    assert.ok(bounded.startsWith('src/数据.ts:88:'), 'prefix preserved');
    assert.ok(bounded.endsWith('……[本行过长，已截断]'));
    const body = bounded.slice('src/数据.ts:88:'.length, bounded.length - '……[本行过长，已截断]'.length);
    assert.ok(body.length <= MAX_GREP_LINE_CHARS);
    assertNoLoneSurrogates(bounded);
  });

  test('cuts at a surrogate boundary without splitting emoji pairs', () => {
    // 1999 个 BMP 字符 + 一个 4-code-unit 增补字符 → 默认截断点会劈开代理对
    const text = 'a'.repeat(MAX_GREP_LINE_CHARS - 1) + '😀'.repeat(10);
    const line = grepLine('src/emoji.ts', 1, text);
    const bounded = boundGrepOutput(line);
    const body = bounded.slice('src/emoji.ts:1:'.length, bounded.length - '……[本行过长，已截断]'.length);
    assert.ok(body.length <= MAX_GREP_LINE_CHARS);
    assertNoLoneSurrogates(body);
    // sliceCodePointSafe 直测：边界回退不劈开代理对
    const sliced = sliceCodePointSafe('a'.repeat(3) + '😀', 4);
    assert.equal(sliced, 'aaa');
  });

  test('near-budget input: marker overhead is included in the hard cap', () => {
    // 刚好一条超过单行预算的长行：仅行级标记，总量远低于总预算，无总标记
    const singleLongLine = grepLine('a.txt', 1, 'z'.repeat(MAX_GREP_LINE_CHARS + 50));
    const boundedLine = boundGrepOutput(singleLongLine);
    assert.ok(boundedLine.endsWith('……[本行过长，已截断]'));
    assert.ok(!boundedLine.includes('[输出已截断]'));
    assert.ok(boundedLine.length < 0.2 * MAX_GREP_OUTPUT_CHARS);

    // 总量略微超过总预算：总长（含总截断标记）仍 ≤ MAX_GREP_OUTPUT_CHARS
    const slightlyOverLines = Array.from({ length: 600 }, (_, i) => grepLine('a.txt', i + 1, 'z'.repeat(40)));
    const slightlyOver = slightlyOverLines.join('\n');
    assert.ok(slightlyOver.length > MAX_GREP_OUTPUT_CHARS);
    const bounded = boundGrepOutput(slightlyOver);
    assert.ok(bounded.length <= MAX_GREP_OUTPUT_CHARS);
    assert.ok(bounded.includes('[输出已截断]'));
    assertNoLoneSurrogates(bounded);
  });

  test('is idempotent: bounding an already-bounded output returns it byte-identical', () => {
    const inputs = [
      '', // 空串
      grepLine('logs/trace.jsonl', 2, JSON.stringify({ items: 'x'.repeat(71_000) })),
      `找到 11 行匹配:\n${grepLine('logs/trace.jsonl', 2, '{"k":"' + 'x'.repeat(70_000) + '"}')}\n${grepLine('src/a.ts', 3, 'short')}`,
      '😀'.repeat(9_000), // 大量增补平面字符
      Array.from({ length: 30 }, (_, i) => grepLine('src/数据.ts', i + 1, '字段😀'.repeat(500))).join('\n'),
      'z'.repeat(MAX_GREP_OUTPUT_CHARS),
      `header\n${'--'}\n${grepLine('src/b.ts', 9, 'ok')}`,
    ];
    for (const input of inputs) {
      const once = boundGrepOutput(input);
      const twice = boundGrepOutput(once);
      assert.equal(twice, once);
      assert.ok(once.length <= MAX_GREP_OUTPUT_CHARS);
      assertNoLoneSurrogates(once);
    }
  });

  test('keeps no-match and error strings honest and never fakes zero matches on overflow', () => {
    const noMatch = '未找到匹配项。\n模式: needle\n路径: .\n';
    assert.equal(boundGrepOutput(noMatch), noMatch);

    // 溢出输出必须仍然报告匹配存在，不得变成"未找到匹配项"
    const oversized = `找到 5 行匹配:\n模式: needle\n${grepLine('f.bin', 1, '\0'.repeat(70_000))}`;
    const bounded = boundGrepOutput(oversized);
    assert.ok(bounded.includes('找到 5 行匹配'));
    assert.ok(!bounded.startsWith('未找到匹配项'));
    assert.ok(bounded.length <= MAX_GREP_OUTPUT_CHARS);
  });

  test('context separators and header lines pass through unharmed', () => {
    const content = ['找到 2 行匹配:', '模式: q', '--', grepLine('a.ts', 1, 'q here'), '--', grepLine('b.ts', 5, 'q there')].join('\n');
    assert.equal(boundGrepOutput(content), content);
  });
});
