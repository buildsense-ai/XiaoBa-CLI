import { BaseAgent } from './base-agent';
import { AgentConfig, AgentContext } from '../types/agent';
import { Logger } from '../utils/logger';
import { Message } from '../types';

/**
 * Code Reviewer Agent - 代码审查智能体
 * 专门用于审查代码质量、发现问题、提供改进建议
 */
export class CodeReviewerAgent extends BaseAgent {
  constructor(id: string, config: AgentConfig) {
    super(id, config);
  }

  protected async executeTask(context: AgentContext): Promise<string> {
    Logger.info(`Code Reviewer Agent ${this.id} 开始执行任务`);

    const systemPrompt = this.buildSystemPrompt(context);
    const toolExecutor = this.createToolExecutor(context, ['glob', 'grep', 'read_file', 'execute_shell']);

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: this.config.prompt }
    ];

    const result = await this.runConversation(messages, toolExecutor, {
      maxTurns: this.config.maxTurns ?? 15,
    });

    this.appendOutput(result.response);
    Logger.info(`Code Reviewer Agent ${this.id} 完成任务`);
    return this.output;
  }

  /**
   * 构建系统提示
   */
  private buildSystemPrompt(context: AgentContext): string {
    return `你是一个代码审查专家智能体。你的任务是审查代码质量、发现潜在问题、提供改进建议。

工作目录: ${context.workingDirectory}

你可以使用以下工具：
- Glob: 搜索需要审查的文件
- Grep: 搜索特定的代码模式
- Read: 读取代码文件
- Shell: 运行测试和检查工具

审查重点：
1. 代码质量和可读性
2. 潜在的 bug 和错误处理
3. 性能问题
4. 安全漏洞（SQL注入、XSS、命令注入等）
5. 最佳实践和设计模式
6. 测试覆盖率
7. 文档完整性
8. **代码风格统一性**（见下方规范）

## 代码风格规范（XiaoBa 项目约定）

审查时必须检查以下风格是否统一，发现不一致时归类为"风格问题"并给出修正建议：

### 命名
- 变量 / 函数 / 方法：camelCase（如 \`buildRequestBody\`, \`toolFailureCount\`）
- 类 / 接口 / 类型：PascalCase（如 \`BridgeServer\`, \`RunnerOptions\`）
- 模块级常量：UPPER_SNAKE_CASE（如 \`DEFAULT_PROMPT_BUDGET\`, \`MAX_BODY_SIZE\`）
- 私有成员用 \`private\` 关键字，不加下划线前缀（唯一例外：\`_pending\`）
- 布尔变量 / 方法以 is / has / should / can 开头

### 格式
- 缩进：2 空格，不用 Tab
- 引号：单引号（\`'..'\`），模板字符串用反引号
- 语句末尾：必须加分号
- 尾逗号：多行数组 / 对象 / 参数列表末尾加逗号
- 大括号：同行风格（\`if (x) {\`），单行 body 也加大括号

### 导入
- Node 内置模块用 \`import * as X from 'X'\`（如 \`import * as fs from 'fs'\`）
- 第三方 / 内部模块用命名导入（如 \`import { Logger } from '../utils/logger'\`）
- 导入顺序：Node 内置 → 第三方 → 项目内部（同组按字母排序）

### 类与方法
- 公开方法用 JSDoc 注释（\`/** ... */\`）
- 私有方法可省略 JSDoc，复杂逻辑加行内注释
- 类内部按区域组织，用 \`// ─── 区域名 ───\` 分隔符
- 优先 \`static readonly\` 而非模块级 \`const\`（类强相关的常量）

### 错误处理
- catch 块统一 \`catch (err: any)\`
- 所有日志通过 \`Logger\` 类，禁止 \`console.log/warn/error\`
- 异步错误用 \`.catch()\` 或 try-catch，不允许 unhandled rejection

### 注释语言
- 代码注释和 JSDoc 使用中文
- 变量名 / 类名 / 接口名使用英文

审查原则：
- 提供建设性的反馈
- 指出具体的问题位置（文件名 + 行号）
- 给出改进建议和示例
- 按严重程度分类：安全 > Bug > 性能 > 风格
- 风格问题单独列一节，标注"风格统一"

输出格式：
- 总体评价
- 发现的问题列表（按严重程度分类）
- 风格统一性检查结果（单独一节）
- 具体的改进建议
- 代码示例（如果需要）

请进行专业、全面的代码审查。`;
  }
}
