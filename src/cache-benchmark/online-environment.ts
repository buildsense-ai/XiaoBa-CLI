import * as fs from 'node:fs';
import * as path from 'node:path';

const SEALED_ENV_FILE = '.cache-benchmark.env';
const SEALED_PROFILE_FILE = '.cache-benchmark-runtime-profile.json';
const SEALED_CONFIG_FILE = '.cache-benchmark-config.json';

const SEALED_ENV_CONTENT = '# sealed cache benchmark environment\n';
const SEALED_PROFILE_CONTENT = '{"schemaVersion":1,"profile":{}}\n';
const SEALED_CONFIG_CONTENT = '{}\n';

const EXTERNAL_OVERRIDE_KEYS = [
  'CATSCO_BOT_UID',
  'CATSCOMPANY_BOT_UID',
  'BOT_BRIDGE_NAME',
  'CATSCO_MODEL_RETRY_MAX_MS',
  'CATSCO_MODEL_RETRY_MAX_RETRIES',
  'CATSCO_LOG_API_BASE_URL',
  'CATSCO_LOG_UPLOAD_ENABLED',
  'CATSCO_LOG_UPLOAD_INTERVAL_MINUTES',
  'CATSCO_PROMPTS_DIR',
  'CATSCO_PROMPT_OVERRIDES_DIR',
  'CATSCO_USER_DATA_DIR',
  'CURRENT_AGENT_DISPLAY_NAME',
  'CURRENT_PLATFORM',
  'DOTENV_CONFIG_PATH',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_BOT_ALIASES',
  'FEISHU_BOT_OPEN_ID',
  'GAUZ_LLM_API_BASE',
  'GAUZ_LLM_API_KEY',
  'GAUZ_LLM_CONTEXT_TOKENS',
  'GAUZ_LLM_CONTEXT_WINDOW_TOKENS',
  'GAUZ_LLM_MAX_OUTPUT_TOKENS',
  'GAUZ_LLM_MAX_TOKENS',
  'GAUZ_LLM_MODEL',
  'GAUZ_LLM_OPENAI_API_MODE',
  'GAUZ_LLM_PROVIDER',
  'GAUZ_LLM_REASONING_EFFORT',
  'GAUZ_STREAM_RETRY',
  'GAUZ_TOOL_ALLOW',
  'GAUZ_BASH_ALLOW_DANGEROUS',
  'GAUZ_FS_ALLOW_DOTENV',
  'GAUZ_FS_ALLOW_OUTSIDE',
  'GAUZ_FS_ALLOW_OUTSIDE_READ',
  'CATSCO_MODEL_SOURCE',
  'XIAOBA_APP_ROOT',
  'XIAOBA_BRANCH_AGENTS_ENABLED',
  'XIAOBA_CHECKPOINT_COMPACTION_ENABLED',
  'XIAOBA_CONFIG_PATH',
  'XIAOBA_DISABLE_PROMPT_OVERRIDES',
  'XIAOBA_ELECTRON_USER_DATA_DIR',
  'XIAOBA_IS_PACKAGED',
  'XIAOBA_MEMORY_SIDECAR_ENABLED',
  'XIAOBA_PROFILE',
  'XIAOBA_PROFILE_PATH',
  'XIAOBA_PROMPTS_DIR',
  'XIAOBA_PROMPT_OVERRIDES_DIR',
  'XIAOBA_RUNTIME_PROFILE_PATH',
  'XIAOBA_RUNTIME_ROOT',
  'XIAOBA_RUNTIME_SURFACE',
  'XIAOBA_SESSION_RUNTIME_FEEDBACK_LIMIT',
  'XIAOBA_SESSION_TOOL_RESULT_LIMIT',
  'XIAOBA_SKILLS_DIR',
  'XIAOBA_TARGET_ALIAS_SECRET',
  'XIAOBA_TEST_RUNNER',
  'XIAOBA_TEST_SANDBOX_ROOT',
  'XIAOBA_TEST_DEFAULT_DATA_DIR',
  'XIAOBA_ALLOW_NON_TEMP_TEST_RUNTIME_ROOT',
  'XIAOBA_USER_DATA_DIR',
] as const;

const FORBIDDEN_NODE_ENV_KEYS = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'NODE_ICU_DATA',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_COMPILE_CACHE',
  'OPENSSL_CONF',
  'OPENSSL_MODULES',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_FRAMEWORK_PATH',
  'DYLD_ROOT_PATH',
] as const;

const INHERITED_CHILD_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'USERNAME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'WINDIR',
  'PATHEXT',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const;

const MUST_REMAIN_UNSET_KEYS = [
  ...EXTERNAL_OVERRIDE_KEYS,
  'XIAOBA_DEBUG_PROVIDER_MESSAGES',
  'CONTEXT_DEBUG',
] as const;

