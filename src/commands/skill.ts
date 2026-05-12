import { Command } from 'commander';
import { Logger } from '../utils/logger';
import { styles } from '../theme/colors';
import { SkillManager } from '../skills/skill-manager';
import { PathResolver } from '../utils/path-resolver';
import { execFileSync, execSync } from 'child_process';
import chalk from 'chalk';
import * as path from 'path';
import * as fs from 'fs';
import inquirer from 'inquirer';
import { SkillParser } from '../skills/skill-parser';
import { validateInstalledSkillPackage } from '../skills/skill-package';

const BUNDLED_SKILL_MARKER = '.xiaoba-bundled-skill.json';
const SYSTEM_SKILL_DIRS = new Set(['_tool-skills']);
const WINDOWS_RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

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
    .description('从 GitHub 仓库安装 skill (支持 owner/repo 或 GitHub URL)')
    .option('-n, --name <name>', '自定义安装目录名')
    .action(async (repo: string, options: { name?: string }) => {
      await installGithubSkill(repo, options.name);
    });

  skillCmd
    .command('install-local <dir>')
    .description('从本地目录安装外部 skill 包')
    .option('-n, --name <name>', '自定义安装目录名')
    .action(async (dir: string, options: { name?: string }) => {
      await installLocalSkill(dir, options.name);
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
    if (skill.metadata.autoInvocable) invocable.push('自动调用');

    Logger.info(`${styles.highlight('●')} ${styles.highlight(skill.metadata.name)}`);
    Logger.info(`  ${chalk.gray('描述:')} ${skill.metadata.description}`);
    if (skill.metadata.argumentHint) {
      Logger.info(`  ${chalk.gray('参数:')} ${skill.metadata.argumentHint}`);
    }
    Logger.info(`  ${chalk.gray('调用:')} ${invocable.join(', ')}`);
    logPackageSummary(skill.packageInfo, '  ');
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
  Logger.info(`${chalk.gray('自动可调用:')} ${skill.metadata.autoInvocable ? '是' : '否'}`);
  Logger.info(`${chalk.gray('文件路径:')} ${skill.filePath}`);
  logPackageSummary(skill.packageInfo);

  Logger.info(`\n${chalk.gray('提示词内容:')}`);
  Logger.info(chalk.gray('─'.repeat(50)));
  Logger.info(skill.content);
  Logger.info(chalk.gray('─'.repeat(50)));
}

/**
 * 从 GitHub 安装 skill
 */
async function installGithubSkill(repo: string, requestedName?: string): Promise<void> {
  Logger.title(`从 GitHub 安装 Skill: ${repo}`);

  const resolved = resolveGithubRepo(repo);
  const githubUrl = resolved.cloneUrl;
  const installName = sanitizeInstallName(requestedName || resolved.repoName);

  const targetDir = PathResolver.getSkillsPath();
  PathResolver.ensureDir(targetDir);

  const skillPath = path.join(targetDir, installName);

  // 检查目录是否已存在
  if (fs.existsSync(skillPath)) {
    Logger.warning(`Skill 目录已存在: ${skillPath}`);
    Logger.info('如需重新安装，请先删除该目录');
    process.exit(1);
  }

  try {
    Logger.info(`\n克隆仓库: ${chalk.gray(githubUrl)}`);
    Logger.info(`目标目录: ${chalk.gray(skillPath)} (项目 skills 目录)\n`);

    execFileSync('git', ['clone', githubUrl, skillPath], {
      stdio: 'inherit',
      cwd: targetDir,
    });

    reportInstalledPackage(skillPath);
    Logger.success(`\n✓ Skill ${styles.highlight(installName)} 安装成功！`);
    Logger.info(`安装位置: ${skillPath}`);
    Logger.info('\n使用 catsco skill list 查看已安装的 skills');
  } catch (error: any) {
    Logger.error(`安装失败: ${error.message}`);

    // 清理失败的安装
    if (fs.existsSync(skillPath)) {
      try {
        fs.rmSync(skillPath, { recursive: true, force: true });
      } catch (cleanupError) {
        // 忽略清理错误
      }
    }

    process.exit(1);
  }
}

async function installLocalSkill(sourceDir: string, requestedName?: string): Promise<void> {
  const resolvedSource = path.resolve(sourceDir);
  Logger.title(`从本地目录安装 Skill: ${resolvedSource}`);
  if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isDirectory()) {
    Logger.error(`目录不存在: ${resolvedSource}`);
    process.exit(1);
  }
  if (!fs.existsSync(path.join(resolvedSource, 'SKILL.md'))) {
    Logger.error(`目录缺少 SKILL.md: ${resolvedSource}`);
    process.exit(1);
  }

  let parsedName = path.basename(resolvedSource);
  try {
    parsedName = SkillParser.parse(path.join(resolvedSource, 'SKILL.md')).metadata.name || parsedName;
  } catch {
    // 复制前仍会在 validateInstalledSkillPackage 阶段报出明确错误。
  }

  const installName = sanitizeInstallName(requestedName || parsedName);
  const targetDir = PathResolver.getSkillsPath();
  PathResolver.ensureDir(targetDir);
  const skillPath = path.join(targetDir, installName);

  if (fs.existsSync(skillPath)) {
    Logger.warning(`Skill 目录已存在: ${skillPath}`);
    Logger.info('如需重新安装，请先删除该目录');
    process.exit(1);
  }

  try {
    fs.cpSync(resolvedSource, skillPath, {
      recursive: true,
      filter: copiedPath => !shouldSkipLocalInstallPath(copiedPath, resolvedSource),
    });
    reportInstalledPackage(skillPath);
    Logger.success(`\n✓ Skill ${styles.highlight(installName)} 安装成功！`);
    Logger.info(`安装位置: ${skillPath}`);
  } catch (error: any) {
    Logger.error(`安装失败: ${error.message}`);
    if (fs.existsSync(skillPath)) {
      try {
        fs.rmSync(skillPath, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
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
  const manager = new SkillManager();
  await manager.loadSkills();
  const skill = manager.getSkill(name);

  if (!skill) {
    Logger.error(`未找到 skill: ${name}`);
    Logger.info('\n使用 catsco skill list 查看所有可用的 skills');
    process.exit(1);
  }

  const skillDir = path.dirname(skill.filePath);
  const management = getCliSkillManagementInfo(skill.filePath);

  Logger.info(`\n${chalk.gray('名称:')} ${styles.highlight(skill.metadata.name)}`);
  Logger.info(`${chalk.gray('描述:')} ${skill.metadata.description}`);
  Logger.info(`${chalk.gray('路径:')} ${skillDir}`);
  if (!management.canDelete) {
    Logger.error(formatCliSkillDeleteBlockedMessage(management.source));
    process.exit(1);
  }

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
    fs.rmSync(skillDir, { recursive: true, force: true });
    Logger.success(`\n✓ Skill ${styles.highlight(name)} 已成功移除！`);
    Logger.info(`已删除目录: ${skillDir}`);
  } catch (error: any) {
    Logger.error(`移除失败: ${error.message}`);
    process.exit(1);
  }
}

function resolveGithubRepo(input: string): { cloneUrl: string; repoName: string } {
  const trimmed = input.trim();
  const shorthand = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shorthand) {
    return {
      cloneUrl: `https://github.com/${shorthand[1]}/${stripGitSuffix(shorthand[2])}.git`,
      repoName: stripGitSuffix(shorthand[2]),
    };
  }

  const https = trimmed.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\.git)?(?:[/?#].*)?$/i);
  if (https) {
    return {
      cloneUrl: `https://github.com/${https[1]}/${stripGitSuffix(https[2])}.git`,
      repoName: stripGitSuffix(https[2]),
    };
  }

  const ssh = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (ssh) {
    return {
      cloneUrl: `git@github.com:${ssh[1]}/${stripGitSuffix(ssh[2])}.git`,
      repoName: stripGitSuffix(ssh[2]),
    };
  }

  Logger.error('仓库地址格式错误，应为 owner/repo、GitHub HTTPS URL 或 GitHub SSH URL');
  Logger.info('例如: owner/example-skill-package');
  process.exit(1);
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, '');
}

function sanitizeInstallName(value: string): string {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!cleaned) {
    Logger.error('Skill 安装目录名不能为空');
    process.exit(1);
  }
  if (cleaned === '.' || cleaned === '..' || cleaned.includes('..')) {
    Logger.error(`非法 skill 安装目录名: ${value}`);
    process.exit(1);
  }
  if (WINDOWS_RESERVED_NAMES.has(cleaned)) {
    Logger.error(`非法 skill 安装目录名: ${value}`);
    process.exit(1);
  }
  return cleaned;
}

function shouldSkipLocalInstallPath(copiedPath: string, sourceRoot: string): boolean {
  const relative = path.relative(sourceRoot, copiedPath);
  if (!relative) return false;
  const parts = relative.split(path.sep).map(part => part.toLowerCase());
  const basename = path.basename(copiedPath).toLowerCase();
  return parts.some(part => part === '.git' || part === '__pycache__' || part === 'output' || part === 'node_modules')
    || basename === '.env'
    || basename.startsWith('.env.')
    || basename.endsWith('.pyc');
}

function reportInstalledPackage(skillPath: string): void {
  const validation = validateInstalledSkillPackage(skillPath);
  const skill = SkillParser.parse(validation.skillFile);
  Logger.info(`\n${chalk.gray('Skill:')} ${styles.highlight(skill.metadata.name)}`);
  Logger.info(`${chalk.gray('描述:')} ${skill.metadata.description}`);
  logPackageSummary(validation.packageInfo);
  if (!validation.ok) {
    throw new Error(validation.packageInfo.readiness.reasons.join('; ') || 'skill package is invalid');
  }
}

function logPackageSummary(packageInfo: import('../types/skill').SkillPackageInfo | undefined, indent = ''): void {
  if (!packageInfo) return;
  if (!packageInfo.hasManifest) {
    Logger.info(`${indent}${chalk.gray('包状态:')} prompt-only`);
    return;
  }

  const readiness = packageInfo.readiness.status;
  const label = readiness === 'ready'
    ? chalk.green('ready')
    : readiness === 'not_configured'
      ? chalk.yellow('not_configured')
      : chalk.red('invalid');
  const manifest = packageInfo.manifest;
  Logger.info(`${indent}${chalk.gray('包状态:')} ${label}`);
  if (manifest) {
    Logger.info(`${indent}${chalk.gray('Manifest:')} ${manifest.schemaVersion || 'unknown'}${manifest.packageVersion ? ` (${manifest.packageVersion})` : ''}`);
    Logger.info(`${indent}${chalk.gray('工具声明:')} ${manifest.toolCount}${manifest.providerSafeToolNames.length ? ` [${manifest.providerSafeToolNames.join(', ')}]` : ''}`);
  }
  if (packageInfo.readiness.missingEnv.length > 0) {
    Logger.info(`${indent}${chalk.gray('缺少环境变量:')} ${packageInfo.readiness.missingEnv.join(', ')}`);
  }
  if (packageInfo.readiness.reasons.length > 0) {
    Logger.info(`${indent}${chalk.gray('状态说明:')} ${packageInfo.readiness.reasons.join('; ')}`);
  }
  if (!packageInfo.hasReadme || !packageInfo.hasLicense) {
    const missing = [
      !packageInfo.hasReadme ? 'README' : '',
      !packageInfo.hasLicense ? 'LICENSE' : '',
    ].filter(Boolean);
    Logger.info(`${indent}${chalk.gray('包提示:')} 缺少 ${missing.join(', ')}`);
  }
}

type CliSkillSource = 'system' | 'bundled' | 'user';

function getCliSkillManagementInfo(skillFilePath: string): { source: CliSkillSource; canDelete: boolean } {
  const dir = path.dirname(skillFilePath);
  const skillsRoot = PathResolver.getSkillsPath();
  const relative = path.relative(skillsRoot, dir);
  const parts = relative.split(path.sep).filter(Boolean);
  const source: CliSkillSource = parts.some(part => SYSTEM_SKILL_DIRS.has(part))
    ? 'system'
    : fs.existsSync(path.join(dir, BUNDLED_SKILL_MARKER))
      ? 'bundled'
      : 'user';
  return {
    source,
    canDelete: source === 'user',
  };
}

function formatCliSkillDeleteBlockedMessage(source: CliSkillSource): string {
  if (source === 'system') return '系统 Skill 不能删除。';
  if (source === 'bundled') return '内置 Skill 不能删除，可在界面中禁用。';
  return '该 Skill 当前不能删除。';
}
