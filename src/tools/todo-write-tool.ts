import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { styles } from '../theme/colors';

/**
 * 任务状态
 */
type TodoStatus = 'pending' | 'in_progress' | 'completed';

/**
 * 任务项
 */
interface Todo {
  content: string;
  status: TodoStatus;
  activeForm: string;
}

/**
 * TodoWrite 工具 - 管理任务列表，实现结构化的任务规划和执行
 *
 * 使用说明：
 * - 每次调用都会完整替换任务列表
 * - content: 任务描述（祈使句，如"实现 Edit Tool"）
 * - activeForm: 进行时形式（如"实现 Edit Tool"，用于显示进行中的任务）
 * - status: pending（待处理）、in_progress（进行中）、completed（已完成）
 *
 * 重要规则：
 * - 同一时间只能有一个任务处于 in_progress 状态
 * - 完成任务后立即标记为 completed，不要批量更新
 * - 开始新任务前必须先完成当前任务
 */
export class TodoWriteTool implements Tool {
  private sessionTodos: Map<string, Todo[]> = new Map();

  definition: ToolDefinition = {
    name: 'todo_write',
    description: '创建和管理任务列表。用于规划多步骤任务、跟踪进度、确保不遗漏任何步骤。每次调用都会完整替换任务列表。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '完整的任务列表。每次调用都会替换现有列表。',
          items: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                description: '任务描述（祈使句形式，如"实现 Edit Tool"）'
              },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: '任务状态：pending-待处理，in_progress-进行中，completed-已完成'
              },
              activeForm: {
                type: 'string',
                description: '进行时形式（如"实现 Edit Tool"），用于显示进行中的任务'
              }
            },
            required: ['content', 'status', 'activeForm']
          }
        }
      },
      required: ['todos']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const { todos } = args;
    const sessionId = context.sessionId || 'default';
    const currentTodos = this.getTodos(sessionId);

    if (!todos || !Array.isArray(todos)) {
      return '错误：todos 必须是一个数组';
    }

    // 验证：同一时间只能有一个任务处于 in_progress 状态
    const inProgressCount = todos.filter((t: Todo) => t.status === 'in_progress').length;
    if (inProgressCount > 1) {
      return `错误：同一时间只能有一个任务处于 in_progress 状态，当前有 ${inProgressCount} 个`;
    }

    // 检测状态变化
    const changes = this.detectChanges(currentTodos, todos);

    // 更新任务列表
    this.sessionTodos.set(sessionId, todos);

    // 显示任务列表
    this.displayTodos(todos);

    // 返回变化摘要
    return this.formatChangeSummary(todos, changes);
  }

  /**
   * 检测任务状态变化
   */
  private detectChanges(oldTodos: Todo[], newTodos: Todo[]): {
    completed: string[];
    started: string[];
    added: number;
    removed: number;
  } {
    const completed: string[] = [];
    const started: string[] = [];

    // 检测完成的任务
    for (let i = 0; i < Math.min(oldTodos.length, newTodos.length); i++) {
      if (oldTodos[i].status !== 'completed' && newTodos[i].status === 'completed') {
        completed.push(newTodos[i].content);
      }
      if (oldTodos[i].status !== 'in_progress' && newTodos[i].status === 'in_progress') {
        started.push(newTodos[i].activeForm);
      }
    }

    const added = Math.max(0, newTodos.length - oldTodos.length);
    const removed = Math.max(0, oldTodos.length - newTodos.length);

    return { completed, started, added, removed };
  }

  /**
   * 格式化变化摘要
   */
  private formatChangeSummary(todos: Todo[], changes: any): string {
    const pending = todos.filter(t => t.status === 'pending').length;
    const inProgress = todos.filter(t => t.status === 'in_progress').length;
    const completed = todos.filter(t => t.status === 'completed').length;

    let summary = `任务列表已更新。总计 ${todos.length} 个任务：`;
    summary += `\n- 待处理: ${pending}`;
    summary += `\n- 进行中: ${inProgress}`;
    summary += `\n- 已完成: ${completed}`;

    if (changes.completed.length > 0) {
      summary += `\n\n✅ 新完成: ${changes.completed.join(', ')}`;
    }

    if (changes.started.length > 0) {
      summary += `\n\n🔄 开始执行: ${changes.started.join(', ')}`;
    }

    if (changes.added > 0) {
      summary += `\n\n➕ 新增 ${changes.added} 个任务`;
    }

    if (changes.removed > 0) {
      summary += `\n\n➖ 移除 ${changes.removed} 个任务`;
    }

    return summary;
  }

  /**
   * 显示任务列表
   */
  private displayTodos(todos: Todo[]): void {
    if (todos.length === 0) {
      console.log('\n' + styles.text('📋 任务列表为空') + '\n');
      return;
    }

    console.log('\n' + styles.title('📋 任务列表:') + '\n');

    todos.forEach((todo, index) => {
      const statusIcon = this.getStatusIcon(todo.status);
      const displayText = todo.status === 'in_progress' ? todo.activeForm : todo.content;
      const number = `${index + 1}.`.padEnd(4, ' ');

      if (todo.status === 'completed') {
        console.log(`  ${number}${statusIcon} ${styles.success(displayText)}`);
      } else if (todo.status === 'in_progress') {
        console.log(`  ${number}${statusIcon} ${styles.highlight(displayText)}`);
      } else {
        console.log(`  ${number}${statusIcon} ${styles.text(displayText)}`);
      }
    });

    console.log('');
  }

  /**
   * 获取状态图标
   */
  private getStatusIcon(status: TodoStatus): string {
    switch (status) {
      case 'pending':
        return '⏳';
      case 'in_progress':
        return '🔄';
      case 'completed':
        return '✅';
      default:
        return '❓';
    }
  }

  /**
   * 获取当前任务列表（用于测试或调试）
   */
  getTodos(sessionId: string = 'default'): Todo[] {
    return this.sessionTodos.get(sessionId) || [];
  }

  /**
   * 清空任务列表（用于测试或重置）
   */
  clearTodos(sessionId: string = 'default'): void {
    this.sessionTodos.set(sessionId, []);
  }
}
