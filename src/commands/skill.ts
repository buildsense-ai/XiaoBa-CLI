import { Command } from 'commander';
import { Logger } from '../utils/logger';
import { styles } from '../theme/colors';
import { SkillManager } from '../skills/skill-manager';
import { PathResolver } from '../utils/path-resolver';
import { execSync } from 'child_process';
import chalk from 'chalk';
import * as path from 'path';
import * as fs from 'fs';
import inquirer from 'inquirer';
import { withBotSkillWorkspaceLock } from '../bot-skills/workspace-lock';
import { notifyBotSkillMutation } from '../bot-skills/mutation-events';
import {
  BotSkillRuntime,
  isBotSkillRuntimeEnabled,
  resolveBotSkillRuntimeTransport,
} from '../bot-skills/runtime';
import { createCatsCoLocalConfigService } from '../catscompany/local-config';

/**
 * Skill 命令处理器
 */
export function registerSkillCommand(program: Command): void {
  const skillCmd = program
    .command('skill')
    .description('管理 CatsCo skills');

  // skill list - 列出所有可用的 skills
  skillCmd
    .command('list')
    .description('列出所有可用的 skills')
    .action(async () => {
      await listSkills();
    });

  // skill install - 安装 npm 包形式的 skill
  skillCmd
    .command('install <package>')
    .description('安装 npm 包形式的 skill')
    .option('-g, --global', '全局安装')
    .action(async (packageName: string, options: { global?: boolean }) => {
      await installSkill(packageName, options.global);
    });

  // skill info - 查看 skill 详情
  skillCmd
    .command('info <name>')
    .description('查看 skill 详情')
    .action(async (name: string) => {
      await showSkillInfo(name);
    });

  // skill install-github - 从 GitHub 安装 skill
  skillCmd
    .command('install-github <repo>')
    .description('从 GitHub 仓库安装 skill (格式: owner/repo)')
    .action(async (repo: string) => {
      await installGithubSkill(repo);
    });

  // skill remove - 移除 skill
  skillCmd
    .command('remove <name>')
    .description('移除已安装的 skill')
    .option('-f, --force', '强制移除，不询问确认')
    .option('--npm', '移除 npm 包形式的 skill')
    .action(async (name: string, options: { force?: boolean; npm?: boolean }) => {
      await removeSkill(name, options);
    });

  skillCmd
    .command('sync-repair <strategy>')
    .description('Repair a missing/corrupt Bot Skill sync Base with local-wins or cloud-wins')
    .option('-f, --force', 'Apply the selected repair strategy without confirmation')
    .action(async (
      strategy: string,
      options: { force?: boolean },
    ) => {
      await repairBotSkillSync(strategy, options.force);
    });
}

/**
 * 列出所有可用的 skills
 */
async function listSkills(): Promise<void> {
  Logger.title('可用的 Skills');

  const manager = new SkillManager();
  await manager.loadSkills();

  const skills = manager.getAllSkills();

  if (skills.length === 0) {
    Logger.warning('没有找到任何 skill');
    Logger.info('\n提示：');
    Logger.info(`  - 将 skill 放在 ${styles.code('skills/')} 目录`);
    Logger.info('  - 或使用命令安装: catsco skill install-github owner/repo');
    return;
  }

  Logger.info(`\n找到 ${styles.highlight(skills.length.toString())} 个 skill:\n`);

  for (const skill of skills) {
    const invocable = [];
    if (skill.metadata.userInvocable) invocable.push('用户调用');

    Logger.info(`${styles.highlight('●')} ${styles.highlight(skill.metadata.name)}`);
    Logger.info(`  ${chalk.gray('描述:')} ${skill.metadata.description}`);
    if (skill.metadata.argumentHint) {
      Logger.info(`  ${chalk.gray('参数:')} ${skill.metadata.argumentHint}`);
    }
    Logger.info(`  ${chalk.gray('调用:')} ${invocable.join(', ')}`);
    Logger.info(`  ${chalk.gray('路径:')} ${skill.filePath}`);
    Logger.info('');
  }
}

/**
 * 安装 npm 包形式的 skill
 */
