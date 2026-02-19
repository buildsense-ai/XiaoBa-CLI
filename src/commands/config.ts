import inquirer from 'inquirer';
import { Logger } from '../utils/logger';
import { ConfigManager } from '../utils/config';
import { styles } from '../theme/colors';

export async function configCommand(): Promise<void> {
  Logger.title('XiaoBa 配置');

  const currentConfig = ConfigManager.getConfig();

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'apiUrl',
      message: styles.text('API地址:'),
      default: currentConfig.apiUrl,
      prefix: styles.highlight('?'),
    },
    {
      type: 'input',
      name: 'apiKey',
      message: styles.text('API密钥:'),
      default: currentConfig.apiKey || '',
      prefix: styles.highlight('?'),
    },
    {
      type: 'input',
      name: 'model',
      message: styles.text('模型名称:'),
      default: currentConfig.model,
      prefix: styles.highlight('?'),
    },
    {
      type: 'number',
      name: 'temperature',
      message: styles.text('温度参数 (0-2):'),
      default: currentConfig.temperature,
      prefix: styles.highlight('?'),
    },
    {
      type: 'confirm',
      name: 'memoryEnabled',
      message: styles.text('启用记忆系统 (GauzMem):'),
      default: currentConfig.memory?.enabled || false,
      prefix: styles.highlight('?'),
    },
  ]);

  // 如果启用记忆系统，询问详细配置
  let memoryConfig = currentConfig.memory;
  if (answers.memoryEnabled) {
    const memoryAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'baseUrl',
        message: styles.text('记忆系统地址:'),
        default: currentConfig.memory?.baseUrl || 'http://localhost:1235',
        prefix: styles.highlight('?'),
      },
      {
        type: 'input',
        name: 'projectId',
        message: styles.text('项目ID:'),
        default: currentConfig.memory?.projectId || 'XiaoBa',
        prefix: styles.highlight('?'),
      },
      {
        type: 'input',
        name: 'userId',
        message: styles.text('用户ID:'),
        default: currentConfig.memory?.userId || '',
        prefix: styles.highlight('?'),
      },
      {
        type: 'input',
        name: 'agentId',
        message: styles.text('助手ID:'),
        default: currentConfig.memory?.agentId || 'XiaoBa',
        prefix: styles.highlight('?'),
      },
    ]);

    memoryConfig = {
      enabled: true,
      ...memoryAnswers,
    };
  } else {
    memoryConfig = {
      ...currentConfig.memory,
      enabled: false,
    };
  }

  const finalConfig = {
    apiUrl: answers.apiUrl,
    apiKey: answers.apiKey,
    model: answers.model,
    temperature: answers.temperature,
    memory: memoryConfig,
  };

  ConfigManager.saveConfig(finalConfig);
  Logger.success('配置已保存！');
}
