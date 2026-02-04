import { styles } from '../theme/colors';

export class Logger {
  static success(message: string): void {
    console.log(styles.success(message));
  }

  static error(message: string): void {
    console.error(styles.error(message));
  }

  static warning(message: string): void {
    console.warn(styles.warning(message));
  }

  static info(message: string): void {
    console.log(styles.info(message));
  }

  static title(message: string): void {
    console.log('\n' + styles.title(message) + '\n');
  }

  static text(message: string): void {
    console.log(styles.text(message));
  }

  static highlight(message: string): void {
    console.log(styles.highlight(message));
  }

  static brand(): void {
    const GAP = "   ";    // 左右两边的间距
    const CAT_WIDTH = 35; // ⚡️关键：左侧猫的占位宽度，必须固定！

    // 1. 左侧：猫 (纯文本)
    const leftRaw = [
      '       ▄████▄             ▄████▄',
      '      ████████▄▄▄▄▄▄▄▄▄▄▄████████',
      '      ███████████████████████████',
      '      ▐██▀  ▀██▀  ▀██▀  ▀██▀  ██▌',
      '      ██ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ██',
      '      ██ ▓▓▓▓██▓▓▓▓▓▓▓▓▓██▓▓▓▓ ██',
      '      ██ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ██',
      '      ██ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ██',
      '       ██▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓██',
      '        ▀██▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄██▀'
    ];

    // 2. 右侧：XIAO BA (纯文本，已校对)
    // 包含顶部空行以实现垂直居中
    const rightRaw = [
      '', 
      '   ██╗  ██╗██╗ █████╗  ██████╗     ██████╗  █████╗',
      '   ╚██╗██╔╝██║██╔══██╗██╔═══██╗    ██╔══██╗██╔══██╗',
      '    ╚███╔╝ ██║███████║██║   ██║    ██████╔╝███████║',
      '    ██╔██╗ ██║██╔══██║██║   ██║    ██╔══██╗██╔══██║',
      '   ██╔╝ ██╗██║██║  ██║╚██████╔╝    ██████╔╝██║  ██║',
      '   ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝ ╚═════╝     ╚═════╝ ╚═╝  ╚═╝',
      '',
      '      < Your AI Assistant !!! Meow Meow !!! >'
    ];

    // 3. 循环拼接输出
    console.log('\n'); // 顶部留白

    const maxLines = Math.max(leftRaw.length, rightRaw.length);

    for (let i = 0; i < maxLines; i++) {
      const leftText = leftRaw[i] || '';
      const rightText = rightRaw[i] || '';

      // 核心逻辑：先用空格填满左侧宽度，再上色
      const leftPadded = leftText.padEnd(CAT_WIDTH, ' ');

      // --- 左侧上色 ---
      let leftFinal = styles.brandDeep(leftPadded);
      if (i === 1 || i === 2) leftFinal = styles.brand(leftPadded); // 头顶亮色
      if (i >= 3 && i <= 5)   leftFinal = styles.brandDark(leftPadded); // 眼睛深色

      // --- 右侧上色 ---
      let rightFinal = styles.brandDeep(rightText);
      if (i >= 1 && i <= 6) rightFinal = styles.brand(rightText);   // XIAO BA 亮色
      if (i === 8)          rightFinal = styles.subtitle(rightText); // Slogan 灰色

      // 输出
      console.log(leftFinal + GAP + rightFinal);
    }

    console.log('\n'); // 底部留白
  }
}