async function installSkill(packageName: string, global?: boolean): Promise<void> {
  Logger.title(`安装 Skill: ${packageName}`);

  // 确保包名符合规范
  if (!packageName.startsWith('@xiaoba-skills/') && !packageName.includes('/')) {
    packageName = `@xiaoba-skills/${packageName}`;
  }

  try {
    const installCmd = global
      ? `npm install -g ${packageName}`
      : `npm install ${packageName}`;

    Logger.info(`执行: ${chalk.gray(installCmd)}\n`);

    // 执行安装命令
    execSync(installCmd, {
      stdio: 'inherit',
      cwd: process.cwd()
    });

    Logger.success(`\n✓ Skill ${styles.highlight(packageName)} 安装成功！`);
    Logger.info('\n使用 catsco skill list 查看已安装的 skills');
  } catch (error: any) {
    Logger.error(`安装失败: ${error.message}`);
    process.exit(1);
  }
}

/**
 * 显示 skill 详细信息
 */
async function showSkillInfo(name: string): Promise<void> {
  const manager = new SkillManager();
  await manager.loadSkills();

  const skill = manager.getSkill(name);

  if (!skill) {
    Logger.error(`未找到 skill: ${name}`);
    Logger.info('\n使用 catsco skill list 查看所有可用的 skills');
    process.exit(1);
  }

  Logger.title(`Skill 详情: ${skill.metadata.name}`);

  Logger.info(`\n${chalk.gray('名称:')} ${styles.highlight(skill.metadata.name)}`);
  Logger.info(`${chalk.gray('描述:')} ${skill.metadata.description}`);

  if (skill.metadata.argumentHint) {
    Logger.info(`${chalk.gray('参数提示:')} ${skill.metadata.argumentHint}`);
  }

  Logger.info(`${chalk.gray('用户可调用:')} ${skill.metadata.userInvocable ? '是' : '否'}`);
  Logger.info(`${chalk.gray('文件路径:')} ${skill.filePath}`);

  Logger.info(`\n${chalk.gray('提示词内容:')}`);
  Logger.info(chalk.gray('─'.repeat(50)));
  Logger.info(skill.content);
  Logger.info(chalk.gray('─'.repeat(50)));
}

/**
 * 从 GitHub 安装 skill
 */
async function installGithubSkill(repo: string): Promise<void> {
  Logger.title(`从 GitHub 安装 Skill: ${repo}`);

  // 解析仓库地址
  const repoMatch = repo.match(/^([^\/]+)\/([^\/]+)$/);
  if (!repoMatch) {
    Logger.error('仓库地址格式错误，应为: owner/repo');
    Logger.info('例如: obra/superpowers');
    process.exit(1);
  }

  const [, owner, repoName] = repoMatch;
  const githubUrl = `https://github.com/${owner}/${repoName}.git`;

  // 统一安装到 ~/.xiaoba/skills/
  const targetDir = PathResolver.getSkillsPath();
  const expectedRuntime = currentCliBotSkillRuntime(targetDir);

  const skillPath = path.join(targetDir, repoName);

  // 检查目录是否已存在
  if (fs.existsSync(skillPath)) {
    Logger.warning(`Skill 目录已存在: ${skillPath}`);
    Logger.info('如需重新安装，请先删除该目录');
    process.exit(1);
  }

  try {
    Logger.info(`\n克隆仓库: ${chalk.gray(githubUrl)}`);
    Logger.info(`目标目录: ${chalk.gray(skillPath)} (项目 skills 目录)\n`);

    // 克隆仓库
    await withBotSkillWorkspaceLock(targetDir, async () => {
      assertCliBotSkillOwnerUnchanged(expectedRuntime, targetDir);
      PathResolver.ensureDir(targetDir);
      if (fs.existsSync(skillPath)) {
        const error: any = new Error(`Skill directory already exists: ${skillPath}`);
        error.code = 'SKILL_ALREADY_EXISTS';
        throw error;
      }
      execSync(`git clone ${githubUrl} "${skillPath}"`, {
        stdio: 'inherit',
        cwd: targetDir,
      });
    });
    await notifyAndSyncBotSkills(targetDir);

    Logger.success(`\n✓ Skill ${styles.highlight(repoName)} 安装成功！`);
    Logger.info(`安装位置: ${skillPath}`);
    Logger.info('\n使用 catsco skill list 查看已安装的 skills');
  } catch (error: any) {
    Logger.error(`安装失败: ${error.message}`);

    // 清理失败的安装
    if (fs.existsSync(skillPath)) {
      try {
        await withBotSkillWorkspaceLock(targetDir, async () => {
          assertCliBotSkillOwnerUnchanged(expectedRuntime, targetDir);
          fs.rmSync(skillPath, { recursive: true, force: true });
        });
      } catch (cleanupError) {
        // 忽略清理错误
      }
    }

    process.exit(1);
  }
}

