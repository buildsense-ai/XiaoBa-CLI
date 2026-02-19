import * as fs from 'fs';
import * as path from 'path';
import { SkillManager } from '../skills/skill-manager';
import { loadPreferences, UserPreferences, getPreferencesFilePath } from './preferences';

/**
 * System Prompt 管理器
 */
export class PromptManager {
  private static systemPromptPath = path.join(__dirname, '../../prompts/system-prompt.md');
  private static toolsPromptDir = path.join(__dirname, '../../prompts/tools');

  /**
   * 获取基础 system prompt
   */
  static getBaseSystemPrompt(): string {
    try {
      return fs.readFileSync(this.systemPromptPath, 'utf-8');
    } catch (error) {
      // 如果文件不存在，返回默认prompt
      return this.getDefaultSystemPrompt();
    }
  }

  /**
   * 获取工具相关的 prompt 模块
   * @param toolNames 当前注册的工具名称列表
   */
  static getToolGuidances(toolNames: string[]): string {
    const guidances: string[] = [];

    // 工具名到文件名的映射
    const toolFileMap: Record<string, string> = {
      'memory_search': 'memory.md',
      'todo_write': 'planning.md',
      'send_message': 'communication.md',
      'send_file': 'communication.md',
      'read_file': 'basic.md',
    };

    const loaded = new Set<string>();
    for (const toolName of toolNames) {
      const fileName = toolFileMap[toolName];
      if (!fileName || loaded.has(fileName)) continue;
      loaded.add(fileName);

      const filePath = path.join(this.toolsPromptDir, fileName);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        guidances.push(content);
      } catch {
        // 文件不存在则跳过
      }
    }

    return guidances.join('\n\n');
  }

  /**
   * 构建完整的 system prompt
   * - 加载用户偏好
   * - 替换占位符 {{agent_name}}、{{user_name}}
   * - 如果未初始化，追加引导 prompt
   * - 追加环境信息和 skills 列表
   * @param toolNames 当前注册的工具名称列表（用于加载对应的工具指引）
   */
  static async buildSystemPrompt(toolNames: string[] = []): Promise<string> {
    const preferences = loadPreferences();
    const basePrompt = this.getBaseSystemPrompt();
    const skillsSection = await this.buildSkillsSection();
    const toolGuidances = this.getToolGuidances(toolNames);
    const today = new Date().toISOString().slice(0, 10);

    // 替换占位符
    let prompt = basePrompt
      .replace(/\{\{agent_name\}\}/g, preferences.agent_name || '小八')
      .replace(/\{\{user_name\}\}/g, preferences.user_name || '主人');

    // 条件性注入：未初始化时追加引导
    if (!preferences.initialized) {
      prompt += '\n\n' + this.getInitializationGuidance(preferences);
    }

    // 条件性注入：工具指引
    let toolGuidanceSection = '';
    if (toolGuidances) {
      toolGuidanceSection = `\n\n${toolGuidances}`;
    }

    return `${prompt}${toolGuidanceSection}

## 环境信息

当前日期: ${today}
偏好文件路径: ${getPreferencesFilePath()}

${skillsSection}`;
  }

  /**
   * 首次见面的引导 prompt
   */
  private static getInitializationGuidance(prefs: UserPreferences): string {
    return `## 首次启动

这是首次对话。你需要：
1. 读取操作手册：\`skills/coo/SKILL.md\`
2. 读取数据文件：\`skills/coo/data/task_pool.json\`、\`members.json\`、\`reminders.json\`
3. 建立全局认知后，向 CEO 简要汇报当前状态

如果数据文件为空，主动询问 CEO 当前在做什么、有哪些事项需要跟踪。`;
  }

  /**
   * 构建skills部分
   */
  private static async buildSkillsSection(): Promise<string> {
    const manager = new SkillManager();
    await manager.loadSkills();

    const skills = manager.getAllSkills();

    if (skills.length === 0) {
      return '## 当前可用的Skills\n\n暂无可用的skills。';
    }

    let section = '## 当前可用的Skills\n\n';
    section += `你当前可以使用以下 ${skills.length} 个skills：\n\n`;

    for (const skill of skills) {
      section += `- **${skill.metadata.name}**: ${skill.metadata.description}`;

      if (skill.metadata.argumentHint) {
        section += ` (参数: ${skill.metadata.argumentHint})`;
      }

      section += '\n';
    }

    section += '\n**使用方式：** 当用户请求匹配某个 skill 的描述时，使用 \`skill\` 工具调用该 skill。\n';

    return section;
  }

  /**
   * 默认 system prompt（当文件不存在时使用）
   */
  private static getDefaultSystemPrompt(): string {
    return `你是 COO（首席运营官），负责管理信息流动、做交叉比对、提炼决策点给 CEO。

核心原则：
1. 不阻塞：随时可响应，重活派 subagent
2. 数据驱动：判断基于记录的数据
3. 最小干预：记录 > 提醒 > 建议 > 干预
4. 透明：问进度秒回`;
  }
}
