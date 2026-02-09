import * as readline from 'readline';
import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { styles } from '../theme/colors';

/**
 * 问题选项
 */
interface QuestionOption {
  label: string;
  description: string;
}

/**
 * 问题定义
 */
interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/**
 * AskUserQuestion 工具 - 交互式提问
 *
 * 用于在执行过程中向用户提问，获取用户的选择或输入。
 * 支持单选和多选模式。
 */
export class AskUserQuestionTool implements Tool {
  definition: ToolDefinition = {
    name: 'ask_user_question',
    description: '向用户提问并获取答案。用于在执行过程中需要用户决策、选择方案或提供信息时。支持单选和多选模式。',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: '要问的问题列表（1-4个问题）',
          items: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: '完整的问题文本，应该清晰具体，以问号结尾'
              },
              header: {
                type: 'string',
                description: '问题的简短标签（最多12个字符），如"认证方法"、"库选择"'
              },
              options: {
                type: 'array',
                description: '可选答案列表（2-4个选项）',
                items: {
                  type: 'object',
                  properties: {
                    label: {
                      type: 'string',
                      description: '选项的显示文本（1-5个词）'
                    },
                    description: {
                      type: 'string',
                      description: '选项的详细说明，解释选择此项的含义或后果'
                    }
                  },
                  required: ['label', 'description']
                }
              },
              multiSelect: {
                type: 'boolean',
                description: '是否允许多选（默认 false）',
                default: false
              }
            },
            required: ['question', 'header', 'options', 'multiSelect']
          }
        }
      },
      required: ['questions']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const { questions } = args;

    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return '错误：questions 必须是一个非空数组';
    }

    if (questions.length > 4) {
      return '错误：一次最多只能问 4 个问题';
    }

    try {
      const answers: Record<string, string | string[]> = {};

      for (let i = 0; i < questions.length; i++) {
        const question = questions[i];
        const answer = await this.askQuestion(question, i + 1, questions.length);
        answers[`question_${i + 1}`] = answer;
      }

      return this.formatAnswers(questions, answers);
    } catch (error: any) {
      return `提问失败: ${error.message}`;
    }
  }

  /**
   * 向用户提问单个问题
   */
  private async askQuestion(
    question: Question,
    index: number,
    total: number
  ): Promise<string | string[]> {
    console.log('\n' + styles.title(`❓ 问题 ${index}/${total}: ${question.header}`) + '\n');
    console.log(styles.text(question.question) + '\n');

    // 显示选项
    question.options.forEach((option, i) => {
      console.log(styles.highlight(`  ${i + 1}. ${option.label}`));
      console.log(styles.text(`     ${option.description}\n`));
    });

    // 添加"其他"选项
    const otherIndex = question.options.length + 1;
    console.log(styles.highlight(`  ${otherIndex}. 其他`));
    console.log(styles.text(`     自定义输入\n`));

    // 获取用户输入
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const prompt = question.multiSelect
      ? `请选择（多选，用逗号分隔，如 1,3）: `
      : `请选择（输入数字）: `;

    const answer = await new Promise<string>((resolve) => {
      rl.question(styles.highlight(prompt), (input) => {
        rl.close();
        resolve(input.trim());
      });
    });

    // 解析答案
    if (question.multiSelect) {
      const selections = answer.split(',').map(s => s.trim());
      const results: string[] = [];

      for (const selection of selections) {
        const num = parseInt(selection);
        if (num === otherIndex) {
          const customInput = await this.getCustomInput();
          results.push(customInput);
        } else if (num >= 1 && num <= question.options.length) {
          results.push(question.options[num - 1].label);
        }
      }

      return results;
    } else {
      const num = parseInt(answer);
      if (num === otherIndex) {
        return await this.getCustomInput();
      } else if (num >= 1 && num <= question.options.length) {
        return question.options[num - 1].label;
      } else {
        return '无效选择';
      }
    }
  }

  /**
   * 获取自定义输入
   */
  private async getCustomInput(): Promise<string> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise<string>((resolve) => {
      rl.question(styles.highlight('请输入自定义内容: '), (input) => {
        rl.close();
        resolve(input.trim());
      });
    });
  }

  /**
   * 格式化答案
   */
  private formatAnswers(
    questions: Question[],
    answers: Record<string, string | string[]>
  ): string {
    let result = '用户回答:\n\n';

    questions.forEach((question, i) => {
      const answer = answers[`question_${i + 1}`];
      result += `${question.header}: `;

      if (Array.isArray(answer)) {
        result += answer.join(', ');
      } else {
        result += answer;
      }

      result += '\n';
    });

    return result;
  }
}