/**
 * 移除 skill
 */
async function removeSkill(
  name: string,
  options: { force?: boolean; npm?: boolean }
): Promise<void> {
  Logger.title(`移除 Skill: ${name}`);

  if (options.npm) {
    await removeNpmSkill(name, options.force);
    return;
  }

  await removeLocalSkill(name, options.force);
}

/**
 * 移除 npm 包形式的 skill
 */
async function removeNpmSkill(packageName: string, force?: boolean): Promise<void> {
  if (!packageName.startsWith('@xiaoba-skills/') && !packageName.includes('/')) {
    packageName = `@xiaoba-skills/${packageName}`;
  }

  try {
    execSync(`npm list ${packageName}`, { stdio: 'ignore' });
  } catch (error) {
    Logger.error(`Skill ${styles.highlight(packageName)} 未安装`);
    process.exit(1);
  }

  if (!force) {
    const { confirmed } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmed',
        message: `确定要移除 npm 包 ${chalk.yellow(packageName)} 吗？`,
        default: false,
      },
    ]);

    if (!confirmed) {
      Logger.info('已取消移除');
      return;
    }
  }

  try {
    Logger.info(`\n执行: ${chalk.gray(`npm uninstall ${packageName}`)}\n`);
    execSync(`npm uninstall ${packageName}`, { stdio: 'inherit', cwd: process.cwd() });
    Logger.success(`\n✓ Skill ${styles.highlight(packageName)} 已成功移除！`);
  } catch (error: any) {
    Logger.error(`移除失败: ${error.message}`);
    process.exit(1);
  }
}

/**
 * 移除本地 skill
 */
async function removeLocalSkill(name: string, force?: boolean): Promise<void> {
  const skillsRoot = PathResolver.getSkillsPath();
  const expectedRuntime = currentCliBotSkillRuntime(skillsRoot);
  const manager = new SkillManager();
  await manager.loadSkills();
  const skill = manager.getSkill(name);

  if (!skill) {
    Logger.error(`未找到 skill: ${name}`);
    Logger.info('\n使用 catsco skill list 查看所有可用的 skills');
    process.exit(1);
  }

  const skillDir = path.dirname(skill.filePath);

  Logger.info(`\n${chalk.gray('名称:')} ${styles.highlight(skill.metadata.name)}`);
  Logger.info(`${chalk.gray('描述:')} ${skill.metadata.description}`);
  Logger.info(`${chalk.gray('路径:')} ${skillDir}`);

  if (!force) {
    const { confirmed } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmed',
        message: `\n确定要移除这个 skill 吗？`,
        default: false,
      },
    ]);

    if (!confirmed) {
      Logger.info('已取消移除');
      return;
    }
  }

  try {
    Logger.info(`\n正在移除: ${chalk.gray(skillDir)}`);
    await withBotSkillWorkspaceLock(skillsRoot, async () => {
      assertCliBotSkillOwnerUnchanged(expectedRuntime, skillsRoot);
      const latestManager = new SkillManager();
      await latestManager.loadSkills();
      const latestSkill = latestManager.getSkill(name);
      if (!latestSkill) {
        const error: any = new Error(`Skill no longer exists: ${name}`);
        error.code = 'SKILL_CHANGED_DURING_CONFIRMATION';
        throw error;
      }
      fs.rmSync(path.dirname(latestSkill.filePath), { recursive: true, force: true });
    });
    await notifyAndSyncBotSkills(skillsRoot);
    Logger.success(`\n✓ Skill ${styles.highlight(name)} 已成功移除！`);
    Logger.info(`已删除目录: ${skillDir}`);
  } catch (error: any) {
    Logger.error(`移除失败: ${error.message}`);
    process.exit(1);
  }
}

