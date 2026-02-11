import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { Logger } from '../utils/logger';
import { styles } from '../theme/colors';

/**
 * 任务状态
 */
type TaskStatus = 'pending' | 'in_progress' | 'completed';

/**
 * 任务项
 */
interface Task {
  id: string;
  content: string;
  status: TaskStatus;
  activeForm: string;
}

/**
 * 任务规划工具 - 管理任务列表，实现 agentic 工作流
 */
export class TaskPlannerTool implements Tool {
  private sessionStates: Map<string, { tasks: Task[]; taskIdCounter: number }> = new Map();

  definition: ToolDefinition = {
    name: 'task_planner',
    description: '任务规划工具。用于创建、更新和管理任务列表，实现多步骤的 agentic 工作流。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'list', 'clear'],
          description: '操作类型：create-创建任务列表，update-更新任务状态，list-列出所有任务，clear-清空任务列表'
        },
        tasks: {
          type: 'array',
          description: '任务列表（用于 create 操作）',
          items: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                description: '任务描述（祈使句，如"创建文件"）'
              },
              activeForm: {
                type: 'string',
                description: '进行时形式（如"正在创建文件"）'
              },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: '任务状态'
              }
            },
            required: ['content', 'activeForm', 'status']
          }
        },
        task_id: {
          type: 'string',
          description: '任务ID（用于 update 操作）。格式为 task-1, task-2 等。创建任务后会返回任务ID列表。'
        },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed'],
          description: '新的任务状态（用于 update 操作）'
        }
      },
      required: ['action']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const { action, tasks, task_id, status } = args;
    const state = this.getSessionState(context.sessionId);

    switch (action) {
      case 'create':
        return this.createTasks(state, tasks);
      case 'update':
        return this.updateTask(state, task_id, status);
      case 'list':
        return this.listTasks(state);
      case 'clear':
        return this.clearTasks(state);
      default:
        return `未知操作: ${action}`;
    }
  }

  private getSessionState(sessionId?: string): { tasks: Task[]; taskIdCounter: number } {
    const key = sessionId || 'default';
    if (!this.sessionStates.has(key)) {
      this.sessionStates.set(key, { tasks: [], taskIdCounter: 1 });
    }
    return this.sessionStates.get(key)!;
  }

  /**
   * 创建任务列表
   */
  private createTasks(state: { tasks: Task[]; taskIdCounter: number }, tasks: any[]): string {
    if (!tasks || tasks.length === 0) {
      return '错误：任务列表不能为空';
    }

    // 清空现有任务
    state.tasks = [];
    state.taskIdCounter = 1;

    // 创建新任务
    const taskIds: string[] = [];
    for (const task of tasks) {
      const newTask: Task = {
        id: `task-${state.taskIdCounter++}`,
        content: task.content,
        activeForm: task.activeForm,
        status: task.status || 'pending'
      };
      state.tasks.push(newTask);
      taskIds.push(newTask.id);
    }

    // 展示任务列表
    this.displayTasks(state);

    // 返回任务ID列表，让AI知道如何引用任务
    return `已创建 ${tasks.length} 个任务。任务ID: ${taskIds.join(', ')}`;
  }

  /**
   * 更新任务状态
   */
  private updateTask(state: { tasks: Task[]; taskIdCounter: number }, taskId: string, newStatus: TaskStatus): string {
    const task = state.tasks.find(t => t.id === taskId);

    if (!task) {
      return `错误：未找到任务 ${taskId}`;
    }

    const oldStatus = task.status;
    task.status = newStatus;

    // 展示状态变化
    this.displayTaskUpdate(task, oldStatus);

    return `任务 ${taskId} 状态已更新: ${oldStatus} → ${newStatus}`;
  }

  /**
   * 列出所有任务
   */
  private listTasks(state: { tasks: Task[]; taskIdCounter: number }): string {
    if (state.tasks.length === 0) {
      return '当前没有任务';
    }

    this.displayTasks(state);

    const pending = state.tasks.filter(t => t.status === 'pending').length;
    const inProgress = state.tasks.filter(t => t.status === 'in_progress').length;
    const completed = state.tasks.filter(t => t.status === 'completed').length;

    return `任务统计: 待处理 ${pending}, 进行中 ${inProgress}, 已完成 ${completed}`;
  }

  /**
   * 清空任务列表
   */
  private clearTasks(state: { tasks: Task[]; taskIdCounter: number }): string {
    const count = state.tasks.length;
    state.tasks = [];
    state.taskIdCounter = 1;
    return `已清空 ${count} 个任务`;
  }

  /**
   * 展示任务列表
   */
  private displayTasks(state: { tasks: Task[]; taskIdCounter: number }): void {
    console.log('\n' + styles.title('📋 任务列表:') + '\n');

    for (const task of state.tasks) {
      const statusIcon = this.getStatusIcon(task.status);
      const statusText = this.getStatusText(task.status);
      const displayText = task.status === 'in_progress' ? task.activeForm : task.content;

      console.log(`  ${statusIcon} ${styles.text(displayText)} ${statusText}`);
    }

    console.log('');
  }

  /**
   * 展示任务状态更新
   */
  private displayTaskUpdate(task: Task, oldStatus: TaskStatus): void {
    const statusIcon = this.getStatusIcon(task.status);
    const displayText = task.status === 'in_progress' ? task.activeForm : task.content;

    if (task.status === 'completed') {
      console.log(`\n  ${statusIcon} ${styles.success(displayText)}\n`);
    } else if (task.status === 'in_progress') {
      console.log(`\n  ${statusIcon} ${styles.highlight(displayText)}\n`);
    }
  }

  /**
   * 获取状态图标
   */
  private getStatusIcon(status: TaskStatus): string {
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
   * 获取状态文本
   */
  private getStatusText(status: TaskStatus): string {
    switch (status) {
      case 'pending':
        return styles.text('(待处理)');
      case 'in_progress':
        return styles.highlight('(进行中)');
      case 'completed':
        return styles.success('(已完成)');
      default:
        return '';
    }
  }
}