export interface OnlineBenchmarkEnvironmentPaths {
  artifactRootDirectory: string;
  promptsDirectory: string;
  runtimeDataDirectory: string;
  skillsDirectory: string;
  dotenvPath: string;
  runtimeProfilePath: string;
  configPath: string;
}

/** Rejects startup hooks and module search paths before benchmark evidence exists. */
export function assertCleanOnlineBenchmarkInvocation(
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv,
): void {
  if (execArgv.length > 0 || hasForbiddenLoaderEnvironment(env)) {
    throw new Error('benchmark_node_invocation_forbidden');
  }
  if (EXTERNAL_OVERRIDE_KEYS.some(key => nonEmpty(env[key]))) {
    throw new Error('benchmark_environment_override_forbidden');
  }
}

/** Creates deterministic local control files and fixes every runtime input before dynamic import. */
export function sealOnlineBenchmarkEnvironment(
  artifactRootDirectory: string,
  runtimeDataDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv,
): OnlineBenchmarkEnvironmentPaths {
  assertCleanOnlineBenchmarkInvocation(env, execArgv);
  const paths = resolveEnvironmentPaths(artifactRootDirectory, runtimeDataDirectory);
  assertPromptsDirectory(paths.artifactRootDirectory, paths.promptsDirectory);
  writeSealedFile(paths.dotenvPath, SEALED_ENV_CONTENT);
  writeSealedFile(paths.runtimeProfilePath, SEALED_PROFILE_CONTENT);
  writeSealedFile(paths.configPath, SEALED_CONFIG_CONTENT);
  for (const key of MUST_REMAIN_UNSET_KEYS) delete env[key];
  Object.assign(env, expectedEnvironment(paths));
  assertSealedOnlineBenchmarkEnvironment(paths, env, execArgv);
  return paths;
}

/** Revalidates the sealed environment and its immutable control inputs. */
export function assertSealedOnlineBenchmarkEnvironment(
  paths: OnlineBenchmarkEnvironmentPaths,
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv,
): void {
  if (execArgv.length > 0 || hasForbiddenLoaderEnvironment(env)) {
    throw new Error('benchmark_node_invocation_forbidden');
  }
  const expected = expectedEnvironment(paths);
  if (Object.entries(expected).some(([key, value]) => env[key] !== value)) {
    throw new Error('benchmark_environment_invalid');
  }
  if (MUST_REMAIN_UNSET_KEYS.some(key => expected[key] === undefined && env[key] !== undefined)) {
    throw new Error('benchmark_environment_invalid');
  }
  if (hasUnexpectedApplicationEnvironment(env, expected)) {
    throw new Error('benchmark_environment_invalid');
  }
  assertPromptsDirectory(paths.artifactRootDirectory, paths.promptsDirectory);
  assertSealedFile(paths.dotenvPath, SEALED_ENV_CONTENT);
  assertSealedFile(paths.runtimeProfilePath, SEALED_PROFILE_CONTENT);
  assertSealedFile(paths.configPath, SEALED_CONFIG_CONTENT);
}

export function resolveOnlineBenchmarkEnvironmentPaths(
  artifactRootDirectory: string,
  runtimeDataDirectory: string,
): OnlineBenchmarkEnvironmentPaths {
  return resolveEnvironmentPaths(artifactRootDirectory, runtimeDataDirectory);
}

export function onlineBenchmarkExternalOverrideKeys(): readonly string[] {
  return EXTERNAL_OVERRIDE_KEYS;
}

export function onlineBenchmarkForbiddenNodeEnvKeys(): readonly string[] {
  return FORBIDDEN_NODE_ENV_KEYS;
}

export function onlineBenchmarkInheritedChildEnvKeys(): readonly string[] {
  return INHERITED_CHILD_ENV_KEYS;
}

function resolveEnvironmentPaths(
  artifactRootDirectory: string,
  runtimeDataDirectory: string,
): OnlineBenchmarkEnvironmentPaths {
  const artifactRoot = path.resolve(artifactRootDirectory);
  const runtime = path.resolve(runtimeDataDirectory);
  return {
    artifactRootDirectory: artifactRoot,
    promptsDirectory: path.join(artifactRoot, 'prompts'),
    runtimeDataDirectory: runtime,
    skillsDirectory: path.join(runtime, 'skills'),
    dotenvPath: path.join(runtime, SEALED_ENV_FILE),
    runtimeProfilePath: path.join(runtime, SEALED_PROFILE_FILE),
    configPath: path.join(runtime, SEALED_CONFIG_FILE),
  };
}

