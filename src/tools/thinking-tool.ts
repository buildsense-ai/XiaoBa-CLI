import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { Logger } from '../utils/logger';

export class ThinkingTool implements Tool {
  private callCount = 0;

  definition: ToolDefinition = {
    name: 'thinking',
    description: `内部推理工具，记录思考过程（用户看不到）。

此工具为非原生思考模型提供思考缓冲空间。每次调用相当于给自己一个深度思考的机会。

每次调用应包含：
1. 批判性分析：当前情况有什么问题？有什么不确定的地方？
2. 行动计划：接下来要做什么？按什么顺序？

好的thinking示例：
"当前：用户报告图片上传失败，错误是content.map not a function。
关键问题：content可能不是数组，需要看read_file返回值的结构。
计划：1) 读取read_file工具代码 2) 找到返回图片时的数据结构 3) 修复调用方"

坏的thinking示例（避免）：
"用户说图片上传失败了。我需要分析这个问题。这个问题可能是因为..."（重复描述问题，没有推进）

规则：
- 每次thinking必须比上一次有新的推进，不要重复已分析的内容
- thinking内容可以详尽，不需要简洁
- thinking不会发给用户，保留在历史中供自己回顾`,

    transcriptMode: 'default',

    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '思考内容',
        },
      },
      required: ['content'],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const { content } = args;

    if (!content || typeof content !== 'string') {
      return '思考内容不能为空';
    }

    this.callCount++;
    Logger.info(`[thinking #${this.callCount}] ${content.slice(0, 200)}${content.length > 200 ? '...' : ''}`);

    return `已思考 #${this.callCount} 次`;
  }
}