async function notifyAndSyncBotSkills(skillsRoot: string): Promise<void> {
  notifyBotSkillMutation(skillsRoot);
  if (!isBotSkillRuntimeEnabled()) return;
  try {
    const runtimeRoot = PathResolver.getRuntimeDataRoot();
    const auth = createCatsCoLocalConfigService({ runtimeRoot }).getAuthState();
    if (!auth.botUid || !auth.apiKey) return;
    const runtime = new BotSkillRuntime({
      runtimeRoot,
      skillsRoot,
      auth,
      transport: resolveBotSkillRuntimeTransport(),
    });
    const outcome = await runtime.sync({ allowLegacyClaim: true });
    if (outcome.result.action === 'blocked' || outcome.result.action === 'conflict') {
      Logger.warning(`Bot Skill cloud sync is pending: ${outcome.result.reason || outcome.result.action}`);
    }
  } catch (error: any) {
    Logger.warning(`Bot Skill cloud sync is pending: ${error?.code || error?.message || String(error)}`);
  }
}

async function repairBotSkillSync(strategyValue: string, force?: boolean): Promise<void> {
  const strategy = String(strategyValue || '').trim().toLowerCase();
  if (strategy !== 'local-wins' && strategy !== 'cloud-wins') {
    Logger.error('Strategy must be local-wins or cloud-wins.');
    process.exitCode = 1;
    return;
  }
  if (!isBotSkillRuntimeEnabled()) {
    Logger.error('Bot Skill sync is not enabled.');
    process.exitCode = 1;
    return;
  }
  const runtime = currentCliBotSkillRuntime(PathResolver.getSkillsPath());
  if (!runtime) {
    Logger.error('A bound CatsCo Bot is required to repair Bot Skill sync.');
    process.exitCode = 1;
    return;
  }
  if (!force) {
    const direction = strategy === 'local-wins'
      ? 'replace the Cloud Skill references with the current local workspace'
      : 'replace the current local workspace with the Cloud Skill references';
    const { confirmed } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirmed',
      message: `This will ${direction}. Continue?`,
      default: false,
    }]);
    if (!confirmed) {
      Logger.info('Bot Skill sync repair was cancelled.');
      return;
    }
  }
  const outcome = await runtime.repair(strategy);
  if (outcome.result.action !== 'uploaded' && outcome.result.action !== 'downloaded') {
    const blocked = outcome.result.blockedSkills?.map(skill => skill.name).join(', ');
    Logger.error(
      `Bot Skill sync repair did not complete: ${outcome.result.reason || outcome.result.action}`
      + (blocked ? ` (${blocked})` : ''),
    );
    if (outcome.result.reason === 'SYNC_REPAIR_PENDING_COMMIT_EXISTS') {
      Logger.info('Run a normal Bot Skill sync first so its pending commit can be recovered.');
    }
    process.exitCode = 1;
    return;
  }
  Logger.success(
    strategy === 'local-wins'
      ? 'Bot Skill sync Base repaired from the local workspace.'
      : 'Bot Skill sync Base repaired from Cloud.',
  );
}

function currentCliBotSkillRuntime(skillsRoot: string): BotSkillRuntime | undefined {
  if (!isBotSkillRuntimeEnabled()) return undefined;
  const runtimeRoot = PathResolver.getRuntimeDataRoot();
  const auth = createCatsCoLocalConfigService({ runtimeRoot }).getAuthState();
  if (!auth.botUid || !auth.apiKey) return undefined;
  return new BotSkillRuntime({
    runtimeRoot,
    skillsRoot,
    auth,
    transport: resolveBotSkillRuntimeTransport(),
  });
}

function assertCliBotSkillOwnerUnchanged(
  expected: BotSkillRuntime | undefined,
  skillsRoot: string,
): void {
  if (!expected) return;
  const current = currentCliBotSkillRuntime(skillsRoot);
  if (
    !current
    || current.owner.botId !== expected.owner.botId
    || current.owner.authority !== expected.owner.authority
    || current.workspace.inspect(current.owner).kind !== 'valid'
  ) {
    const error: any = new Error('The active Bot changed while waiting to modify its Skill workspace.');
    error.code = 'BOT_SKILL_ACTIVE_OWNER_CHANGED';
    throw error;
  }
}
