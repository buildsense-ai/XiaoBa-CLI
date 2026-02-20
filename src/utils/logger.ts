import * as fs from 'fs';
import * as path from 'path';
import { styles } from '../theme/colors';
import ora, { Ora } from 'ora';

export class Logger {
  private static spinner: Ora | null = null;
  private static logStream: fs.WriteStream | null = null;
  private static logFilePath: string | null = null;

  private static stripAnsi(str: string): string {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1B\[[0-9;]*m/g, '');
  }

  private static writeToFile(level: string, message: string): void {
    if (!this.logStream) return;
    const now = new Date();
    const Y = now.getFullYear();
    const M = String(now.getMonth() + 1).padStart(2, '0');
    const D = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    const ts = `${Y}-${M}-${D} ${h}:${m}:${s}.${ms}`;
    const clean = this.stripAnsi(message);
    this.logStream.write(`[${ts}] [${level}] ${clean}\n`);
  }

  static openLogFile(sessionType: string, sessionKey?: string): void {
    const now = new Date();
    const dateDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const suffix = sessionKey ? `${sessionType}_${sessionKey}` : sessionType;
    const fileName = `${hh}-${mm}-${ss}_${suffix}.log`;

    const dir = path.resolve('logs', dateDir);
    fs.mkdirSync(dir, { recursive: true });

    this.logFilePath = path.join(dir, fileName);
    this.logStream = fs.createWriteStream(path.join(dir, fileName), { flags: 'a' });
  }

  static closeLogFile(): void {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
      this.logFilePath = null;
    }
  }

  static getLogFilePath(): string | null {
    return this.logFilePath;
  }

  static success(message: string): void {
    this.writeToFile('SUCCESS', message);
    console.log(styles.success(message));
  }

  static error(message: string): void {
    this.writeToFile('ERROR', message);
    console.error(styles.error(message));
  }

  static warning(message: string): void {
    this.writeToFile('WARN', message);
    console.warn(styles.warning(message));
  }

  static info(message: string): void {
    this.writeToFile('INFO', message);
    console.log(styles.info(message));
  }

  static title(message: string): void {
    this.writeToFile('INFO', message);
    console.log('\n' + styles.title(message) + '\n');
  }

  static text(message: string): void {
    this.writeToFile('TEXT', message);
    console.log(styles.text(message));
  }

  static highlight(message: string): void {
    this.writeToFile('TEXT', message);
    console.log(styles.highlight(message));
  }

  /**
   * 启动进度指示器
   * @param message 进度消息
   */
  static startProgress(message: string): void {
    if (this.spinner) {
      this.spinner.stop();
    }
    this.spinner = ora(styles.text(message)).start();
  }

  /**
   * 更新进度消息
   * @param message 新的进度消息
   */
  static updateProgress(message: string): void {
    if (this.spinner) {
      this.spinner.text = styles.text(message);
    }
  }

  /**
   * 停止进度指示器
   * @param success 是否成功（true=成功, false=失败, undefined=仅停止）
   * @param message 最终消息（可选）
   */
  static stopProgress(success?: boolean, message?: string): void {
    if (!this.spinner) {
      return;
    }

    if (success === true) {
      this.spinner.succeed(message ? styles.success(message) : undefined);
    } else if (success === false) {
      this.spinner.fail(message ? styles.error(message) : undefined);
    } else {
      this.spinner.stop();
      if (message) {
        console.log(message);
      }
    }

    this.spinner = null;
  }

  /**
   * 显示百分比进度条
   * @param current 当前进度
   * @param total 总数
   * @param message 进度消息（可选）
   */
  static progressBar(current: number, total: number, message?: string): void {
    const percentage = Math.round((current / total) * 100);
    const barLength = 30;
    const filledLength = Math.round((barLength * current) / total);
    const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);

    const progressText = `[${bar}] ${percentage}% (${current}/${total})`;
    const fullMessage = message ? `${message} ${progressText}` : progressText;

    if (this.spinner) {
      this.spinner.text = styles.text(fullMessage);
    } else {
      // 使用 \r 实现同行更新
      process.stdout.write('\r' + styles.text(fullMessage));
    }
  }

  /**
   * 清除进度条（换行）
   */
  static clearProgress(): void {
    if (!this.spinner) {
      process.stdout.write('\n');
    }
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
