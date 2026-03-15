import { SkillHandler, SkillContext } from '../../src/types/skill';
import { DailyReportGenerator } from '../../src/utils/daily-report-generator';

export const handler: SkillHandler = async (context: SkillContext) => {
  const args = context.args?.trim() || '';

  // 解析日期参数（支持多种格式）
  let date: string;

  // 尝试从参数中提取日期（YYYY-MM-DD 格式）
  const dateMatch = args.match(/\d{4}-\d{2}-\d{2}/);
  if (dateMatch) {
    date = dateMatch[0];
  } else {
    // 默认使用今天
    const now = new Date();
    date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  try {
    const generator = new DailyReportGenerator(context.services.aiService);
    const report = await generator.generateReport(date);

    return {
      success: true,
      message: `已生成 ${date} 的工作日报：\n\n${report}`,
    };
  } catch (error: any) {
    return {
      success: false,
      message: `生成日报失败: ${error.message}`,
    };
  }
};
