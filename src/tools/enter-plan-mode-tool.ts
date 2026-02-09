import * as fs from 'fs';
import * as path from 'path';
import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { styles } from '../theme/colors';

/**
 * EnterPlanMode 工具 - 进入规划模式
 *
 * 用于复杂任务的规划阶段。在规划模式下，AI 可以：
 * - 探索代码库结构
 * - 设计实施方案
 * - 制定详细的步骤
 * - 识别潜在风险
 *
 * 规划完成后，使用 ExitPlanMode 工具请求用户批准。
 */
export class EnterPlanModeTool implements Tool {
  private static planFilePath: string = '';
  private static inPlanMode: boolean = false;

  definition: ToolDefinition = {
    name: 'enter_plan_mode',
    description: '进入规划模式。用于复杂任务的规划阶段，在执行前制定详细的实施计划。规划完成后使用 exit_plan_mode 请求用户批准。',
    parameters: {
      type: 'object',
      properties: {
        task_description: {
          type: 'string',
          description: '任务描述，简要说明要规划的任务'
        },
        plan_file: {
          type: 'string',
          description: '规划文件路径（可选，默认为 .xiaoba/plan.md）'
        }
      },
      required: ['task_description']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const { task_description, plan_file = '.xiaoba/plan.md' } = args;

    try {
      // 解析文件路径
      const absolutePath = path.isAbsolute(plan_file)
        ? plan_file
        : path.join(context.workingDirectory, plan_file);

      // 确保目录存在
      const dir = path.dirname(absolutePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // 创建规划文件模板
      const planTemplate = this.createPlanTemplate(task_description);
      fs.writeFileSync(absolutePath, planTemplate, 'utf-8');

      // 更新状态
      EnterPlanModeTool.planFilePath = absolutePath;
      EnterPlanModeTool.inPlanMode = true;

      console.log('\n' + styles.title('📋 已进入规划模式') + '\n');
      console.log(styles.text(`任务: ${task_description}`));
      console.log(styles.text(`规划文件: ${plan_file}\n`));

      return `已进入规划模式。\n任务: ${task_description}\n规划文件: ${plan_file}\n\n请开始制定详细的实施计划。完成后使用 exit_plan_mode 工具请求用户批准。`;
    } catch (error: any) {
      return `进入规划模式失败: ${error.message}`;
    }
  }

  /**
   * 创建规划文件模板
   */
  private createPlanTemplate(taskDescription: string): string {
    const timestamp = new Date().toISOString();

    return `# 实施计划

**任务**: ${taskDescription}
**创建时间**: ${timestamp}
**状态**: 规划中

---

## 1. 任务分析

### 1.1 目标
<!-- 描述要实现的目标 -->

### 1.2 当前状态
<!-- 描述当前系统的状态 -->

### 1.3 预期结果
<!-- 描述完成后的预期结果 -->

---

## 2. 技术方案

### 2.1 架构设计
<!-- 描述整体架构设计 -->

### 2.2 关键技术点
<!-- 列出关键技术点和实现方法 -->

### 2.3 依赖关系
<!-- 列出需要的依赖包或外部资源 -->

---

## 3. 实施步骤

### 步骤 1: [步骤名称]
- **目标**:
- **操作**:
- **验证**:

### 步骤 2: [步骤名称]
- **目标**:
- **操作**:
- **验证**:

<!-- 添加更多步骤 -->

---

## 4. 风险评估

### 4.1 潜在风险
<!-- 列出潜在风险 -->

### 4.2 缓解措施
<!-- 描述风险缓解措施 -->

---

## 5. 验收标准

- [ ] 标准 1
- [ ] 标准 2
- [ ] 标准 3

---

## 6. 时间估算

<!-- 估算各步骤所需时间（可选） -->

---

**备注**:
<!-- 其他需要说明的内容 -->
`;
  }

  /**
   * 获取当前规划文件路径
   */
  static getPlanFilePath(): string {
    return EnterPlanModeTool.planFilePath;
  }

  /**
   * 检查是否处于规划模式
   */
  static isInPlanMode(): boolean {
    return EnterPlanModeTool.inPlanMode;
  }

  /**
   * 退出规划模式（由 ExitPlanMode 调用）
   */
  static exitPlanMode(): void {
    EnterPlanModeTool.inPlanMode = false;
    EnterPlanModeTool.planFilePath = '';
  }
}
