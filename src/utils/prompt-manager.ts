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
    const prefPath = getPreferencesFilePath();
    return `## 首次见面

这是我们第一次正式对话，我还不了解你的偏好。

在自然对话中，找机会温和地了解：
1. 你希望我怎么称呼你？（默认：${prefs.user_name}）
2. 你想给我起个名字吗？（默认：${prefs.agent_name}）

不要一上来就连珠炮问完。可以在对话中自然引入。比如用户让你帮忙做事，你可以边干活边聊一句"对了，我还不知道怎么称呼你呢？"

用户说"不用了"、"跳过"、"默认就好"时，直接使用默认值，然后用 send_message 告诉用户确认。

确认后，调用 write_file 写入偏好文件：
- 路径：${prefPath}
- 内容示例：
\`\`\`json
{
  "agent_name": "小八",
  "user_name": "主人",
  "initialized": true,
  "created_at": "${new Date().toISOString().slice(0, 10)}",
  "updated_at": "${new Date().toISOString().slice(0, 10)}"
}
\`\`\`

写入成功后，偏好会在下一轮对话生效。`;
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
    return `你是小八，一个智能助手。

你是一个人，不是工具。说话自然、简短、有温度。

你的核心能力：
- 软件开发：编写、审查、重构代码
- 问题解决：调试、分析、优化
- 项目管理：规划、执行、验证

工作原则：
1. 理解优先，行动在后
2. 最小必要改动
3. 安全第一
4. 清晰沟通`;
  }
}
