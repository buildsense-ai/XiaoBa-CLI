#!/usr/bin/env node
'use strict';

const chalk = require('chalk');

// ============ 颜色定义 - 金渐层主题 ============
const gold = chalk.hex('#FFD700');
const amber = chalk.hex('#FFBF00');
const lightGold = chalk.hex('#FFEC8B');
const warmWhite = chalk.hex('#FFF8DC');
const pink = chalk.hex('#FFB6C1');
const dimGold = chalk.hex('#B8860B');

// ============ 终端控制 ============
const write = (s) => process.stdout.write(s);
const hideCursor = () => write('\x1b[?25l');
const showCursor = () => write('\x1b[?25h');
const clearScreen = () => write('\x1b[2J\x1b[H');
const moveTo = (row, col) => write(`\x1b[${row};${col}H`);
const clearLine = () => write('\x1b[2K');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const termWidth = process.stdout.columns || 80;
const termHeight = process.stdout.rows || 24;

// ============ 猫咪帧定义 ============

// 坐着 (正面)
const CAT_SIT = [
  '   /\\_/\\   ',
  '  ( ˙ω˙ )  ',
  '   > ^ <   ',
  '  /|   |\\  ',
  '  (_| |_)  ',
];

// 眨眼
const CAT_BLINK = [
  '   /\\_/\\   ',
  '  ( -ω- )  ',
  '   > ^ <   ',
  '  /|   |\\  ',
  '  (_| |_)  ',
];

// 挥手 frame1
const CAT_WAVE1 = [
  '   /\\_/\\   ',
  '  ( ˙ω˙ )ﾉ',
  '   > ^ <   ',
  '  /|   |   ',
  '  (_| |_)  ',
];

// 挥手 frame2
const CAT_WAVE2 = [
  '   /\\_/\\ ﾉ',
  '  ( ˙ω˙ )/ ',
  '   > ^ <   ',
  '  /|   |   ',
  '  (_| |_)  ',
];

// 走路 frame1 (尾巴左摆)
const CAT_WALK1 = [
  '   /\\_/\\   ',
  '  ( ˙ω˙ )~ ',
  '   > ^ <   ',
  '  /|   |\\  ',
  '  (_| |_)  ',
];

// 走路 frame2 (尾巴右摆)
const CAT_WALK2 = [
  '   /\\_/\\   ',
  '  ( ˙ω˙ ) ~',
  '   > ^ <   ',
  '  /|   |\\  ',
  '  (_| |_)  ',
];

// 气泡框
const BUBBLE = [
  ' ╭────────────╮',
  ' │ 再见喵~ ✨ │',
  ' ╰─────┬──────╯',
  '       │       ',
];

// ============ 渲染函数 ============

function colorCat(lines) {
  return lines.map(line => gold(line));
}

function colorBubble(lines) {
  return lines.map(line => lightGold(line));
}

// 在指定位置渲染一组行
function renderAt(row, col, lines) {
  for (let i = 0; i < lines.length; i++) {
    moveTo(row + i, Math.max(1, col));
    clearLine();
    if (col >= 1 && col < termWidth) {
      write(lines[i]);
    }
  }
}

// 清除指定区域
function clearArea(row, height) {
  for (let i = 0; i < height; i++) {
    moveTo(row + i, 1);
    clearLine();
  }
}

// 渲染猫爪印
function renderPawPrint(row, col) {
  if (col > 0 && col < termWidth - 4) {
    moveTo(row, col);
    write(dimGold(' . .'));
  }
}

// ============ 动画主流程 ============

async function animate() {
  const catHeight = 5;
  const bubbleHeight = 4;
  const totalHeight = bubbleHeight + catHeight;

  const startRow = Math.floor((termHeight - totalHeight) / 2);
  const centerCol = Math.floor((termWidth - 12) / 2);

  const bubbleRow = startRow;
  const catRow = startRow + bubbleHeight;

  hideCursor();
  clearScreen();

  try {
    // === Phase 1: 猫咪登场，静坐 ===
    renderAt(catRow, centerCol, colorCat(CAT_SIT));
    await sleep(800);

    // === Phase 2: 眨眼 ===
    renderAt(catRow, centerCol, colorCat(CAT_BLINK));
    await sleep(250);
    renderAt(catRow, centerCol, colorCat(CAT_SIT));
    await sleep(500);

    // === Phase 3: 气泡出现 ===
    // 逐行显示气泡
    for (let i = 0; i < BUBBLE.length; i++) {
      renderAt(bubbleRow + i, centerCol - 2, [colorBubble(BUBBLE)[i]]);
      await sleep(120);
    }
    await sleep(1200);

    // === Phase 4: 挥手告别 ===
    for (let wave = 0; wave < 3; wave++) {
      renderAt(catRow, centerCol, colorCat(CAT_WAVE1));
      await sleep(280);
      renderAt(catRow, centerCol, colorCat(CAT_WAVE2));
      await sleep(280);
    }
    renderAt(catRow, centerCol, colorCat(CAT_SIT));
    await sleep(300);

    // 清除气泡
    clearArea(bubbleRow, bubbleHeight);
    await sleep(200);

    // === Phase 5: 猫咪向右走出画面 ===
    let pos = centerCol;
    const pawPrints = [];
    let stepCount = 0;

    while (pos < termWidth + 15) {
      clearArea(catRow, catHeight);

      // 渲染之前的爪印 (逐渐变淡)
      for (const pp of pawPrints) {
        renderPawPrint(catRow + 4, pp);
      }

      // 渲染猫咪
      const frame = stepCount % 2 === 0 ? CAT_WALK1 : CAT_WALK2;
      renderAt(catRow, pos, colorCat(frame));

      // 每走几步留一个爪印
      if (stepCount % 3 === 0 && pos < termWidth - 5) {
        pawPrints.push(pos + 3);
      }

      pos += 2;
      stepCount++;
      await sleep(70);
    }

    // 清除走路残留
    clearArea(catRow, catHeight);
    await sleep(200);

    // 爪印渐隐
    for (let fade = 0; fade < 3; fade++) {
      await sleep(300);
      clearArea(catRow + 4, 1);
    }

    // === Phase 6: 结束语 ===
    const farewell = gold('  ˚ ✦ ') + warmWhite(' 下次再见~ See you! ') + gold(' ✦ ˚');
    const farewellCol = Math.floor((termWidth - 30) / 2);
    const farewellRow = Math.floor(termHeight / 2);

    moveTo(farewellRow, farewellCol);
    write(farewell);
    await sleep(2000);

    // 最终清屏
    clearScreen();

  } finally {
    showCursor();
    moveTo(termHeight, 1);
  }
}

// ============ 启动 ============

// 优雅处理 Ctrl+C
process.on('SIGINT', () => {
  showCursor();
  clearScreen();
  moveTo(termHeight, 1);
  process.exit(0);
});

animate().catch((err) => {
  showCursor();
  console.error('Animation error:', err);
  process.exit(1);
});
