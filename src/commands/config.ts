import inquirer from 'inquirer';
import { Logger } from '../utils/logger';
import { ConfigManager } from '../utils/config';
import { createCatsCoLocalConfigService } from '../catscompany/local-config';
import { createBotDefinitionSyncService } from '../bot-definition/service';
import { PathResolver } from '../utils/path-resolver';
import { styles } from '../theme/colors';

export async function configCommand(): Promise<void> {
  Logger.title('CatsCo 配置');

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

  const runtimeRoot = PathResolver.getRuntimeDataRoot();
  const botId = String(createCatsCoLocalConfigService({ runtimeRoot }).load().currentBot?.uid || '').trim();
  if (botId) {
    const provider = currentConfig.provider === 'anthropic' ? 'anthropic' : 'openai';
    createBotDefinitionSyncService({ runtimeRoot }).publish(botId, {
      kind: 'custom',
      protocol: provider === 'anthropic'
        ? 'anthropic'
        : currentConfig.openaiApiMode === 'responses' ? 'openai-responses' : 'openai-chat-completions',
      apiBase: finalConfig.apiUrl,
      model: finalConfig.model,
      apiKey: finalConfig.apiKey,
      contextWindowTokens: currentConfig.contextWindowTokens ?? 200_000,
      ...(currentConfig.maxTokens ? { maxTokens: currentConfig.maxTokens } : {}),
      ...(typeof finalConfig.temperature === 'number' ? { temperature: finalConfig.temperature } : {}),
      ...(currentConfig.reasoningEffort ? { reasoningEffort: currentConfig.reasoningEffort } : {}),
    });
  } else {
    ConfigManager.saveConfig(finalConfig);
  }
  Logger.success('配置已保存！');
}