function expectedEnvironment(paths: OnlineBenchmarkEnvironmentPaths): Record<string, string> {
  return {
    XIAOBA_USER_DATA_DIR: paths.runtimeDataDirectory,
    XIAOBA_SKILLS_DIR: paths.skillsDirectory,
    XIAOBA_PROMPTS_DIR: paths.promptsDirectory,
    CATSCO_PROMPTS_DIR: paths.promptsDirectory,
    XIAOBA_APP_ROOT: paths.artifactRootDirectory,
    XIAOBA_IS_PACKAGED: '0',
    XIAOBA_DISABLE_PROMPT_OVERRIDES: '1',
    DOTENV_CONFIG_PATH: paths.dotenvPath,
    XIAOBA_RUNTIME_PROFILE_PATH: paths.runtimeProfilePath,
    XIAOBA_PROFILE_PATH: paths.runtimeProfilePath,
    XIAOBA_CONFIG_PATH: paths.configPath,
    XIAOBA_PROFILE: 'default',
    XIAOBA_RUNTIME_SURFACE: 'catscompany',
    CURRENT_PLATFORM: 'CatsCo',
    CURRENT_AGENT_DISPLAY_NAME: 'Cache Benchmark Agent',
    CATSCO_MODEL_RETRY_MAX_RETRIES: '0',
    CATSCO_MODEL_RETRY_MAX_MS: '0',
    CATSCO_LOG_UPLOAD_ENABLED: 'false',
    GAUZ_STREAM_RETRY: 'false',
    XIAOBA_SESSION_RUNTIME_FEEDBACK_LIMIT: '4000',
    XIAOBA_TARGET_ALIAS_SECRET: 'c9b50dd1c6f419f2eb24cb62eca920510d97ef8c0c2b628fdf0b7634a9b755dc',
    XIAOBA_CHECKPOINT_COMPACTION_ENABLED: 'true',
    CATSCO_MODEL_SOURCE: 'custom',
    NODE_ENV: 'production',
    TZ: 'UTC',
    LANG: 'C',
    LC_ALL: 'C',
    SHELL: '/bin/sh',
    ComSpec: 'powershell.exe',
    COMSPEC: 'powershell.exe',
  };
}

function assertPromptsDirectory(artifactRoot: string, promptsDirectory: string): void {
  let rootReal: string;
  let promptsReal: string;
  try {
    const rootStat = fs.lstatSync(artifactRoot);
    const promptsStat = fs.lstatSync(promptsDirectory);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()
      || promptsStat.isSymbolicLink() || !promptsStat.isDirectory()) {
      throw new Error('benchmark_environment_invalid');
    }
    rootReal = fs.realpathSync(artifactRoot);
    promptsReal = fs.realpathSync(promptsDirectory);
  } catch (error) {
    if (error instanceof Error && error.message === 'benchmark_environment_invalid') throw error;
    throw new Error('benchmark_environment_invalid');
  }
  if (promptsReal !== path.join(rootReal, 'prompts')) {
    throw new Error('benchmark_environment_invalid');
  }
}

function writeSealedFile(filePath: string, content: string): void {
  try {
    fs.writeFileSync(filePath, content, { encoding: 'utf8', flag: 'wx', mode: 0o400 });
    if (process.platform !== 'win32') fs.chmodSync(filePath, 0o400);
  } catch {
    throw new Error('benchmark_environment_invalid');
  }
}

function assertSealedFile(filePath: string, expectedContent: string): void {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  try {
    const pathBefore = fs.lstatSync(filePath);
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
      throw new Error('benchmark_environment_invalid');
    }
    if (process.platform !== 'win32' && (pathBefore.mode & 0o777) !== 0o400) {
      throw new Error('benchmark_environment_invalid');
    }
    if (typeof process.getuid === 'function' && pathBefore.uid !== process.getuid()) {
      throw new Error('benchmark_environment_invalid');
    }
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(descriptor);
    const content = fs.readFileSync(descriptor, 'utf8');
    const after = fs.fstatSync(descriptor);
    const pathAfter = fs.lstatSync(filePath);
    if (
      content !== expectedContent
      || !before.isFile()
      || !sameStableFile(pathBefore, before)
      || !sameStableFile(before, after)
      || !sameStableFile(pathBefore, pathAfter)
    ) throw new Error('benchmark_environment_invalid');
  } catch (error) {
    if (error instanceof Error && error.message === 'benchmark_environment_invalid') throw error;
    throw new Error('benchmark_environment_invalid');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sameStableFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.mode === right.mode;
}

function nonEmpty(value: string | undefined): boolean {
  return Boolean(String(value || '').trim());
}

function hasForbiddenLoaderEnvironment(env: NodeJS.ProcessEnv): boolean {
  return Object.entries(env).some(([key, value]) => {
    if (!nonEmpty(value)) return false;
    if (key.startsWith('NODE_')) return key !== 'NODE_ENV';
    return key.startsWith('LD_')
      || key.startsWith('DYLD_')
      || key.startsWith('OPENSSL_')
      || key.startsWith('SSL_');
  });
}

function hasUnexpectedApplicationEnvironment(
  env: NodeJS.ProcessEnv,
  expected: Record<string, string>,
): boolean {
  return Object.keys(env).some(key => (
    /^(?:XIAOBA|CATSCO|CATSCOMPANY|GAUZ|FEISHU|READER)_/u.test(key)
    && expected[key] === undefined
  ));
}
