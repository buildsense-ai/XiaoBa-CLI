import * as fs from 'fs';
import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { EnterPlanModeTool } from './enter-plan-mode-tool';
import { styles } from '../theme/colors';

/**
 * ExitPlanMode 工具 - 退出规划模式并请求用户批准
 *
 * 用于完成规划阶段，向用户展示规划内容并请求批准。
 * 用户批准后，可以开始执行规划中的步骤。
 */
export class ExitPlanModeTool implements Tool {
  definition: ToolDefinition = {
    name: 'exit_plan_mode',
    description: '退出规划模式并请求用户批准。读取规划文件内容，向用户展示并等待批准。批准后可以开始执行规划。',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: '规划摘要，简要说明规划的主要内容（可选）'
        }
      }
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const { summary } = args;

    try {
      // 检查是否处于规划模式
      if (!EnterPlanModeTool.isInPlanMode()) {
        return '错误：当前不在规划模式中。请先使用 enter_plan_mode 工具进入规划模式。';
      }

      // 获取规划文件路径
      const planFilePath = EnterPlanModeTool.getPlanFilePath();

      // 检查规划文件是否存在
      if (!fs.existsSync(planFilePath)) {
        return `错误：规划文件不存在: ${planFilePath}`;
      }

      // 读取规划文件内容
      const planContent = fs.readFileSync(planFilePath, 'utf-8');

      // 退出规划模式
      EnterPlanModeTool.exitPlanMode();

      // 显示规划摘要
      console.log('\n' + styles.title('📋 规划完成，请求用户批准') + '\n');

      if (summary) {
        console.log(styles.text('规划摘要:'));
        console.log(styles.text(summary) + '\n');
      }

      console.log(styles.text(`规划文件: ${planFilePath}`));
      console.log(styles.text('请查看规划文件内容，确认是否批准执行。\n'));

      return `已退出规划模式。\n\n规划文件: ${planFilePath}\n\n${summary ? `摘要: ${summary}\n\n` : ''}请用户查看规划文件并决定是否批准执行。\n\n规划内容预览:\n${planContent.substring(0, 500)}${planContent.length > 500 ? '\n...\n(完整内容请查看规划文件)' : ''}`;
    } catch (error: any) {
      return `退出规划模式失败: ${error.message}`;
    }
  }
}
