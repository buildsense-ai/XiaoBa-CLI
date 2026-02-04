import chalk from 'chalk';

// 黑金配色主题
export const theme = {
  // 金色渐变系列（从深到浅）
  deepGold: chalk.hex('#8B7500'),    // 最深金色
  darkGold: chalk.hex('#B8860B'),    // 深金色
  gold: chalk.hex('#DAA520'),        // 中等金色（降低亮度）
  brightGold: chalk.hex('#FFD700'),  // 亮金色
  lightGold: chalk.hex('#FFF4C4'),   // 浅金色

  // 黑色系列
  black: chalk.hex('#000000'),       // 纯黑
  darkGray: chalk.hex('#1a1a1a'),    // 深灰
  gray: chalk.hex('#333333'),        // 灰色

  // 功能色
  success: chalk.hex('#DAA520'),     // 成功 - 中等金色
  error: chalk.hex('#FF6B6B'),       // 错误 - 红色
  warning: chalk.hex('#FFA500'),     // 警告 - 橙色
  info: chalk.hex('#87CEEB'),        // 信息 - 浅蓝
};

// 样式组合
export const styles = {
  // 标题样式 - 中等金色加粗
  title: (text: string) => theme.gold.bold(text),

  // 副标题 - 深金色
  subtitle: (text: string) => theme.darkGold(text),

  // 普通文本 - 白色
  text: (text: string) => chalk.white(text),

  // 强调文本 - 中等金色
  highlight: (text: string) => theme.gold(text),

  // 成功消息
  success: (text: string) => theme.success(`✓ ${text}`),

  // 错误消息
  error: (text: string) => theme.error(`✗ ${text}`),

  // 警告消息
  warning: (text: string) => theme.warning(`⚠ ${text}`),

  // 信息消息
  info: (text: string) => theme.info(`ℹ ${text}`),

  // 品牌标识 - 渐变效果
  brand: (text: string) => theme.gold.bold(text),
  brandDark: (text: string) => theme.darkGold.bold(text),
  brandDeep: (text: string) => theme.deepGold.bold(text),

  // 命令样式
  command: (text: string) => theme.darkGold(`$ ${text}`),

  // 代码块
  code: (text: string) => chalk.bgHex('#1a1a1a').hex('#DAA520')(` ${text} `),
};
