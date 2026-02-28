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
  ]);

  const finalConfig = {
    apiUrl: answers.apiUrl,
    apiKey: answers.apiKey,
    model: answers.model,
    temperature: answers.temperature,
  };

  ConfigManager.saveConfig(finalConfig);
  Logger.success('配置已保存！');
}
